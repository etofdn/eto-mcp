import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { config } from "../config.js";

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

        const { stdout, stderr } = await sh("forge", ["build", "--force"]);

        // Find compiled artifacts
        const outDir = `${WORK_DIR}/out`;
        if (!existsSync(outDir)) {
          return { content: [{ type: "text" as const, text: `Compilation failed:\n${stdout}\n${stderr}` }], isError: true };
        }

        // Find the contract JSON
        const name = contract_name || source.match(/contract\s+(\w+)/)?.[1] || "Contract";
        if (!SAFE_NAME.test(name)) {
          return { content: [{ type: "text" as const, text: `Invalid derived contract name "${name}": must match ${SAFE_NAME}` }], isError: true };
        }
        // Foundry stores artifacts at out/<sourceFileBasename>.sol/<contractName>.json.
        // The .sol directory name is the source file's basename (typically "Contract.sol"),
        // not the contract name itself, so first try the conventional path then fall back
        // to a recursive search for any <contractName>.json.
        let artifactPath = `${outDir}/${name}.sol/${name}.json`;
        if (!existsSync(artifactPath)) {
          const { stdout: found } = await sh("find", [outDir, "-name", `${name}.json`, "-type", "f"]);
          const candidates = found.split("\n").map(s => s.trim()).filter(Boolean);
          if (candidates.length === 0) {
            const { stdout: ls } = await sh("find", [outDir, "-name", "*.json", "-type", "f"]);
            return { content: [{ type: "text" as const, text: `Contract "${name}" not found in output.\n\nAvailable artifacts:\n${ls}\n\nBuild output:\n${stdout}` }], isError: true };
          }
          artifactPath = candidates[0];
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
    `Compile and deploy a Solidity contract in one step using Foundry's forge create. Compiles the source, deploys to the ETO chain, and returns the contract address. This is the fastest way to get a Solidity contract on-chain.`,
    {
      source: z.string().describe("Solidity source code"),
      contract_name: z.string().optional().describe("Contract name to deploy"),
      constructor_args: z.array(z.string()).optional().describe("Constructor arguments"),
      value: z.string().default("0").optional().describe("ETH value to send with deployment"),
    },
    async ({ source, contract_name, constructor_args }) => {
      try {
        if (contract_name && !SAFE_NAME.test(contract_name)) {
          return { content: [{ type: "text" as const, text: `Invalid contract_name: must match ${SAFE_NAME}` }], isError: true };
        }

        mkdirSync(`${WORK_DIR}/src`, { recursive: true });
        writeFileSync(`${WORK_DIR}/src/Contract.sol`, source);
        writeFileSync(`${WORK_DIR}/foundry.toml`, `[profile.default]\nsrc = "src"\nout = "out"\n`);

        const name = contract_name || source.match(/contract\s+(\w+)/)?.[1] || "Contract";
        const rpcUrl = config.etoRpcUrl;

        const args = [
          "create",
          `src/Contract.sol:${name}`,
          "--rpc-url", rpcUrl,
          "--unlocked",
          "--from", "0x0000000000000000000000000000000000000000",
        ];
        if (constructor_args && constructor_args.length > 0) {
          args.push("--constructor-args", ...constructor_args);
        }

        const { stdout, stderr } = await sh("forge", args);

        // Parse deployed address from forge output
        const addrMatch = stdout.match(/Deployed to:\s*(0x[0-9a-fA-F]+)/);
        const txMatch = stdout.match(/Transaction hash:\s*(0x[0-9a-fA-F]+)/);

        const lines = [
          addrMatch ? `Contract deployed!` : `Deployment submitted`,
          ``,
          addrMatch ? `Address: ${addrMatch[1]}` : "",
          txMatch ? `Tx Hash: ${txMatch[1]}` : "",
          ``,
          `Output:`,
          stdout.slice(0, 500),
          stderr ? `\nStderr:\n${stderr.slice(0, 200)}` : "",
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Forge create error: ${err?.message ?? String(err)}` }], isError: true };
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
