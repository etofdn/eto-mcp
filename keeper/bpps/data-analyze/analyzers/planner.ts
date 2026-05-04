/**
 * Anthropic-backed analyser for the `data:analyze` BPP (FN-079).
 *
 * Production wires `LlmClient` to `@anthropic-ai/sdk` (resolved
 * structurally so this file does NOT take a static import on the SDK
 * — keeps `keeper/` runnable without it). Tests inject a fake
 * `LlmClient` whose canned `AnalysisReport` we then assert against.
 *
 * The LLM only ever sees the structured `DatasetProfile` plus a
 * bounded `sample` (head + random) — never the raw CSV body. This is
 * a privacy + cost guardrail: callers can submit datasets that exceed
 * the model's context window, and the BPP will still produce a
 * meaningful narrative without leaking unbounded raw rows.
 */

import { createHash } from "node:crypto";
import type { DatasetProfile, AnalysisReport, ColumnProfile } from "../types.js";
import { zAnalysisReport } from "../types.js";
import type { ColumnFlags, DatasetSample } from "./profiler.js";

/* -------------------------------------------------------------------------- */
/* LlmClient seam                                                             */
/* -------------------------------------------------------------------------- */

export interface LlmRequest {
  readonly profile: DatasetProfile;
  readonly sample: DatasetSample;
  readonly question?: string;
  readonly modelId: string;
}

export interface LlmClient {
  analyze(req: LlmRequest): Promise<AnalysisReport>;
}

/* -------------------------------------------------------------------------- */
/* Anthropic adapter                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Structural shape we require from an Anthropic SDK client. Captured
 * here (instead of importing `@anthropic-ai/sdk` types) so this file
 * compiles whether or not the SDK is installed.
 */
export interface AnthropicLike {
  readonly messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: ReadonlyArray<{ role: "user"; content: string }>;
    }): Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

const SYSTEM_PROMPT = [
  "You are a precise data analyst.",
  "You are given a `DatasetProfile` (column types, summary statistics,",
  "anomaly flags) and a small `sample` (column names + head + random",
  "rows). You may also be given an optional focus `question`.",
  "",
  "Reply with STRICT JSON matching this TypeScript interface and no",
  "surrounding prose:",
  "",
  "  interface AnalysisReport {",
  "    summary: string;            // 2–4 sentences",
  "    findings: string[];         // 3–8 specific observations",
  "    anomalies: string[];        // 0–8 quality / shape concerns",
  "    suggestedQuestions: string[]; // 3–6 next-step questions",
  "    answer?: string;            // ≤ 200 words, only if `question` set",
  "  }",
  "",
  "Cite specific column names. Do not invent statistics — quote only",
  "values present in the profile. Do not output the sample verbatim.",
].join("\n");

export class AnthropicLlmClient implements LlmClient {
  public constructor(private readonly client: AnthropicLike) {}

