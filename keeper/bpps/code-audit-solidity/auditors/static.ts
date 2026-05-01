/**
 * Static-tool auditor wrapper for the `code:audit:solidity` BPP
 * (FN-076).
 *
 * Detects `slither` / `mythril` on `$PATH` via the injected `which`
 * seam. When available, writes the input files to a temp dir, spawns
 * the tool with `--json`-style output, enforces a 120s per-tool
 * timeout, and parses the JSON into `AuditFinding[]`.
 *
 * The wrapper NEVER throws: tool failures (spawn error, non-zero exit
 * with no JSON, parse failure, timeout) are logged via the injected
 * `logger` and the tool is silently skipped. This keeps the LLM-only
 * fallback path live even when the operator's slither install is
 * broken.
 *
 * `slither` / `mythril` are NOT runtime dependencies — they are
 * external Python tools the operator installs separately.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { AuditFinding, AuditInputFile, Severity } from "../types.js";

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

export interface SpawnLike {
  (
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; timeoutMs: number },
  ): Promise<SpawnResult>;
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True iff the run was killed because it exceeded the timeout. */
  readonly timedOut: boolean;
}

export type WhichLike = (cmd: string) => Promise<string | null>;

export interface StaticLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

const NULL_LOGGER: StaticLogger = { warn: () => undefined };

export interface StaticAuditorDeps {
  readonly spawn: SpawnLike;
  readonly which: WhichLike;
  /** Per-tool wall-clock budget in ms. Default 120s. */
  readonly perToolTimeoutMs?: number;
  /** Override for the temp dir prefix. */
  readonly tmpDir?: string;
  readonly logger?: StaticLogger;
}

export interface StaticAuditorResult {
  readonly available: boolean;
  readonly findings: readonly AuditFinding[];
  readonly toolsRun: ReadonlyArray<"slither" | "mythril">;
}

const DEFAULT_PER_TOOL_TIMEOUT_MS = 120_000;

/* -------------------------------------------------------------------------- */
/* runStaticAuditor                                                           */
/* -------------------------------------------------------------------------- */

