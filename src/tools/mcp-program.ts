import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { PROGRAM_IDS } from "../config.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import bs58 from "bs58";
import { BorshReader, decodeAccountData } from "../utils/borsh-reader.js";

// ToolState on-chain layout (Rust borsh, runtime/src/programs/mcp.rs):
//   discriminator [8], owner Pubkey, target_program Pubkey,
//   name: String, description: String, input_schema_uri: String, output_schema_uri: String,
//   tags: Vec<String>, access_control: u8, allowlist: Vec<Pubkey>,
//   is_active: bool (u8), invocation_count: u64,
//   instruction_discriminator: Option<Vec<u8>>
function parseToolState(rawData: any): {
  owner: string;
  targetProgram: string;
  name: string;
  description: string;
  inputSchemaUri: string;
  outputSchemaUri: string;
  tags: string[];
  accessControl: number;
  allowlistCount: number;
  isActive: boolean;
  invocationCount: bigint;
} | null {
  const buf = decodeAccountData(rawData);
  if (!buf || buf.length < 8 + 64) return null;
  try {
    const r = new BorshReader(buf);
    r.skip(8);
    const owner = r.readPubkey();
    const targetProgram = r.readPubkey();
    const name = r.readString();
    const description = r.readString();
    const inputSchemaUri = r.readString();
    const outputSchemaUri = r.readString();
    const tagCount = r.readU32();
    const tags: string[] = [];
    for (let i = 0; i < tagCount; i++) tags.push(r.readString());
    const accessControl = r.readU8();
    const allowlistCount = r.readU32();
    r.skip(allowlistCount * 32);
    const isActive = r.readBool();
    const invocationCount = r.readU64();
    return { owner, targetProgram, name, description, inputSchemaUri, outputSchemaUri, tags, accessControl, allowlistCount, isActive, invocationCount };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal tx builder helpers for MCP program instructions
// ---------------------------------------------------------------------------

function writeU8(buf: number[], v: number): void { buf.push(v & 0xff); }
function writeU32LE(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function writeBytes(buf: number[], bytes: Uint8Array): void {
  for (const b of bytes) buf.push(b);
}
function writeVec(buf: number[], bytes: Uint8Array): void {
  writeU32LE(buf, bytes.length);
  writeBytes(buf, bytes);
}
function writeStr(buf: number[], s: string): void {
  writeVec(buf, new TextEncoder().encode(s));
}
function writeU64LE(buf: number[], v: bigint): void {
  const lo = Number(v & 0xffffffffn);
  const hi = Number((v >> 32n) & 0xffffffffn);
  writeU32LE(buf, lo);
  writeU32LE(buf, hi);
}

function pubkeyBytes(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length > 32) throw new Error(`Invalid pubkey: ${b58}`);
  if (decoded.length < 32) { const p = new Uint8Array(32); p.set(decoded, 32 - decoded.length); return p; }
  return decoded;
}

function blockhashBytesOf(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length === 32) return decoded;
  const p = new Uint8Array(32); p.set(decoded, 32 - decoded.length); return p;
  return decoded;
}

// Derive a deterministic tool account address from service name + owner
function deriveToolAddress(serviceName: string, owner: string): string {
  const seed = new TextEncoder().encode(`mcp:${serviceName}:${owner}`);
  const programKey = PROGRAM_IDS.mcp;
  const combined = new Uint8Array(seed.length + 32);
  combined.set(seed);
  combined.set(programKey, seed.length);
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    hash[i] = combined[i % combined.length] ^ combined[(i + 11) % combined.length];
  }
  return bs58.encode(hash);
}

function buildMcpTx(
  payer: string,
  toolAccount: string,
  instructionData: Uint8Array,
  recentBlockhash: string,
): Uint8Array {
  const payerKey = pubkeyBytes(payer);
  const toolKey = pubkeyBytes(toolAccount);
  const programKey = PROGRAM_IDS.mcp;
  const blockhash = blockhashBytesOf(recentBlockhash);

  const accountKeys = [payerKey, toolKey, programKey];
  const zeroSig = new Uint8Array(64);

  const msgBuf: number[] = [];
  writeU8(msgBuf, 1); // numRequiredSignatures
  writeU8(msgBuf, 0); // numReadonlySigned
  writeU8(msgBuf, 1); // numReadonlyUnsigned (program)
  writeU32LE(msgBuf, accountKeys.length);
  for (const k of accountKeys) writeBytes(msgBuf, k);
  writeBytes(msgBuf, blockhash);
  writeU32LE(msgBuf, 1);
  writeU8(msgBuf, 2); // programIdIndex
  writeVec(msgBuf, new Uint8Array([0, 1, 2])); // payer, tool PDA, target_program (MCP program for now)
  writeVec(msgBuf, instructionData);

  const msgBytes = new Uint8Array(msgBuf);

  const txBuf: number[] = [];
  writeU32LE(txBuf, 1);
  writeBytes(txBuf, zeroSig);
  writeBytes(txBuf, msgBytes);

  return new Uint8Array(txBuf);
}

