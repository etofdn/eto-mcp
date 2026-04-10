import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import path from "path";

const WORK_DIR = "/tmp/eto-anchor";
const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

function sh(binary: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd: cwd || WORK_DIR, timeout: 120000 }, (err, stdout, stderr) => {
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

export function registerAnchorTools(server: McpServer): void {
  server.tool(
    "anchor_init",
    `Initialize a new Anchor project for building Solana/SVM programs. Creates a project with the standard Anchor structure (programs/, tests/, Anchor.toml). Requires Anchor CLI to be installed.`,
    {
      name: z.string().describe("Project name (lowercase, no spaces)"),
    },
    async ({ name }) => {
      try {
        if (!SAFE_NAME.test(name)) {
          return { content: [{ type: "text" as const, text: `Invalid project name: must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/` }], isError: true };
        }
        mkdirSync(WORK_DIR, { recursive: true });
        const { stdout, stderr } = await sh("anchor", ["init", name], WORK_DIR);
        return { content: [{ type: "text" as const, text: `Anchor project initialized!\n\nPath: ${WORK_DIR}/${name}\n\n${stdout}${stderr ? `\n${stderr}` : ""}` }] };
      } catch (err: any) {
        if (err.message?.includes("not found") || err.message?.includes("ENOENT")) {
          return { content: [{ type: "text" as const, text: "Anchor CLI not installed. Install with: cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install latest && avm use latest" }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Anchor init error: ${err?.message ?? String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "anchor_build",
    `Build an Anchor program from Rust source code. Compiles the program to BPF bytecode that can be deployed to the ETO SVM. Provide the Rust source for the program's lib.rs.`,
    {
      source: z.string().describe("Rust source code for the Anchor program (lib.rs content)"),
      program_name: z.string().default("my_program").optional().describe("Program name"),
    },
    async ({ source, program_name }) => {
      try {
        const name = program_name || "my_program";
        if (!SAFE_NAME.test(name)) {
          return { content: [{ type: "text" as const, text: `Invalid program_name: must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/` }], isError: true };
        }

        const projectDir = path.resolve(WORK_DIR, name);
        // Guard path traversal: ensure projectDir is under WORK_DIR
        if (!projectDir.startsWith(WORK_DIR + path.sep) && projectDir !== WORK_DIR) {
          return { content: [{ type: "text" as const, text: `Invalid program_name: path traversal detected` }], isError: true };
        }

        // Check if anchor is available
        try {
          await sh("anchor", ["--version"]);
        } catch {
          return { content: [{ type: "text" as const, text: "Anchor CLI not installed. Install with:\ncargo install --git https://github.com/coral-xyz/anchor avm --locked\navm install latest\navm use latest" }], isError: true };
        }

        // Init project if doesn't exist
        if (!existsSync(projectDir)) {
          await sh("anchor", ["init", name], WORK_DIR);
        }

        // Write source
        const libPath = `${projectDir}/programs/${name}/src/lib.rs`;
        mkdirSync(`${projectDir}/programs/${name}/src`, { recursive: true });
        writeFileSync(libPath, source);

        // Build
        const { stdout, stderr } = await sh("anchor", ["build"], projectDir);

        // Check for compiled .so file
        const soPath = `${projectDir}/target/deploy/${name}.so`;
        if (existsSync(soPath)) {
          const soBytes = readFileSync(soPath);
          const b64 = soBytes.toString("base64");
          return {
            content: [{
              type: "text" as const,
              text: [
                `Anchor build successful!`,
                ``,
                `Program: ${name}`,
                `Binary: ${soBytes.length} bytes`,
                `Path: ${soPath}`,
                ``,
                `Deploy with: deploy_svm_program(program_binary: "${b64.slice(0, 50)}...")`,
                ``,
                `Build output:`,
                stdout.slice(0, 300),
              ].join("\n"),
            }],
          };
        }

        return { content: [{ type: "text" as const, text: `Build output:\n${stdout}\n${stderr}\n\nNo .so file found — build may have failed.` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Anchor build error: ${err?.message ?? String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "anchor_test",
    `Run tests for an Anchor program. Executes the test suite against a local validator. Provide the test file content (TypeScript/JavaScript).`,
    {
      program_name: z.string().describe("Name of the Anchor project to test"),
      test_source: z.string().optional().describe("Test file source code (TypeScript). If omitted, runs existing tests."),
    },
    async ({ program_name, test_source }) => {
      try {
        if (!SAFE_NAME.test(program_name)) {
          return { content: [{ type: "text" as const, text: `Invalid program_name: must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/` }], isError: true };
        }

        const projectDir = path.resolve(WORK_DIR, program_name);
        // Guard path traversal
        if (!projectDir.startsWith(WORK_DIR + path.sep) && projectDir !== WORK_DIR) {
          return { content: [{ type: "text" as const, text: `Invalid program_name: path traversal detected` }], isError: true };
        }

        if (!existsSync(projectDir)) {
          return { content: [{ type: "text" as const, text: `Project not found at ${projectDir}. Use anchor_init first.` }], isError: true };
        }

        if (test_source) {
          writeFileSync(`${projectDir}/tests/${program_name}.ts`, test_source);
        }

        const { stdout, stderr } = await sh("anchor", ["test", "--skip-local-validator"], projectDir);
        return { content: [{ type: "text" as const, text: `Test results:\n${stdout}${stderr ? `\n${stderr}` : ""}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Anchor test error: ${err?.message ?? String(err)}` }], isError: true };
      }
    }
  );
}
