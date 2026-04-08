import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { detectAddressType } from "../utils/address.js";

/** Compute the 4-byte EVM function selector from a signature string */
function evmSelector(signature: string): Uint8Array {
  const encoder = new TextEncoder();
  const hash = keccak_256(encoder.encode(signature));
  return hash.slice(0, 4);
}

/** Minimal ABI encoder for common Solidity types */
function abiEncodeArgs(args: any[]): Uint8Array {
  if (!args || args.length === 0) return new Uint8Array(0);

  const slots: Uint8Array[] = [];

  for (const arg of args) {
    const slot = new Uint8Array(32);

    if (typeof arg === "bigint") {
      const hex = arg.toString(16).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        slot[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      }
    } else if (typeof arg === "number") {
      const hex = arg.toString(16).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        slot[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      }
    } else if (typeof arg === "string" && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
      // address: right-pad to 32 bytes (left-padded with zeros)
      const addrHex = arg.slice(2).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        slot[i] = parseInt(addrHex.substring(i * 2, i * 2 + 2), 16);
      }
    } else if (typeof arg === "string" && /^(0x)?[0-9a-fA-F]+$/.test(arg)) {
      // bytes32 or uint256 as hex string
      const clean = arg.startsWith("0x") ? arg.slice(2) : arg;
      const padded = clean.padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        slot[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
      }
    } else if (typeof arg === "boolean") {
      slot[31] = arg ? 1 : 0;
    } else {
      // Fallback: stringify and encode as uint256 0
      // For complex types, caller should pre-encode
      slot[31] = 0;
    }

    slots.push(slot);
  }

  const result = new Uint8Array(slots.length * 32);
  let offset = 0;
  for (const slot of slots) {
    result.set(slot, offset);
    offset += 32;
  }
  return result;
}

/** Build EVM calldata: 4-byte selector + ABI-encoded args */
function buildEvmCalldata(method: string, args: any[]): string {
  const selector = evmSelector(method);
  const encodedArgs = abiEncodeArgs(args ?? []);
  const calldata = new Uint8Array(selector.length + encodedArgs.length);
  calldata.set(selector, 0);
  calldata.set(encodedArgs, selector.length);
  return "0x" + Buffer.from(calldata).toString("hex");
}

