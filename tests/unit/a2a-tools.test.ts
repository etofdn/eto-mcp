import { describe, test, expect, vi } from "vitest";

// src/config.ts has pre-existing duplicate top-level exports (config / ISSUER_URL
// / PROGRAM_IDS each declared multiple times) that esbuild refuses to parse.
// That file is outside the scope of this task; we mock it so this test can
// exercise the send_a2a_message handler without pulling the broken module.
vi.mock("../../src/config.js", () => ({
  PROGRAM_IDS: {
    mcp: new Uint8Array(32),
    agent: new Uint8Array(32),
    swarm: new Uint8Array(32),
    a2a: new Uint8Array(32),
    zkBn254: new Uint8Array(32),
    zkVerify: new Uint8Array(32),
  },
  ISSUER_URL: "http://localhost:0",
  config: {},
}));

const { registerA2ATools } = await import("../../src/tools/a2a.js");

// Minimal McpServer-shaped stub: captures registered tools so we can invoke
// their handlers directly without booting a real MCP transport.
type ToolEntry = {
  description: string;
  schema: Record<string, unknown>;
  handler: (args: any) => Promise<any> | any;
};

function makeStubServer() {
  const tools: Record<string, ToolEntry> = {};
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: any) => Promise<any> | any
    ) => {
      tools[name] = { description, schema, handler };
    },
  };
  return { server: server as any, tools };
}

describe("send_a2a_message bridge-pattern response", () => {
  test("returns success (no isError) and contains required sections", async () => {
    const { server, tools } = makeStubServer();
    registerA2ATools(server);

    const tool = tools["send_a2a_message"];
    expect(tool).toBeDefined();
    // Description must no longer claim unavailability.
    expect(tool.description).not.toMatch(/Not yet available/i);
    expect(tool.description).toMatch(/bridge/i);

    const res = await tool.handler({});
    expect(res.isError).not.toBe(true);

    const text: string = res.content[0].text;
    expect(text).toContain("a2a_message");
    expect(text).toContain("transfer_native");
    expect(text).toMatch(/Limitations/);
    // Future replacement reference.
    expect(text).toContain("CreateTask");
    // Should mention SPL Memo size limitation.
    expect(text).toMatch(/566/);
  });

  test("interpolates `to` and `body` into the example", async () => {
    const { server, tools } = makeStubServer();
    registerA2ATools(server);

    const tool = tools["send_a2a_message"];
    const recipient = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const body = { hello: "world", n: 7 };

    const res = await tool.handler({ to: recipient, body });
    expect(res.isError).not.toBe(true);

    const text: string = res.content[0].text;
    expect(text).toContain(recipient);
    // body is JSON-stringified into the memo (which is itself JSON-stringified
    // for the example), so quotes appear escaped in the response text.
    expect(text).toContain('hello');
    expect(text).toContain('world');
    expect(text).toContain('"n\\":7');
  });

  test("falls back to placeholders when `to`/`body` omitted", async () => {
    const { server, tools } = makeStubServer();
    registerA2ATools(server);
    const res = await tools["send_a2a_message"].handler({});
    const text: string = res.content[0].text;
    expect(text).toContain("<recipient_svm_address>");
    expect(text).toContain("<your json body>");
  });

  test("accepts legacy params (channel_id, message, priority) without throwing", async () => {
    const { server, tools } = makeStubServer();
    registerA2ATools(server);
    const res = await tools["send_a2a_message"].handler({
      channel_id: "legacy",
      message: { foo: 1 },
      priority: "high",
    });
    expect(res.isError).not.toBe(true);
  });
});
