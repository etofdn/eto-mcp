import { appendFileSync, mkdirSync } from "fs";

const LOG_DIR = process.env.ETO_MCP_LOG_DIR || "/tmp/eto-mcp-logs";
const LOG_FILE = `${LOG_DIR}/mcp.log`;
const PERF_FILE = `${LOG_DIR}/perf.log`;

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = (process.env.LOG_LEVEL || "info") as Level;

function ts(): string {
  return new Date().toISOString();
}

function write(file: string, line: string): void {
  try { appendFileSync(file, line + "\n"); } catch {}
}

export function log(level: Level, component: string, msg: string, data?: Record<string, any>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;
  const extra = data ? " " + JSON.stringify(data) : "";
  const line = `${ts()} [${level.toUpperCase().padEnd(5)}] [${component}] ${msg}${extra}`;
  write(LOG_FILE, line);
  if (level === "error") console.error(line);
}

/** Time a tool call and log performance */
export async function timeTool<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let success = true;
  let error: string | undefined;
  try {
    return await fn();
  } catch (e: any) {
    success = false;
    error = e?.message || String(e);
    throw e;
  } finally {
    const ms = (performance.now() - start).toFixed(1);
    const line = `${ts()} ${toolName.padEnd(30)} ${ms.padStart(8)}ms ${success ? "OK" : "FAIL"}${error ? " " + error : ""}`;
    write(PERF_FILE, line);
    log(success ? "info" : "error", "perf", `${toolName} ${ms}ms`, { success, error });
  }
}

/** Time an RPC call */
export async function timeRpc<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const ms = (performance.now() - start).toFixed(1);
    log("debug", "rpc", `${method} ${ms}ms`);
    return result;
  } catch (e: any) {
    const ms = (performance.now() - start).toFixed(1);
    log("error", "rpc", `${method} ${ms}ms FAIL`, { error: e?.message });
    throw e;
  }
}

/** Log a tool invocation summary */
export function logToolCall(toolName: string, args: Record<string, any>): void {
  const sanitized = { ...args };
  // Redact sensitive fields
  if (sanitized.key_material) sanitized.key_material = "[REDACTED]";
  if (sanitized.secret_key) sanitized.secret_key = "[REDACTED]";
  log("info", "tool", `CALL ${toolName}`, sanitized);
}

/** Periodic stats summary */
const toolStats = new Map<string, { count: number; totalMs: number; errors: number }>();

export function recordToolStat(toolName: string, ms: number, success: boolean): void {
  const existing = toolStats.get(toolName) || { count: 0, totalMs: 0, errors: 0 };
  existing.count++;
  existing.totalMs += ms;
  if (!success) existing.errors++;
  toolStats.set(toolName, existing);
}

export function getToolStats(): string {
  const lines = ["Tool Performance Summary", "═".repeat(70), ""];
  const sorted = Array.from(toolStats.entries()).sort((a, b) => b[1].count - a[1].count);
  lines.push(`${"Tool".padEnd(30)} ${"Calls".padStart(6)} ${"Avg ms".padStart(8)} ${"Errors".padStart(7)}`);
  lines.push("─".repeat(55));
  for (const [name, stats] of sorted) {
    const avg = (stats.totalMs / stats.count).toFixed(1);
    lines.push(`${name.padEnd(30)} ${String(stats.count).padStart(6)} ${avg.padStart(8)} ${String(stats.errors).padStart(7)}`);
  }
  return lines.join("\n");
}

export function dumpStats(): void {
  write(PERF_FILE, "\n" + getToolStats() + "\n");
}