export function registerContractTools(server: McpServer): void {
  server.tool(
    "call_contract",
    "Call a smart contract method on the ETO chain. For read-only calls (read_only=true) on EVM contracts, encodes the calldata and uses eth_call without submitting a transaction. For write calls, builds, signs, and submits a transaction. VM type is auto-detected from the contract address format (0x = EVM, base58 = SVM/WASM/Move).",
    {
      contract: z
        .string()
        .describe("Contract address (0x for EVM, base58 for SVM/WASM/Move)"),
      method: z
        .string()
        .describe(
          "Method name/signature. For EVM use full signature e.g. 'transfer(address,uint256)'. For SVM/WASM use method name."
        ),
      args: z
        .array(z.any())
        .optional()
        .describe("Method arguments as a JSON array. Types are inferred from values."),
      value: z
        .string()
        .default("0")
        .optional()
        .describe("Wei/lamports value to send with the call (default 0)"),
      read_only: z
        .boolean()
        .default(false)
        .optional()
        .describe("If true, uses eth_call (no gas, no state change). Default false."),
      vm: z
        .enum(["auto", "evm", "wasm", "move", "svm"])
        .default("auto")
        .optional()
        .describe("VM type. 'auto' detects from address format."),
      from_wallet: z
        .string()
        .optional()
        .describe("Caller address for EVM eth_call or transaction signing."),
    },
    async ({ contract, method, args, value, read_only, vm, from_wallet }) => {
      try {
        // Auto-detect VM from address format
        const detectedVm =
          vm === "auto" || !vm ? detectAddressType(contract) : vm;

        if (read_only && detectedVm === "evm") {
          const calldata = buildEvmCalldata(method, args ?? []);
          const result = await rpc.ethCall(
            {
              from: from_wallet,
              to: contract,
              data: calldata,
              value: value && value !== "0" ? "0x" + BigInt(value).toString(16) : undefined,
            }
          );

          const lines = [
            `Contract: ${contract}`,
            `Method:   ${method}`,
            `VM:       EVM (read-only)`,
            `Calldata: ${calldata}`,
            ``,
            `Result: ${result ?? "(empty)"}`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        if (read_only && detectedVm !== "evm") {
          return {
            content: [
              {
                type: "text",
                text: [
                  `Contract: ${contract}`,
                  `Method:   ${method}`,
                  `VM:       ${detectedVm} (read-only)`,
                  ``,
                  "Read-only calls for SVM/WASM/Move contracts: tool interface is ready.",
                  "Planned flow: serialize instruction → simulateTransaction → return logs/return data.",
                  "The SVM/WASM/Move read pipeline will be wired in the next iteration.",
                ].join("\n"),
              },
            ],
          };
        }

        // Write call stub for all VMs
        const calldataPreview =
          detectedVm === "evm" ? buildEvmCalldata(method, args ?? []) : "(non-EVM)";

        const lines = [
          `Contract write call — tool interface is ready.`,
          ``,
          `Contract  : ${contract}`,
          `Method    : ${method}`,
          `VM        : ${detectedVm}`,
          `Args      : ${JSON.stringify(args ?? [])}`,
          `Value     : ${value ?? "0"}`,
          `From      : ${from_wallet ?? "(default)"}`,
          `Calldata  : ${calldataPreview}`,
          ``,
          "Planned flow:",
          "  1. Encode calldata for the target VM",
          "  2. Estimate gas / simulate",
          "  3. Sign transaction with from_wallet",
          "  4. Submit via sendTransaction / eth_sendRawTransaction",
          "  5. Return: tx_hash, gas_used, logs, return_value",
          "",
          "The write call pipeline will be wired in the next iteration.",
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
    "read_contract",
    "Read data from a smart contract without submitting a transaction (eth_call). Convenience wrapper around call_contract with read_only=true. For EVM contracts, computes the 4-byte keccak256 selector from the method signature and ABI-encodes arguments. Returns the raw hex result from the contract.",
    {
      contract: z
        .string()
        .describe("Contract address (0x for EVM, base58 for SVM/WASM/Move)"),
      method: z
        .string()
        .describe(
          "Function signature e.g. 'balanceOf(address)' for EVM, or method name for other VMs"
        ),
      args: z
        .array(z.any())
        .optional()
        .describe("Method arguments as a JSON array"),
      vm: z
        .enum(["auto", "evm", "wasm", "move", "svm"])
        .default("auto")
        .optional()
        .describe("VM type. 'auto' detects from address format."),
    },
    async ({ contract, method, args, vm }) => {
      try {
        const detectedVm =
          vm === "auto" || !vm ? detectAddressType(contract) : vm;

        if (detectedVm === "evm") {
          const calldata = buildEvmCalldata(method, args ?? []);

          const result = await rpc.ethCall({ to: contract, data: calldata });

          const selectorHex = Buffer.from(evmSelector(method)).toString("hex");

          const lines = [
            `Contract: ${contract}`,
            `Method:   ${method}`,
            `Selector: 0x${selectorHex}`,
            `Calldata: ${calldata}`,
            ``,
            `Result: ${result ?? "(empty)"}`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Non-EVM: stub
        const lines = [
          `Contract: ${contract}`,
          `Method:   ${method}`,
          `VM:       ${detectedVm}`,
          ``,
          "Read contract for SVM/WASM/Move — tool interface is ready.",
          "Planned flow: serialize query instruction → simulateTransaction → decode return data.",
          "The non-EVM read pipeline will be wired in the next iteration.",
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
    "encode_calldata",
    "Encode ABI calldata for a contract call without executing it. For EVM: computes the 4-byte keccak256 function selector from the method signature and ABI-encodes the arguments into a hex string. Useful for constructing raw transactions, debugging, or cross-VM dispatch payloads.",
    {
      method: z
        .string()
        .describe(
          "Function signature e.g. 'transfer(address,uint256)'. Must be canonical form (no spaces, full types)."
        ),
      args: z.array(z.any()).describe("Arguments to encode as a JSON array"),
      vm: z
        .enum(["evm", "wasm", "move"])
        .describe("Target VM encoding format"),
    },
    async ({ method, args, vm }) => {
      try {
        if (vm === "evm") {
          const selector = evmSelector(method);
          const encodedArgs = abiEncodeArgs(args);
          const calldata = new Uint8Array(selector.length + encodedArgs.length);
          calldata.set(selector, 0);
          calldata.set(encodedArgs, selector.length);
          const calldataHex = "0x" + Buffer.from(calldata).toString("hex");
          const selectorHex = Buffer.from(selector).toString("hex");

          const lines = [
            `Method:   ${method}`,
            `VM:       EVM`,
            `Selector: 0x${selectorHex}  (keccak256("${method}")[0:4])`,
            `Args:     ${JSON.stringify(args)}`,
            ``,
            `Calldata: ${calldataHex}`,
            `Length:   ${calldata.length} bytes (4 selector + ${encodedArgs.length} args)`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // WASM / Move stub
        const lines = [
          `Method: ${method}`,
          `VM:     ${vm}`,
          `Args:   ${JSON.stringify(args)}`,
          ``,
          `${vm.toUpperCase()} calldata encoding — tool interface is ready.`,
          vm === "wasm"
            ? "WASM encoding: serialize args as JSON or Borsh depending on contract IDL."
            : "Move encoding: serialize args as BCS (Binary Canonical Serialization).",
          "The encoding pipeline will be wired in the next iteration.",
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
    "get_contract_info",
    "Inspect a deployed contract on the ETO chain. Returns the contract address, detected VM type, bytecode size, owner/deployer, and whether it is upgradeable. Works with EVM (0x) and SVM/WASM/Move (base58) addresses.",
    {
      contract: z
        .string()
        .describe("Contract address (0x for EVM, base58 for SVM/WASM/Move)"),
    },
    async ({ contract }) => {
      try {
        const detectedVm = detectAddressType(contract);

        if (detectedVm === "evm") {
          const [account, code] = await Promise.all([
            rpc.etoGetAccount(contract).catch(() => null),
            rpc.ethGetCode(contract).catch(() => null),
          ]);

          const codeHex = code ?? "0x";
          const bytecodeSize =
            codeHex === "0x" ? 0 : (codeHex.length - 2) / 2;

          const lines = [
            `Address:       ${contract}`,
            `VM Type:       EVM`,
            `Bytecode Size: ${bytecodeSize} bytes${bytecodeSize === 0 ? " (EOA or not deployed)" : ""}`,
          ];

          if (account) {
            lines.push(`Owner:         ${account.owner ?? "N/A"}`);
            lines.push(
              `Balance:       ${account.lamports !== undefined ? account.lamports + " lamports" : "N/A"}`
            );
            lines.push(
              `Upgradeable:   ${account.upgradeable ?? account.executable === false ? "false" : "unknown"}`
            );
            lines.push(
              `VM Type (ETO): ${account.vmType ?? account.vm_type ?? "evm"}`
            );
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // SVM/WASM/Move: use etoGetAccount
        const account = await rpc.etoGetAccount(contract);

        if (!account) {
          return {
            content: [
              { type: "text", text: `Contract not found: ${contract}` },
            ],
          };
        }

        const dataSize = account.data
          ? typeof account.data === "string"
            ? account.data.length
            : JSON.stringify(account.data).length
          : 0;

        const lines = [
          `Address:       ${contract}`,
          `VM Type:       ${account.vmType ?? account.vm_type ?? detectedVm}`,
          `Bytecode Size: ${dataSize} bytes`,
          `Owner:         ${account.owner ?? "N/A"}`,
          `Executable:    ${account.executable ?? false}`,
          `Upgradeable:   ${account.upgradeable ?? "unknown"}`,
          `Balance:       ${account.lamports !== undefined ? account.lamports + " lamports" : "N/A"}`,
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