// AccessControl enum (matches Rust mcp.rs)
const ACCESS_CONTROL_MAP: Record<string, number> = {
  Public: 0,
  Allowlist: 1,
  OwnerOnly: 2,
  AgentOnly: 3,
};

// Legacy service-type names → tags (kept for back-compat with the older TS schema).
const LEGACY_SERVICE_TYPES = new Set([
  "oracle", "relayer", "compute", "storage", "bridge", "custom",
]);

export function registerMcpProgramTools(server: McpServer): void {
  server.tool(
    "register_mcp_service",
    "Registers a new MCP tool on the ETO network. The on-chain ToolState stores name, description, input_schema_uri, output_schema_uri, tags, access_control, and an allowlist. Returns the tool account address.",
    {
      name: z.string().describe("Unique name for the tool (e.g. 'price-oracle-eth-usd'). Aliased as 'service_name' for back-compat."),
      service_name: z.string().optional().describe("Deprecated alias for name"),
      description: z.string().optional().describe("Human-readable description"),
      endpoint: z.string().optional().describe("Deprecated — used as description if 'description' is omitted"),
      input_schema_uri: z.string().optional().describe("URI for the JSON Schema describing tool inputs"),
      output_schema_uri: z.string().optional().describe("URI for the JSON Schema describing tool outputs"),
      tags: z.array(z.string()).optional().describe("Tags for discovery"),
      service_type: z.enum(["oracle", "relayer", "compute", "storage", "bridge", "custom"]).optional()
        .describe("Deprecated — auto-added to tags if provided"),
      access_control: z.preprocess(
        (v) => {
          if (typeof v !== "string") return v;
          const map: Record<string, string> = { public: "Public", allowlist: "Allowlist", owneronly: "OwnerOnly", owner_only: "OwnerOnly", agentonly: "AgentOnly", agent_only: "AgentOnly" };
          return map[v.toLowerCase()] ?? v;
        },
        z.enum(["Public", "Allowlist", "OwnerOnly", "AgentOnly"]).default("Public").optional()
      ),
      allowlist: z.array(z.string()).optional().describe("Pubkeys (base58) allowed to invoke this tool when access=Allowlist"),
      metadata: z.any().optional().describe("Deprecated — JSON-serialized into output_schema_uri if URIs are not set"),
    },
    async (args) => {
      try {
        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        // Resolve canonical fields, accepting legacy aliases.
        const toolName = args.name ?? args.service_name ?? "";
        if (!toolName) {
          return {
            content: [{ type: "text" as const, text: "Error: 'name' (or legacy 'service_name') is required." }],
            isError: true,
          };
        }
        const description = args.description ?? args.endpoint ?? "";
        const inputSchemaUri = args.input_schema_uri ?? "";
        const outputSchemaUri = args.output_schema_uri ?? (args.metadata ? JSON.stringify(args.metadata) : "");
        const tags: string[] = Array.from(new Set([
          ...(args.tags ?? []),
          ...(args.service_type && LEGACY_SERVICE_TYPES.has(args.service_type) ? [args.service_type] : []),
        ]));
        const accessByte = ACCESS_CONTROL_MAP[args.access_control ?? "Public"] ?? 0;
        const allowlist: string[] = args.allowlist ?? [];

        const toolAccount = deriveToolAddress(toolName, payerSvm);

        // Borsh: enum index (RegisterTool = 0), then fields in struct order
        const data: number[] = [];
        writeU8(data, 0);                     // enum discriminant
        writeStr(data, toolName);
        writeStr(data, description);
        writeStr(data, inputSchemaUri);
        writeStr(data, outputSchemaUri);
        writeU32LE(data, tags.length);
        for (const tag of tags) writeStr(data, tag);
        writeU8(data, accessByte);
        writeU32LE(data, allowlist.length);
        for (const a of allowlist) writeBytes(data, pubkeyBytes(a));
        writeU8(data, 0);                     // Option<Vec<u8>> = None

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildMcpTx(payerSvm, toolAccount, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `register-mcp-${toolName}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            "MCP tool registered successfully.",
            `Name:          ${toolName}`,
            `Tool Account:  ${toolAccount}`,
            `Description:   ${description || "(none)"}`,
            `Tags:          ${tags.length ? tags.join(", ") : "(none)"}`,
            `Access:        ${args.access_control ?? "Public"}`,
            `Owner:         ${payerSvm}`,
            `Signature:     ${result.signature}`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Registration submitted but timed out.\nTool Account: ${toolAccount}\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Registration failed: ${result.error?.explanation ?? "Unknown error"}` }],
            isError: true,
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "call_mcp_service",
    "Invokes a registered MCP service on the ETO network. The service is looked up by name, parameters are JSON-serialized and passed to the service endpoint, and the call fee is deducted from the caller's balance. An optional max_fee parameter acts as a spending cap — the call is rejected if the service fee exceeds this limit. Returns the service response as stored in the transaction result.",
    {
      service_name: z.string().describe("Name of the registered MCP service to call"),
      params: z.any().describe("Parameters to pass to the service (JSON-serializable)"),
      max_fee: z.string().optional().describe("Maximum fee in lamports the caller is willing to pay (safety cap)"),
    },
    async ({ service_name, params, max_fee }) => {
      try {
        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        const toolAccount = deriveToolAddress(service_name, payerSvm);

        // Pre-check: service must exist before we claim a successful call.
        // Without this, the on-chain program can return ok on a no-op tx and
        // callers think the service ran when it never existed.
        const existing = await rpc.getAccountInfo(toolAccount);
        const exists = existing && (existing.value !== null && existing.value !== undefined || existing.lamports !== undefined);
        if (!exists) {
          return {
            content: [{ type: "text" as const, text: `MCP service not found: '${service_name}'. No account at derived address ${toolAccount}. Register it first with register_mcp_service (owned by the active wallet — services are scoped per-owner).` }],
            isError: true,
          };
        }

        // Instruction: discriminator 1 = InvokeMcpTool
        const data: number[] = [];
        writeU8(data, 1);
        writeStr(data, service_name);
        const paramsStr = JSON.stringify(params ?? {});
        writeStr(data, paramsStr);
        writeU64LE(data, BigInt(max_fee ?? "0"));

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildMcpTx(payerSvm, toolAccount, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `call-mcp-${service_name}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            `MCP service '${service_name}' called successfully.`,
            `Caller:    ${payerSvm}`,
            `Params:    ${paramsStr}`,
            `Signature: ${result.signature}`,
            `Status:    ${result.status}`,
          ];
          if (max_fee) lines.push(`Max fee:   ${max_fee} lamports`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Call submitted but timed out.\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Service call failed: ${result.error?.explanation ?? "Unknown error"}` }],
            isError: true,
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_mcp_services",
    "Lists all MCP services (tools) registered on the ETO network. Queries the MCP program for all tool accounts and returns their names, types, endpoints, fees, and owner addresses. Filter by service_type to narrow results to a specific category such as 'oracle' or 'compute'. Results are ordered by registration time with most recent first.",
    {
      service_type: z.enum(["all", "oracle", "relayer", "compute", "storage", "bridge", "custom"])
        .default("all").optional()
        .describe("Filter by service type, or 'all' to list every registered service"),
    },
    async ({ service_type }) => {
      try {
        const mcpProgramId = bs58.encode(PROGRAM_IDS.mcp);

        let accounts: any[] = [];
        try {
          const filters = service_type && service_type !== "all"
            ? [{ memcmp: { offset: 1, bytes: bs58.encode(new Uint8Array([SERVICE_TYPE_MAP[service_type] ?? 5])) } }]
            : [];
          accounts = await rpc.getProgramAccounts(mcpProgramId);
        } catch {
          accounts = [];
        }

        if (!accounts || accounts.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No MCP services found (filter: ${service_type ?? "all"}).` }],
          };
        }

        const accessNames: Record<number, string> = { 0: "Public", 1: "Allowlist", 2: "OwnerOnly", 3: "AgentOnly" };
        const lines = [`MCP services (filter: ${service_type ?? "all"}) — ${accounts.length} found:\n`];

        for (const acct of accounts) {
          const addr = acct.pubkey ?? acct.address ?? "N/A";
          const rawData = acct.account?.data ?? acct.data;
          const parsed = parseToolState(rawData);
          lines.push(`  Account:    ${addr}`);
          if (parsed) {
            lines.push(`  Name:       ${parsed.name || "(unnamed)"}`);
            lines.push(`  Owner:      ${parsed.owner}`);
            lines.push(`  Active:     ${parsed.isActive}`);
            lines.push(`  Access:     ${accessNames[parsed.accessControl] ?? `access(${parsed.accessControl})`}`);
            lines.push(`  Invocations:${parsed.invocationCount}`);
          } else {
            lines.push(`  (data could not be decoded as ToolState)`);
          }
          lines.push("");
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_mcp_service",
    "Fetches detailed information about a specific registered MCP service by name. Returns the service's on-chain account address, type, endpoint URL, fee per call, owner, and any stored metadata. Use this before calling a service to verify it is still active and to inspect its current fee structure.",
    {
      service_name: z.string().describe("Name of the MCP service to look up"),
    },
    async ({ service_name }) => {
      try {
        const walletId = getActiveWalletId();
        const ownerHint = walletId
          ? (await getSignerFactory().getSigner(walletId)).getPublicKey()
          : null;

        // Try to derive the tool account address if we have an owner hint.
        // Retry briefly to ride out the chain's commit-vs-state-apply lag —
        // a tx confirms before its state writes are visible to getAccountInfo.
        let account: any = null;
        if (ownerHint) {
          const toolAccount = deriveToolAddress(service_name, ownerHint);
          for (let i = 0; i < 4 && !account; i++) {
            const info = await rpc.getAccountInfo(toolAccount);
            if (info && info.value !== null && info.value !== undefined) {
              account = { ...info.value, _address: toolAccount };
              break;
            }
            if (info && info.lamports !== undefined && info.value === undefined) {
              account = { ...info, _address: toolAccount };
              break;
            }
            if (i < 3) await new Promise((r) => setTimeout(r, 200));
          }
        }

        if (!account) {
          // Fallback: search all MCP accounts using the proper ToolState parser.
          // The previous offset-based name read used the wrong byte positions
          // (the actual layout has 8-byte discriminator + 32-byte owner +
          // 32-byte target_program before the name length).
          const mcpProgramId = bs58.encode(PROGRAM_IDS.mcp);
          try {
            const allAccounts = await rpc.getProgramAccounts(mcpProgramId);
            for (const acct of allAccounts ?? []) {
              const rawData = acct.account?.data ?? acct.data;
              const parsed = parseToolState(rawData);
              if (parsed && parsed.name === service_name) {
                account = { ...acct.account, _address: acct.pubkey ?? acct.address };
                break;
              }
            }
          } catch {
            // ignore
          }
        }

        if (!account) {
          return {
            content: [{ type: "text" as const, text: `MCP service not found: ${service_name}` }],
          };
        }

        const accessNames: Record<number, string> = { 0: "Public", 1: "Allowlist", 2: "OwnerOnly", 3: "AgentOnly" };
        const parsed = parseToolState(account.data);
        const lines = [`Service Name: ${parsed?.name ?? service_name}`];
        if (account._address) lines.push(`Account:      ${account._address}`);
        if (parsed) {
          lines.push(`Owner:        ${parsed.owner}`);
          lines.push(`Target prog:  ${parsed.targetProgram}`);
          lines.push(`Description:  ${parsed.description || "(none)"}`);
          if (parsed.inputSchemaUri) lines.push(`Input schema: ${parsed.inputSchemaUri}`);
          if (parsed.outputSchemaUri) lines.push(`Output schema:${parsed.outputSchemaUri}`);
          if (parsed.tags.length) lines.push(`Tags:         ${parsed.tags.join(", ")}`);
          lines.push(`Access:       ${accessNames[parsed.accessControl] ?? `access(${parsed.accessControl})`}`);
          if (parsed.allowlistCount > 0) lines.push(`Allowlist:    ${parsed.allowlistCount} entries`);
          lines.push(`Active:       ${parsed.isActive}`);
          lines.push(`Invocations:  ${parsed.invocationCount}`);
        } else {
          lines.push("(account data could not be decoded as ToolState)");
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
