import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "fs";
import { config } from "../config.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { buildEvmDeploySigningHash, buildSignedEvmDeployTx } from "../wasm/index.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";

const WORK_DIR = "/tmp/eto-foundry";
const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+$/;

const FOUNDRY_ENV = {
  ...process.env,
  PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`,
};

function sh(binary: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd: cwd || WORK_DIR, timeout: 60000, env: FOUNDRY_ENV }, (err, stdout, stderr) => {
      if (err) {
        const e = err as any;
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export function registerFoundryTools(server: McpServer): void {
  server.tool(
    "forge_compile",
    `Compile Solidity source code using Foundry's forge compiler. Provide the Solidity source code and get back compiled bytecode and ABI. This is faster and more reliable than manual compilation. Requires Foundry (forge) to be installed.`,
    {
      source: z.string().describe("Solidity source code"),
      contract_name: z.string().optional().describe("Contract name to extract (default: first contract found)"),
      solc_version: z.string().default("0.8.28").optional().describe("Solidity compiler version"),
    },
    async ({ source, contract_name, solc_version }) => {
      try {
        if (contract_name && !SAFE_NAME.test(contract_name)) {
          return { content: [{ type: "text" as const, text: `Invalid contract_name: must match ${SAFE_NAME}` }], isError: true };
        }
        if (solc_version && !SAFE_VERSION.test(solc_version)) {
          return { content: [{ type: "text" as const, text: `Invalid solc_version: must be in format X.Y.Z` }], isError: true };
        }

        // Set up temp project
        mkdirSync(`${WORK_DIR}/src`, { recursive: true });
        writeFileSync(`${WORK_DIR}/src/Contract.sol`, source);
        writeFileSync(`${WORK_DIR}/foundry.toml`, `[profile.default]\nsrc = "src"\nout = "out"\nsolc_version = "${solc_version || "0.8.28"}"\n`);

        // Clear the out dir before building so a stale artifact from a
        // previous or concurrent compile can't satisfy the lookup below.
        const outDir = `${WORK_DIR}/out`;
        rmSync(outDir, { recursive: true, force: true });

        const { stdout, stderr } = await sh("forge", ["build", "--force"]);

        if (!existsSync(outDir)) {
          return { content: [{ type: "text" as const, text: `Compilation failed:\n${stdout}\n${stderr}` }], isError: true };
        }

        // Find the contract JSON
        const name = contract_name || source.match(/contract\s+(\w+)/)?.[1] || "Contract";
        if (!SAFE_NAME.test(name)) {
          return { content: [{ type: "text" as const, text: `Invalid derived contract name "${name}": must match ${SAFE_NAME}` }], isError: true };
        }
        // Foundry stores artifacts at out/<sourceFileBasename>.sol/<contractName>.json.
        // We always write the source to src/Contract.sol, so the canonical
        // artifact path is out/Contract.sol/<contractName>.json. If the
        // artifact isn't at that path, the compile didn't produce one for
        // this contract — don't fall back to a recursive find (it would
        // happily return an unrelated stale artifact).
        const artifactPath = `${outDir}/Contract.sol/${name}.json`;
        if (!existsSync(artifactPath)) {
          const { stdout: ls } = await sh("find", [outDir, "-name", "*.json", "-type", "f"]);
          return { content: [{ type: "text" as const, text: `Contract "${name}" not found in output.\n\nAvailable artifacts:\n${ls}\n\nBuild output:\n${stdout}` }], isError: true };
        }

        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        const bytecode = artifact.bytecode?.object || artifact.bytecode || "";
        const abi = JSON.stringify(artifact.abi || [], null, 2);
        const deployedBytecode = artifact.deployedBytecode?.object || "";

        const lines = [
          `Compilation successful!`,
          ``,
          `Contract: ${name}`,
          `Bytecode: ${typeof bytecode === "string" ? bytecode.length / 2 : 0} bytes`,
          ``,
          `--- Bytecode (hex) ---`,
          typeof bytecode === "string" ? bytecode.slice(0, 200) + (bytecode.length > 200 ? "..." : "") : "N/A",
          ``,
          `--- ABI ---`,
          abi.slice(0, 500) + (abi.length > 500 ? "\n..." : ""),
          ``,
          `Full bytecode available. Use deploy_evm_contract with this bytecode to deploy.`,
          `Bytecode (full): ${bytecode}`,
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Forge compile error: ${err?.message ?? String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "forge_create",
    `Compile and deploy a Solidity contract in one step. Compiles with Foundry's forge, then deploys to ETO using the specified wallet (or active wallet if omitted). Returns contract address and tx signature.`,
    {
      source: z.string().describe("Solidity source code"),
      contract_name: z.string().optional().describe("Contract name to deploy (default: first contract found)"),
      constructor_args: z.array(z.string()).optional().describe("Constructor arguments as strings"),
      value: z.string().default("0").optional().describe("Wei value to send with deployment (default 0)"),
      from_wallet: z.string().optional().describe("Wallet ID to deploy from (defaults to the active wallet)"),
    },
    async ({ source, contract_name, constructor_args, value, from_wallet }) => {
      try {
        if (contract_name && !SAFE_NAME.test(contract_name)) {
          return { content: [{ type: "text" as const, text: `Invalid contract_name: must match ${SAFE_NAME}` }], isError: true };
        }

        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text" as const, text: "Error: no wallet specified. Pass from_wallet or call set_active_wallet first." }], isError: true };
        }

        // Step 1: Compile
        mkdirSync(`${WORK_DIR}/src`, { recursive: true });
        writeFileSync(`${WORK_DIR}/src/Contract.sol`, source);
        writeFileSync(`${WORK_DIR}/foundry.toml`, `[profile.default]\nsrc = "src"\nout = "out"\n`);
        const outDir = `${WORK_DIR}/out`;
        rmSync(outDir, { recursive: true, force: true });
        await sh("forge", ["build", "--force"]);

        const name = contract_name || source.match(/contract\s+(\w+)/)?.[1] || "Contract";
        if (!SAFE_NAME.test(name)) {
          return { content: [{ type: "text" as const, text: `Invalid derived contract name "${name}"` }], isError: true };
        }

        const artifactPath = `${outDir}/Contract.sol/${name}.json`;
        if (!existsSync(artifactPath)) {
          return { content: [{ type: "text" as const, text: `Contract "${name}" not found in compiled output.` }], isError: true };
        }

        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        let bytecode: string = artifact.bytecode?.object ?? artifact.bytecode ?? "";
        if (!bytecode) {
          return { content: [{ type: "text" as const, text: "Compilation produced no bytecode." }], isError: true };
        }
        bytecode = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;

        // Step 2: ABI-encode constructor args if needed
        if (constructor_args && constructor_args.length > 0) {
          const ctorAbi = (artifact.abi ?? []).find((e: any) => e.type === "constructor");
          if (ctorAbi) {
            const types = (ctorAbi.inputs ?? []).map((i: any) => i.type).join(",");
            const sig = `constructor(${types})`;
            const { stdout } = await sh("cast", ["abi-encode", sig, ...constructor_args]);
            const encoded = stdout.trim().replace(/^0x/, "");
            bytecode = bytecode + encoded;
          }
        }

        // Step 3: Deploy via EIP-155 secp256k1 signed EVM transaction
        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const { blockhash } = await blockhashCache.getBlockhash();
        const valueBig = BigInt(value ?? "0");
        const chainId = BigInt(config.chain.id);
        const gasPrice = 1_000_000_000n;
        const gasLimit = 1_000_000n;
        const nonce = 0n;
        const signingHash = buildEvmDeploySigningHash(bytecode, chainId, nonce, gasPrice, gasLimit, valueBig);
        const { r, s, recoveryBit } = await signer.signEvm(signingHash);
        const v = BigInt(recoveryBit) + chainId * 2n + 35n;
        const txBytes = buildSignedEvmDeployTx(
          signer.getPublicKey(), bytecode, r, s, v, chainId, nonce, gasPrice, gasLimit, valueBig, blockhash
        );
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({ signedTxBase64: signedBase64, vm: "svm", timeoutMs: 15000 });

        if (result.status === "confirmed" || result.status === "finalized") {
          return { content: [{ type: "text" as const, text: `Contract deployed!\nSignature: ${result.signature}\nStatus: ${result.status}${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }] };
        } else if (result.status === "timeout") {
          return { content: [{ type: "text" as const, text: `Submitted (confirmation timed out). Signature: ${result.signature}` }] };
        } else {
          return { content: [{ type: "text" as const, text: `Deployment failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }], isError: true };
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `forge_create error: ${err?.message ?? String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "cast_call",
    `Call a smart contract function using Foundry's cast. Supports both read (call) and write (send) operations with human-readable function signatures. Much easier than manual ABI encoding.`,
    {
      to: z.string().describe("Contract address (0x...)"),
      sig: z.string().describe("Function signature e.g. 'balanceOf(address)' or 'transfer(address,uint256)'"),
      args: z.array(z.string()).optional().describe("Function arguments"),
      send: z.boolean().default(false).optional().describe("If true, send a transaction (write). Otherwise just call (read)."),
    },
    async ({ to, sig, args, send }) => {
      try {
        if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
          return { content: [{ type: "text" as const, text: `Invalid contract address: must be a 40-hex-char EVM address (0x...)` }], isError: true };
        }
        if (!/^[a-zA-Z_]\w*\(.*\)$/.test(sig)) {
          return { content: [{ type: "text" as const, text: `Invalid function signature: must be in the form "functionName(type,type,...)" e.g. "transfer(address,uint256)"` }], isError: true };
        }
        const rpcUrl = config.etoRpcUrl;
        const callArgs = send
          ? ["send", to, sig, ...(args || []), "--rpc-url", rpcUrl, "--unlocked", "--from", "0x0000000000000000000000000000000000000000"]
          : ["call", to, sig, ...(args || []), "--rpc-url", rpcUrl];

        const { stdout, stderr } = await sh("cast", callArgs);
        return { content: [{ type: "text" as const, text: `${send ? "Transaction" : "Call"} result:\n${stdout}${stderr ? `\n${stderr}` : ""}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Cast error: ${err?.message ?? String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "cast_abi_encode",
    `ABI-encode function call data using Foundry's cast. Returns the hex-encoded calldata for a function call. Useful for building transactions manually or for cross-VM calls.`,
    {
      sig: z.string().describe("Function signature e.g. 'transfer(address,uint256)'"),
      args: z.array(z.string()).describe("Function arguments"),
    },
    async ({ sig, args }) => {
      try {
        if (!/^[a-zA-Z_]\w*\(.*\)$/.test(sig)) {
          return { content: [{ type: "text" as const, text: `Invalid function signature: must be in the form "functionName(type,type,...)" e.g. "transfer(address,uint256)"` }], isError: true };
        }
        const { stdout } = await sh("cast", ["abi-encode", sig, ...args]);
        return { content: [{ type: "text" as const, text: `ABI-encoded calldata:\n${stdout.trim()}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Cast encode error: ${err?.message ?? String(err)}` }], isError: true };
      }
    }
  );
}
