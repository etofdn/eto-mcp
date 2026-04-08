import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { buildEvmDeployTx, buildWasmDeployTx, buildMoveDeployTx, buildSvmDeployTx } from "../wasm/index.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import bs58 from "bs58";

export function registerDeployTools(server: McpServer): void {
  server.tool(
    "deploy_evm_contract",
    "Deploy a Solidity/EVM smart contract to the ETO chain. Returns contract address, tx hash, and gas used. Simulation runs first to catch reverts before submission. Provide hex-encoded compiled bytecode (with or without 0x prefix). Optional constructor_args should be ABI-encoded hex. value is in wei.",
    {
      bytecode: z.string().describe("Hex-encoded compiled bytecode (output of solc/hardhat)"),
      constructor_args: z
        .string()
        .optional()
        .describe("ABI-encoded constructor arguments as hex (without 0x prefix)"),
      value: z
        .string()
        .default("0")
        .optional()
        .describe("Wei value to send with deployment (default 0)"),
      from_wallet: z
        .string()
        .optional()
        .describe("Deployer address (base58 or 0x). Uses default wallet if omitted."),
    },
    async ({ bytecode, constructor_args, value, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const deployer = signer.getPublicKey();

        // Normalize bytecode: strip 0x prefix, append constructor args if provided
        const hexStripped = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
        const fullBytecode = constructor_args ? hexStripped + constructor_args.replace(/^0x/, "") : hexStripped;

        const valueBigInt = BigInt(value ?? "0");
        const gasLimit = 1_000_000n;

        const { blockhash } = await blockhashCache.getBlockhash();

        const txBytes = buildEvmDeployTx(deployer, fullBytecode, valueBigInt, gasLimit, blockhash);

        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `EVM contract deployed.\nSignature: ${result.signature}\nStatus: ${result.status}${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Deployment submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Deployment failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }],
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
    "deploy_wasm_contract",
    "Deploy a CosmWasm-compatible smart contract to the ETO chain. Accepts a base64-encoded WASM binary. Optionally provide an instantiation message (JSON), a human-readable label, and the deployer wallet. The contract is first uploaded (stored), then instantiated in a single pipeline.",
    {
      wasm_binary: z
        .string()
        .describe("Base64-encoded WASM binary (output of cargo wasm build)"),
      init_msg: z
        .any()
        .optional()
        .describe("JSON instantiation message passed to the contract's instantiate entrypoint"),
      label: z
        .string()
        .optional()
        .describe("Human-readable label for the contract instance"),
      from_wallet: z
        .string()
        .optional()
        .describe("Deployer address. Uses default wallet if omitted."),
    },
    async ({ wasm_binary, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const deployer = signer.getPublicKey();

        const wasmBytes = new Uint8Array(Buffer.from(wasm_binary, "base64"));

        const { blockhash } = await blockhashCache.getBlockhash();

        let txBytes: Uint8Array;
        try {
          txBytes = buildWasmDeployTx(deployer, wasmBytes, blockhash);
        } catch (e: any) {
          const deployerLen = (() => { try { return bs58.decode(deployer).length; } catch { return "decode-error"; } })();
          const blockhashLen = (() => { try { return bs58.decode(blockhash).length; } catch { return "decode-error"; } })();
          return {
            content: [{ type: "text" as const, text: `Deploy failed: ${e.message}. deployer=${deployer} (${deployerLen} bytes), blockhash=${blockhash} (${blockhashLen} bytes)` }],
            isError: true,
          };
        }

        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `WASM contract deployed.\nSignature: ${result.signature}\nStatus: ${result.status}${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Deployment submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Deployment failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }],
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
    "deploy_move_module",
    "Deploy a Move language module to the ETO chain. Accepts a base64-encoded Move bytecode bundle (compiled with the Move compiler). Move modules on ETO are published under the deployer's address and are immediately callable via cross-VM dispatch.",
    {
      move_binary: z
        .string()
        .describe("Base64-encoded Move bytecode bundle (output of move build)"),
      from_wallet: z
        .string()
        .optional()
        .describe("Publisher address. Uses default wallet if omitted."),
    },
    async ({ move_binary, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const deployer = signer.getPublicKey();

        const moveBytes = new Uint8Array(Buffer.from(move_binary, "base64"));

        const { blockhash } = await blockhashCache.getBlockhash();

        let txBytes: Uint8Array;
        try {
          txBytes = buildMoveDeployTx(deployer, moveBytes, blockhash);
        } catch (e: any) {
          const deployerLen = (() => { try { return bs58.decode(deployer).length; } catch { return "decode-error"; } })();
          const blockhashLen = (() => { try { return bs58.decode(blockhash).length; } catch { return "decode-error"; } })();
          return {
            content: [{ type: "text" as const, text: `Deploy failed: ${e.message}. deployer=${deployer} (${deployerLen} bytes), blockhash=${blockhash} (${blockhashLen} bytes)` }],
            isError: true,
          };
        }

        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Move module deployed.\nSignature: ${result.signature}\nStatus: ${result.status}${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Deployment submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Deployment failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }],
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
    "deploy_svm_program",
    "Deploy a Solana-compatible BPF/SBF program to the ETO chain. Accepts a base64-encoded compiled program binary. The program is written to a program account via the BPF Loader and becomes immediately executable. Optionally provide an upgrade authority.",
    {
      program_binary: z
        .string()
        .describe("Base64-encoded BPF/SBF program binary (output of cargo build-bpf)"),
      from_wallet: z
        .string()
        .optional()
        .describe("Payer and upgrade authority address. Uses default wallet if omitted."),
    },
    async ({ program_binary, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const deployer = signer.getPublicKey();

        const programBytes = new Uint8Array(Buffer.from(program_binary, "base64"));

        const { blockhash } = await blockhashCache.getBlockhash();

        const txBytes = buildSvmDeployTx(deployer, programBytes, blockhash);

        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `SVM program deployed.\nSignature: ${result.signature}\nStatus: ${result.status}${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Deployment submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Deployment failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }],
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
}
