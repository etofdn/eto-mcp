import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import {
  resolveAddressesAsync,
  evmAddressToPubkey,
  isValidEvmAddress,
  isValidSvmAddress,
} from "../utils/address.js";
import bs58 from "bs58";
import { localSignerFactory } from "../signing/local-signer.js";
import { buildCrossVmCallTx } from "../wasm/index.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";

export function registerCrossVmTools(server: McpServer): void {
  server.tool(
    "cross_vm_call",
    "Initiate a cross-VM call on the ETO chain, routing a call from one VM runtime to a contract in another VM. Calls are routed through ETO's CrossVmDispatcher program. State changes across VMs are atomic — if any leg fails, the entire call reverts. Maximum nesting depth is 4.",
    {
      source_vm: z
        .enum(["svm", "evm", "wasm", "move"])
        .describe("The VM runtime initiating the call"),
      target_vm: z
        .enum(["svm", "evm", "wasm", "move"])
        .describe("The VM runtime of the target contract"),
      target_contract: z
        .string()
        .describe(
          "Address of the target contract (base58 for SVM/WASM/Move, 0x for EVM)"
        ),
      method: z
        .string()
        .describe(
          "Method to call on the target contract. Use full signature for EVM e.g. 'transfer(address,uint256)'."
        ),
      args: z
        .array(z.any())
        .optional()
        .describe("Method arguments as a JSON array"),
      value: z
        .string()
        .default("0")
        .optional()
        .describe("Value to attach to the cross-VM call in lamports/wei (default 0)"),
      from_wallet: z
        .string()
        .optional()
        .describe("Caller wallet address. Uses default wallet if omitted."),
    },
    async ({
      source_vm,
      target_vm,
      target_contract,
      method,
      args,
      value,
      from_wallet,
    }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text", text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }] };
        }
        const signer = await getSignerFactory().getSigner(walletId);
        const fromSvm = signer.getPublicKey();
        const { blockhash } = await blockhashCache.getBlockhash();

        const vmMap: Record<string, number> = { svm: 0, evm: 1, wasm: 2, move: 3 };
        const sourceVmNum = vmMap[source_vm] ?? 0;
        const targetVmNum = vmMap[target_vm] ?? 1;

        // If target is EVM and address is 0x-prefixed, encode the EVM address as an
        // SVM-compatible pubkey for the CrossVmDispatcher instruction. This uses
        // `evmAddressToPubkey` (FN-017 will update the body; for now the SHA-256
        // preimage is retained as a stable internal representation for the
        // cross-VM dispatcher key derivation — distinct from the wallet registry).
        let resolvedTargetContract = target_contract;
        if (target_vm === "evm" && target_contract.startsWith("0x") && isValidEvmAddress(target_contract)) {
          resolvedTargetContract = bs58.encode(evmAddressToPubkey(target_contract));
        }

        let calldata: Uint8Array;
        if (target_vm === "evm" && method) {
          const { encodeEvmCall } = await import("../wasm/index.js");
          calldata = encodeEvmCall(method, args || []);
        } else {
          calldata = new TextEncoder().encode(JSON.stringify({ method, args: args || [] }));
        }

        const txBytes = buildCrossVmCallTx(fromSvm, sourceVmNum, targetVmNum, resolvedTargetContract, calldata, blockhash);
        const signedTx = await signer.sign(txBytes);
        const txBase64 = Buffer.from(signedTx).toString("base64");
        const result = await submitter.submitAndConfirm({ signedTxBase64: txBase64, vm: "svm", timeoutMs: 15000 });

        const lines: string[] = [];
        if (result.status === "confirmed" || result.status === "finalized") {
          lines.push("Cross-VM call successful.");
          lines.push(`Signature:       ${result.signature}`);
          lines.push(`Status:          ${result.status}`);
          lines.push(`Source VM:       ${source_vm}`);
          lines.push(`Target VM:       ${target_vm}`);
          lines.push(`Target contract: ${target_contract}`);
          lines.push(`Method:          ${method}`);
          lines.push(`Args:            ${JSON.stringify(args ?? [])}`);
          lines.push(`Value:           ${value ?? "0"}`);
          if (result.fee !== undefined) lines.push(`Fee:             ${result.fee} lamports`);
          if (result.latency_ms) lines.push(`Latency:         ${result.latency_ms}ms`);
        } else if (result.status === "timeout") {
          lines.push("Transaction submitted but confirmation timed out.");
          lines.push(`Signature: ${result.signature}`);
          lines.push("The transaction may still confirm — check the signature on-chain.");
        } else {
          lines.push("Cross-VM call failed.");
          lines.push(`Error: ${result.error?.explanation ?? result.error?.raw_message ?? "Unknown error"}`);
          if (result.error?.recovery_hints?.length) {
            lines.push(`Hints: ${result.error.recovery_hints.join("; ")}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "resolve_cross_vm_address",
    "Resolve an address between ETO's SVM (base58) and EVM (0x) formats. Every account on ETO has both representations. SVM→EVM: take the last 20 bytes of the 32-byte pubkey. EVM→SVM: derive via SHA256('evm:' || address_bytes). Returns both formats and explains the mapping.",
    {
      address: z
        .string()
        .describe(
          "Address in any format: base58 SVM pubkey or 0x EVM address"
        ),
    },
    async ({ address }) => {
      try {
        const trimmed = address.trim();

        if (!isValidEvmAddress(trimmed) && !isValidSvmAddress(trimmed)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid address: "${trimmed}"\nExpected a base58 SVM pubkey (32 bytes) or a 0x-prefixed EVM address (20 bytes).`,
              },
            ],
          };
        }

        // Use the registry-backed async resolver (FN-016).
        // Falls back to an informative error if the address is not registered.
        const registry = localSignerFactory.getRegistryForCurrentScope();
        const { svm, evm } = await resolveAddressesAsync(trimmed, registry);

        const inputType = isValidEvmAddress(trimmed) ? "EVM" : "SVM";

        const lines = [
          `Input Address: ${trimmed}`,
          `Input Format:  ${inputType}`,
          ``,
          `SVM Address:   ${svm}`,
          `EVM Address:   ${evm}`,
          ``,
          "Mapping method: registry-backed bijection (FN-016).",
          "  EVM address = signer.getEvmSigningAddress() stored at wallet creation.",
          "  This is the address recovered by ecrecover on any signed EVM transaction.",
          "",
          "Note: Both addresses refer to the same ETO account. Funds sent to either",
          "address are accessible from both EVM and SVM programs.",
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "inspect_uth",
    "Inspect a UTH (Universal Token Header) token account on ETO. UTH is a 76-byte header prepended to all token accounts, enabling cross-VM token interoperability. Parses: version, VM origin (SVM/EVM/WASM/Move), mint address, owner, amount, decimals, and frozen flag.",
    {
      account: z
        .string()
        .describe(
          "Token account address to inspect (base58 SVM or 0x EVM). Must be a UTH-compatible token account."
        ),
    },
    async ({ account }) => {
      try {
        const accountInfo = await rpc.getAccountInfo(account);

        if (!accountInfo) {
          return {
            content: [
              { type: "text", text: `Account not found: ${account}` },
            ],
          };
        }

        // Unwrap value wrapper if present (Solana RPC style)
        const value = accountInfo.value ?? accountInfo;

        // Extract raw bytes from account data
        let dataBytes: Uint8Array | null = null;

        if (value?.data) {
          const data = value.data;

          if (typeof data === "string") {
            // base64-encoded
            try {
              const buf = Buffer.from(data, "base64");
              dataBytes = new Uint8Array(buf);
            } catch {
              // try hex
              try {
                const clean = data.startsWith("0x") ? data.slice(2) : data;
                const buf = Buffer.from(clean, "hex");
                dataBytes = new Uint8Array(buf);
              } catch {
                dataBytes = null;
              }
            }
          } else if (Array.isArray(data) && data.length >= 2) {
            // [base64string, encoding] format
            try {
              const buf = Buffer.from(data[0], data[1] === "base64" ? "base64" : "hex");
              dataBytes = new Uint8Array(buf);
            } catch {
              dataBytes = null;
            }
          } else if (data instanceof Uint8Array) {
            dataBytes = data;
          } else if (Buffer.isBuffer(data)) {
            dataBytes = new Uint8Array(data);
          }
        }

        if (!dataBytes || dataBytes.length < 76) {
          const size = dataBytes ? dataBytes.length : 0;
          return {
            content: [
              {
                type: "text",
                text: [
                  `Account: ${account}`,
                  `Data size: ${size} bytes`,
                  ``,
                  `Not a UTH token account — data is too short (need 76 bytes, got ${size}).`,
                  `UTH (Universal Token Header) requires exactly 76 bytes at the start of the account data.`,
                ].join("\n"),
              },
            ],
          };
        }

        // Parse UTH fields from the first 76 bytes
        // [0]:    version (u8)
        // [1]:    vm_origin (u8): 0=SVM, 1=EVM, 2=WASM, 3=Move
        // [2..34]: mint (32 bytes)
        // [34..66]: owner (32 bytes)
        // [66..74]: amount (u64 little-endian)
        // [74]:   decimals (u8)
        // [75]:   frozen (u8, 0=false, 1=true)

        const version = dataBytes[0];

        if (version !== 1) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `Account: ${account}`,
                  `Data size: ${dataBytes.length} bytes`,
                  `Version byte: ${version}`,
                  ``,
                  `Not a UTH token account — version byte is ${version}, expected 1.`,
                ].join("\n"),
              },
            ],
          };
        }

        const vmOriginByte = dataBytes[1];
        const vmOriginNames: Record<number, string> = {
          0: "SVM",
          1: "EVM",
          2: "WASM",
          3: "Move",
        };
        const vmOrigin = vmOriginNames[vmOriginByte] ?? `unknown (${vmOriginByte})`;

        const mintBytes = dataBytes.slice(2, 34);
        const ownerBytes = dataBytes.slice(34, 66);

        // Read u64 little-endian amount from bytes [66..74]
        let amount = 0n;
        for (let i = 0; i < 8; i++) {
          amount |= BigInt(dataBytes[66 + i]) << BigInt(i * 8);
        }

        const decimals = dataBytes[74];
        const frozen = dataBytes[75] !== 0;

        // Encode mint and owner as base58
        import("bs58").then(() => {}).catch(() => {});
        const bs58 = await import("bs58");
        const mint = bs58.default.encode(mintBytes);
        const owner = bs58.default.encode(ownerBytes);

        // Format amount with decimals
        const divisor = 10n ** BigInt(decimals);
        const whole = amount / divisor;
        const frac = amount % divisor;
        const fracStr =
          decimals > 0
            ? "." + frac.toString().padStart(decimals, "0").replace(/0+$/, "") || ""
            : "";
        const humanAmount = `${whole}${fracStr}`;

        const lines = [
          `Account:   ${account}`,
          ``,
          `=== UTH (Universal Token Header) ===`,
          `Version:   ${version}`,
          `VM Origin: ${vmOrigin}`,
          `Mint:      ${mint}`,
          `Owner:     ${owner}`,
          `Amount:    ${humanAmount} (raw: ${amount})`,
          `Decimals:  ${decimals}`,
          `Frozen:    ${frozen}`,
          ``,
          `Total data size: ${dataBytes.length} bytes (76 UTH header + ${dataBytes.length - 76} program-specific data)`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