  public async analyze(req: LlmRequest): Promise<AnalysisReport> {
    const userPrompt = buildUserPrompt(req);

    const resp = await this.client.messages.create({
      model: req.modelId,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = resp.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
      .trim();

    if (text.length === 0) throw new Error("data-analyze:planner:llm-invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      throw new Error("data-analyze:planner:llm-invalid");
    }
    const result = zAnalysisReport.safeParse(parsed);
    if (!result.success) throw new Error("data-analyze:planner:llm-invalid");
    return result.data as AnalysisReport;
  }
}

function buildUserPrompt(req: LlmRequest): string {
  const lines: string[] = [];
  lines.push("# DatasetProfile");
  lines.push(JSON.stringify(req.profile, null, 2));
  lines.push("");
  lines.push("# Sample");
  lines.push(JSON.stringify(req.sample, null, 2));
  if (req.question) {
    lines.push("");
    lines.push("# Question");
    lines.push(req.question);
  }
  lines.push("");
  lines.push("Reply with strict JSON only.");
  return lines.join("\n");
}

/**
 * Extract the first balanced `{...}` JSON object from a string. Lets
 * the parser tolerate models that wrap their output in code fences or
 * prose without us having to instruct them with `response_format`.
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

/* -------------------------------------------------------------------------- */
/* analyze                                                                    */
/* -------------------------------------------------------------------------- */

export interface AnalyzeOpts {
  readonly modelId: string;
  readonly question?: string;
  /** Per-column anomaly flags from `profileCsv` (used to seed `anomalies`). */
  readonly columnFlags?: readonly ColumnFlags[];
}

export interface AnalyzeDeps {
  readonly llm: LlmClient;
  readonly now?: () => number;
}

export interface AnalyzeResult {
  readonly markdown: string;
  readonly report: AnalysisReport;
}

export async function analyze(
  profile: DatasetProfile,
  sample: DatasetSample,
  opts: AnalyzeOpts,
  deps: AnalyzeDeps,
): Promise<AnalyzeResult> {
  if (profile.columnCount === 0 || profile.rowCount === 0) {
    throw new Error("data-analyze:planner:empty-dataset");
  }

  const llmReq: LlmRequest = {
    profile,
    sample,
    modelId: opts.modelId,
    ...(opts.question !== undefined ? { question: opts.question } : {}),
  };
  let report: AnalysisReport;
  try {
    report = await deps.llm.analyze(llmReq);
  } catch (err) {
    const msg = (err as Error).message;
    if (
      msg.startsWith("data-analyze:planner:llm-invalid") ||
      msg.startsWith("data-analyze:planner:schema-mismatch") ||
      msg.startsWith("data-analyze:planner:llm-timeout")
    ) {
      throw err;
    }
    throw new Error(`data-analyze:planner:llm-invalid: ${msg}`);
  }
  // Defensive re-validate (in case a fake llm returns a malformed shape).
  const reparsed = zAnalysisReport.safeParse(report);
  if (!reparsed.success) throw new Error("data-analyze:planner:schema-mismatch");
  report = reparsed.data as AnalysisReport;

  // Seed additional anomaly bullets from the local profiler flags so
  // the rendered report includes them even when the LLM misses them.
  const seeded = mergeAnomalies(report, profile.columns, opts.columnFlags ?? []);

  const markdown = renderMarkdown(seeded, opts.question);
  return { markdown, report: seeded };
}

function mergeAnomalies(
  report: AnalysisReport,
  columns: readonly ColumnProfile[],
  flags: readonly ColumnFlags[],
): AnalysisReport {
  if (flags.length === 0) return report;
  const extras: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    const c = columns[i];
    if (!c) continue;
    if (f.constant) extras.push(`Column \`${c.name}\` is constant.`);
    else if (f.allDistinct)
      extras.push(`Column \`${c.name}\` is all-distinct (likely an id).`);
    if (f.highNullRate)
      extras.push(`Column \`${c.name}\` has a null rate above 30%.`);
    if (f.monotonic)
      extras.push(`Column \`${c.name}\` is monotonic — possible row index.`);
    if (f.outlierHeavy)
      extras.push(`Column \`${c.name}\` has > 5% IQR outliers.`);
  }
  if (extras.length === 0) return report;
  // Avoid duplicates — only append extras whose text isn't already present.
  const existing = new Set(report.anomalies);
  const merged = [...report.anomalies];
  for (const e of extras) if (!existing.has(e)) merged.push(e);
  return { ...report, anomalies: merged };
}

function renderMarkdown(report: AnalysisReport, question?: string): string {
  const out: string[] = [];
  out.push("# Data Analysis Report");
  out.push("");
  out.push("## Summary");
  out.push(report.summary || "(no summary)");
  out.push("");
  out.push("## Findings");
  for (const f of report.findings) out.push(`- ${f}`);
  if (report.findings.length === 0) out.push("- (none)");
  out.push("");
  out.push("## Anomalies");
  for (const a of report.anomalies) out.push(`- ${a}`);
  if (report.anomalies.length === 0) out.push("- (none)");
  out.push("");
  out.push("## Suggested Questions");
  for (const q of report.suggestedQuestions) out.push(`- ${q}`);
  if (report.suggestedQuestions.length === 0) out.push("- (none)");
  if (question !== undefined) {
    out.push("");
    out.push("## Answer");
    out.push(report.answer ?? "(no answer)");
  }
  return out.join("\n");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
