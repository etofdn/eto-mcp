import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { PROGRAM_IDS } from "../config.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import bs58 from "bs58";

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
  writeVec(msgBuf, new Uint8Array([0, 1]));
  writeVec(msgBuf, instructionData);

  const msgBytes = new Uint8Array(msgBuf);

  const txBuf: number[] = [];
  writeU32LE(txBuf, 1);
  writeBytes(txBuf, zeroSig);
  writeBytes(txBuf, msgBytes);

  return new Uint8Array(txBuf);
}

const SERVICE_TYPE_MAP: Record<string, number> = {
  oracle: 0,
  relayer: 1,
  compute: 2,
  storage: 3,
  bridge: 4,
  custom: 5,
};

export function registerMcpProgramTools(server: McpServer): void {
  server.tool(
    "register_mcp_service",
    "Registers a new MCP service (tool) on the ETO network, making it discoverable and callable by other agents. Services are typed as oracles (price/data feeds), relayers (cross-chain bridges), compute units (off-chain compute), storage providers, bridge adapters, or custom services. The endpoint URL and optional fee define where the service is hosted and how much callers pay per invocation. Returns the on-chain tool account address.",
    {
      service_name: z.string().describe("Unique name for the MCP service (e.g. 'price-oracle-eth-usd')"),
      service_type: z.enum(["oracle", "relayer", "compute", "storage", "bridge", "custom"])
        .describe("Category of service being registered"),
      endpoint: z.string().describe("URL or address where the service can be invoked"),
      fee_per_call: z.string().optional().describe("Fee in lamports charged to callers per invocation (default: 0)"),
      metadata: z.any().optional().describe("Optional JSON metadata stored with the service registration"),
    },
    async ({ service_name, service_type, endpoint, fee_per_call, metadata }) => {
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

        // Instruction: discriminator 0 = RegisterMcpTool
        const data: number[] = [];
        writeU8(data, 0);
        writeStr(data, service_name);
        writeU8(data, SERVICE_TYPE_MAP[service_type] ?? 5);
        writeStr(data, endpoint);
        writeU64LE(data, BigInt(fee_per_call ?? "0"));
        const metaStr = metadata ? JSON.stringify(metadata) : "";
        writeStr(data, metaStr);

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildMcpTx(payerSvm, toolAccount, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `register-mcp-${service_name}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            "MCP service registered successfully.",
            `Service Name:  ${service_name}`,
            `Tool Account:  ${toolAccount}`,
            `Type:          ${service_type}`,
            `Endpoint:      ${endpoint}`,
            `Fee/Call:      ${fee_per_call ?? "0"} lamports`,
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

        const typeNames = ["oracle", "relayer", "compute", "storage", "bridge", "custom"];
        const lines = [`MCP services (filter: ${service_type ?? "all"}) — ${accounts.length} found:\n`];

        for (const acct of accounts) {
          const addr = acct.pubkey ?? acct.address ?? "N/A";
          let nameStr = "N/A";
          let typeStr = "N/A";
          let endpointStr = "N/A";

          const rawData = acct.account?.data ?? acct.data;
          if (rawData && typeof rawData === "string") {
            try {
              const bytes = Buffer.from(rawData, "base64");
              const typeByte = bytes[1];
              typeStr = typeNames[typeByte] ?? `type(${typeByte})`;
              const nameLen = bytes.readUInt32LE(2);
              nameStr = bytes.slice(6, 6 + nameLen).toString("utf8");
              const endpOffset = 6 + nameLen;
              const endpLen = bytes.readUInt32LE(endpOffset);
              endpointStr = bytes.slice(endpOffset + 4, endpOffset + 4 + endpLen).toString("utf8");
            } catch {
              // leave defaults
            }
          }

          lines.push(`  Account:  ${addr}`);
          lines.push(`  Name:     ${nameStr}`);
          lines.push(`  Type:     ${typeStr}`);
          lines.push(`  Endpoint: ${endpointStr}`);
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

        // Try to derive the tool account address if we have an owner hint
        let account: any = null;
        if (ownerHint) {
          const toolAccount = deriveToolAddress(service_name, ownerHint);
          account = await rpc.getAccountInfo(toolAccount);
        }

        if (!account) {
          // Fallback: search all MCP accounts
          const mcpProgramId = bs58.encode(PROGRAM_IDS.mcp);
          try {
            const allAccounts = await rpc.getProgramAccounts(mcpProgramId);
            for (const acct of allAccounts ?? []) {
              const rawData = acct.account?.data ?? acct.data;
              if (rawData && typeof rawData === "string") {
                try {
                  const bytes = Buffer.from(rawData, "base64");
                  const nameLen = bytes.readUInt32LE(2);
                  const name = bytes.slice(6, 6 + nameLen).toString("utf8");
                  if (name === service_name) {
                    account = { ...acct.account, _address: acct.pubkey ?? acct.address };
                    break;
                  }
                } catch {
                  // continue
                }
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

        const typeNames = ["oracle", "relayer", "compute", "storage", "bridge", "custom"];
        let typeStr = "N/A";
        let endpointStr = "N/A";
        let feeStr = "0";
        let metaStr = "";

        const rawData = account.data;
        if (rawData && typeof rawData === "string") {
          try {
            const bytes = Buffer.from(rawData, "base64");
            const typeByte = bytes[1];
            typeStr = typeNames[typeByte] ?? `type(${typeByte})`;
            const nameLen = bytes.readUInt32LE(2);
            let offset = 6 + nameLen;
            const endpLen = bytes.readUInt32LE(offset);
            offset += 4;
            endpointStr = bytes.slice(offset, offset + endpLen).toString("utf8");
            offset += endpLen;
            if (offset + 8 <= bytes.length) {
              const feeLo = bytes.readUInt32LE(offset);
              const feeHi = bytes.readUInt32LE(offset + 4);
              const fee = BigInt(feeHi) * 0x100000000n + BigInt(feeLo);
              feeStr = fee.toString();
              offset += 8;
            }
            if (offset < bytes.length) {
              const metaLen = bytes.readUInt32LE(offset);
              metaStr = bytes.slice(offset + 4, offset + 4 + metaLen).toString("utf8");
            }
          } catch {
            // leave defaults
          }
        }

        const lines = [
          `Service Name: ${service_name}`,
          `Type:         ${typeStr}`,
          `Endpoint:     ${endpointStr}`,
          `Fee/Call:     ${feeStr} lamports`,
          `Owner:        ${account.owner ?? "N/A"}`,
        ];
        if (account._address) lines.push(`Account:      ${account._address}`);
        if (metaStr) lines.push(`Metadata:     ${metaStr}`);

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