export async function runStaticAuditor(
  files: readonly AuditInputFile[],
  deps: StaticAuditorDeps,
): Promise<StaticAuditorResult> {
  const logger = deps.logger ?? NULL_LOGGER;
  const slitherBin = await safeWhich(deps.which, "slither", logger);
  const mythrilBin = await safeWhich(deps.which, "myth", logger);

  if (slitherBin === null && mythrilBin === null) {
    return { available: false, findings: [], toolsRun: [] };
  }

  const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "eto-audit-"));
  try {
    const writtenPaths: string[] = [];
    for (const f of files) {
      const abs = join(dir, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
      writtenPaths.push(f.path);
    }

    const findings: AuditFinding[] = [];
    const toolsRun: Array<"slither" | "mythril"> = [];
    const timeoutMs = deps.perToolTimeoutMs ?? DEFAULT_PER_TOOL_TIMEOUT_MS;

    if (slitherBin !== null) {
      const out = await runOne(
        deps.spawn,
        slitherBin,
        ["--json", "-", ...writtenPaths],
        dir,
        timeoutMs,
        logger,
        "slither",
      );
      if (out !== null) {
        toolsRun.push("slither");
        findings.push(...parseSlither(out, logger));
      }
    }
    if (mythrilBin !== null) {
      const out = await runOne(
        deps.spawn,
        mythrilBin,
        ["analyze", "-o", "json", ...writtenPaths],
        dir,
        timeoutMs,
        logger,
        "mythril",
      );
      if (out !== null) {
        toolsRun.push("mythril");
        findings.push(...parseMythril(out, logger));
      }
    }

    return { available: true, findings, toolsRun };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function safeWhich(
  which: WhichLike,
  cmd: string,
  logger: StaticLogger,
): Promise<string | null> {
  try {
    return await which(cmd);
  } catch (err) {
    logger.warn("which failed", { cmd, error: (err as Error).message });
    return null;
  }
}

async function runOne(
  spawn: SpawnLike,
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  logger: StaticLogger,
  tool: "slither" | "mythril",
): Promise<string | null> {
  let res: SpawnResult;
  try {
    res = await spawn(cmd, args, { cwd, timeoutMs });
  } catch (err) {
    logger.warn("static auditor spawn failed", {
      tool,
      error: (err as Error).message,
    });
    return null;
  }
  if (res.timedOut) {
    logger.warn("static auditor timed out", { tool, timeoutMs });
    return null;
  }
  if (res.stdout.trim().length === 0) {
    logger.warn("static auditor produced no stdout", {
      tool,
      exitCode: res.exitCode,
      stderr: res.stderr.slice(0, 256),
    });
    return null;
  }
  return res.stdout;
}

interface SlitherJson {
  results?: { detectors?: SlitherDetector[] };
}
interface SlitherDetector {
  check?: string;
  impact?: string;
  description?: string;
  markdown?: string;
  elements?: Array<{
    source_mapping?: { filename_relative?: string; lines?: number[] };
  }>;
}

function parseSlither(stdout: string, logger: StaticLogger): AuditFinding[] {
  let data: SlitherJson;
  try {
    data = JSON.parse(stdout) as SlitherJson;
  } catch (err) {
    logger.warn("slither json parse failed", { error: (err as Error).message });
    return [];
  }
  const detectors = data.results?.detectors ?? [];
  const out: AuditFinding[] = [];
  let i = 0;
  for (const d of detectors) {
    const elem = d.elements?.[0];
    const file = elem?.source_mapping?.filename_relative ?? "<unknown>";
    const line = elem?.source_mapping?.lines?.[0];
    const finding: AuditFinding = {
      id: `slither-${i++}-${(d.check ?? "issue").slice(0, 32)}`,
      title: d.check ?? "slither issue",
      severity: mapSlitherImpact(d.impact),
      file,
      ...(line !== undefined ? { line } : {}),
      description: (d.description ?? d.markdown ?? "").slice(0, 4096) || "(no description)",
      recommendation: "Review the slither finding.",
      source: "slither",
    };
    out.push(finding);
  }
  return out;
}

function mapSlitherImpact(s: string | undefined): Severity {
  switch ((s ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "informational":
    case "info":
      return "info";
    default:
      return "low";
  }
}

interface MythrilJson {
  issues?: MythrilIssue[];
}
interface MythrilIssue {
  swc_id?: string;
  title?: string;
  severity?: string;
  description?: string;
  filename?: string;
  lineno?: number;
}

function parseMythril(stdout: string, logger: StaticLogger): AuditFinding[] {
  let data: MythrilJson;
  try {
    data = JSON.parse(stdout) as MythrilJson;
  } catch (err) {
    logger.warn("mythril json parse failed", { error: (err as Error).message });
    return [];
  }
  const issues = data.issues ?? [];
  const out: AuditFinding[] = [];
  let i = 0;
  for (const it of issues) {
    const finding: AuditFinding = {
      id: `mythril-${i++}-${(it.swc_id ?? it.title ?? "issue").slice(0, 32)}`,
      title: it.title ?? `SWC-${it.swc_id ?? "?"}`,
      severity: mapMythrilSeverity(it.severity),
      file: it.filename ?? "<unknown>",
      ...(it.lineno !== undefined ? { line: it.lineno } : {}),
      description: (it.description ?? "").slice(0, 4096) || "(no description)",
      recommendation: "Review the mythril finding.",
      source: "mythril",
    };
    out.push(finding);
  }
  return out;
}

function mapMythrilSeverity(s: string | undefined): Severity {
  switch ((s ?? "").toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "informational":
    case "info":
      return "info";
    case "critical":
      return "critical";
    default:
      return "low";
  }
}
