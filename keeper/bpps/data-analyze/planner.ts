/**
 * Analysis planner for the `data:analyze` BPP (FN-201).
 *
 * Sits between the profiler and the artifact-rendering layer. The
 * planner asks an LLM to produce an `AnalysisReport` from the
 * `DatasetProfile` + bounded `DatasetSample`, validates the response
 * with Zod BEFORE any downstream signing, and throws phase-tagged
 * errors (`data-analyze:planner:<code>`) so the handler / runtime
 * can route them onto stable failure reasons.
 *
 * Two public surfaces:
 *
 *   - `runPlanner` — the strict path. Throws on LLM timeout, on
 *     parse failure, or on schema-invalid output. Never returns a
 *     raw `JSON.parse` result.
 *
 *   - `fallbackReport` — synthesises a minimal, schema-valid
 *     `AnalysisReport` locally from the profiler output. Used by
 *     callers that want to keep producing an artifact when the LLM
 *     leg fails (idempotent retries, offline mode).
 *
 * The planner does NOT touch the wire on its own — every seam is
 * injected so tests cover happy, timeout, malformed-JSON, and
 * schema-invalid branches without external network.
 */

import {
  zAnalysisReport,
  type AnalysisReport,
  type ColumnProfile,
  type DatasetProfile,
} from "./types.js";
import type { ColumnFlags, DatasetSample } from "./profiler.js";

/* -------------------------------------------------------------------------- */
/* Phase tag                                                                  */
/* -------------------------------------------------------------------------- */

/** Prefix for every error thrown by this module. */
export const PLANNER_PHASE = "data-analyze:planner";

/** Stable error codes the planner emits (suffixes after `PLANNER_PHASE:`). */
export const PLANNER_ERROR_CODES = [
  "llm-timeout",
  "llm-error",
  "invalid-response",
  "empty-response",
  "schema-invalid",
] as const;
export type PlannerErrorCode = (typeof PLANNER_ERROR_CODES)[number];

/** Construct a phase-tagged error message: `data-analyze:planner:<code>`. */
export function plannerError(code: PlannerErrorCode, detail?: string): Error {
  const base = `${PLANNER_PHASE}:${code}`;
  return new Error(detail ? `${base}: ${detail}` : base);
}

/** Check whether an error's message comes from the planner. */
export function isPlannerError(err: unknown): boolean {
  const m = (err as Error)?.message;
  return typeof m === "string" && m.startsWith(`${PLANNER_PHASE}:`);
}

/* -------------------------------------------------------------------------- */
/* LlmClient seam                                                             */
/* -------------------------------------------------------------------------- */

export interface PlannerLlmRequest {
  readonly profile: DatasetProfile;
  readonly sample: DatasetSample;
  readonly question?: string;
  readonly modelId: string;
  readonly signal?: AbortSignal;
}

/**
 * Minimal LLM seam — production wires this to `@anthropic-ai/sdk`
 * (see `analyzer.ts::AnthropicLlmClient`). Tests inject a fake.
 *
 * Throwing an `AbortError`-like (or a plain `Error("llm_timeout")`)
 * is interpreted by `runPlanner` as a timeout.
 */
