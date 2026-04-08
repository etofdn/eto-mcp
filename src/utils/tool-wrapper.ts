import { log, recordToolStat, logToolCall } from "./logger.js";

/**
 * Wrap a tool handler with automatic timing, logging, and stats recording.
 *
 * Usage in tool files:
 *   import { wrapHandler } from "../utils/tool-wrapper.js";
 *   server.tool("my_tool", desc, schema, wrapHandler("my_tool", async (args) => { ... }));
 */
export function wrapHandler<T extends Record<string, any>>(
  toolName: string,
  handler: (args: T, extra?: any) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>,
): (args: T, extra?: any) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  return async (args: T, extra?: any) => {
    const start = performance.now();
    logToolCall(toolName, args as Record<string, any>);

    try {
      const result = await handler(args, extra);
      const ms = performance.now() - start;
      recordToolStat(toolName, ms, !result.isError);
      log("info", "tool", `${toolName} ${ms.toFixed(0)}ms ${result.isError ? "FAIL" : "OK"}`);
      return result;
    } catch (e: any) {
      const ms = performance.now() - start;
      recordToolStat(toolName, ms, false);
      log("error", "tool", `${toolName} ${ms.toFixed(0)}ms EXCEPTION`, { error: e?.message });
      return {
        content: [{ type: "text" as const, text: `Error: ${e?.message ?? String(e)}` }],
        isError: true,
      };
    }
  };
}