export interface PlannerLlmClient {
  /** Returns the raw model text. The planner parses + validates it. */
  complete(req: PlannerLlmRequest): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* runPlanner                                                                 */
/* -------------------------------------------------------------------------- */

export interface RunPlannerOpts {
  readonly modelId: string;
  readonly question?: string;
  /** Wall-clock millis. Default 60_000. `0` ⇒ no timeout. */
  readonly timeoutMs?: number;
}

export interface RunPlannerDeps {
  readonly llm: PlannerLlmClient;
}

/**
 * Ask the LLM to produce an `AnalysisReport` and validate the result
 * against `zAnalysisReport` BEFORE returning. Errors thrown from this
 * function carry the phase prefix `data-analyze:planner:`.
 */
export async function runPlanner(
  profile: DatasetProfile,
  sample: DatasetSample,
  opts: RunPlannerOpts,
  deps: RunPlannerDeps,
): Promise<AnalysisReport> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => ctrl.abort(new Error("planner_timeout")), timeoutMs)
      : null;

  let raw: string;
  try {
    raw = await deps.llm.complete({
      profile,
      sample,
      modelId: opts.modelId,
      ...(opts.question !== undefined ? { question: opts.question } : {}),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (isAbortLike(err) || ctrl.signal.aborted) {
      throw plannerError("llm-timeout", `${timeoutMs}ms`);
    }
    throw plannerError("llm-error", (err as Error)?.message ?? String(err));
  }
  if (timer) clearTimeout(timer);

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw plannerError("empty-response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(trimmed));
  } catch (err) {
    throw plannerError("invalid-response", (err as Error).message);
  }

  // CRITICAL: validate via Zod before any downstream signing.
  const result = zAnalysisReport.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path?.join(".") ?? "<root>";
    throw plannerError("schema-invalid", `${where}: ${issue?.message ?? "?"}`);
  }
  return result.data as AnalysisReport;
}

/* -------------------------------------------------------------------------- */
/* fallbackReport                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Synthesise a minimal, schema-valid `AnalysisReport` locally from
 * the profiler output. Used by callers that want a graceful fallback
 * when `runPlanner` throws.
 */
export function fallbackReport(
  profile: DatasetProfile,
  columnFlags: readonly ColumnFlags[] = [],
  question?: string,
): AnalysisReport {
  const summary =
    `Profiled ${profile.rowCount} row(s) × ${profile.columnCount} column(s). ` +
    "LLM analysis unavailable; report synthesised from local profiler.";
  const findings = profile.columns.slice(0, 8).map(describeColumn);
  const anomalies = collectAnomalies(profile.columns, columnFlags);
  const suggestedQuestions = makeSuggestedQuestions(profile.columns);
  const out: AnalysisReport = question !== undefined
    ? {
        summary,
        findings,
        anomalies,
        suggestedQuestions,
        answer: "(planner unavailable — no answer synthesised)",
      }
    : { summary, findings, anomalies, suggestedQuestions };
  return out;
}

function describeColumn(c: ColumnProfile): string {
  const parts: string[] = [`Column \`${c.name}\` is ${c.inferredType}`];
  if (c.distinctCount > 0) parts.push(`${c.distinctCount} distinct value(s)`);
  if (c.nullCount > 0) parts.push(`${c.nullCount} null(s)`);
  if (c.mean !== undefined) parts.push(`mean=${c.mean.toFixed(2)}`);
  return parts.join("; ") + ".";
}

function collectAnomalies(
  columns: readonly ColumnProfile[],
  flags: readonly ColumnFlags[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    const c = columns[i];
    if (!c) continue;
    if (f.constant) out.push(`Column \`${c.name}\` is constant.`);
    if (f.allDistinct)
      out.push(`Column \`${c.name}\` is all-distinct (likely an id).`);
    if (f.highNullRate)
      out.push(`Column \`${c.name}\` has a null rate above 30%.`);
    if (f.monotonic)
      out.push(`Column \`${c.name}\` is monotonic — possible row index.`);
    if (f.outlierHeavy)
      out.push(`Column \`${c.name}\` has > 5% IQR outliers.`);
  }
  return out;
}

function makeSuggestedQuestions(columns: readonly ColumnProfile[]): string[] {
  const numeric = columns.filter(
    (c) => c.inferredType === "integer" || c.inferredType === "number",
  );
  const out: string[] = [];
  if (numeric[0]) out.push(`What is the distribution of \`${numeric[0].name}\`?`);
  if (numeric[1])
    out.push(
      `Is \`${numeric[0]?.name ?? "?"}\` correlated with \`${numeric[1].name}\`?`,
    );
  out.push("Which columns have the highest null rate?");
  return out.slice(0, 6);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function isAbortLike(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /aborted|timeout/i.test(e.message ?? "");
}

/**
 * Pull the first balanced `{...}` JSON object from a string. Lets the
 * parser tolerate models that wrap their output in code fences or
 * prose without us relying on `response_format` knobs.
 */
function extractJsonObject(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) return s;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}
