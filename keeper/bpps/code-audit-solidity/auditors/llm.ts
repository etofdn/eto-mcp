/**
 * LLM-driven Solidity audit (FN-076).
 *
 * Defines the `LlmClient` audit seam used by the orchestrator; ships
 * an `AnthropicLlmAuditClient` that talks to the same structural
 * `AnthropicLike` surface that `bpps/text-summarize/summarizer.ts`
 * uses (deliberately NOT a static import on `@anthropic-ai/sdk` so
 * the keeper tree compiles whether or not the SDK is installed).
 *
 *   // keep in sync with FN-075
 *
 * Tests inject a fake `LlmClient` and assert the canned response is
 * threaded through the orchestrator unchanged.
 */

import { z } from "zod";
import {
  zAuditFinding,
  type AuditFinding,
  type AuditInputFile,
  type Severity,
} from "../types.js";

/* -------------------------------------------------------------------------- */
/* LlmClient seam                                                             */
/* -------------------------------------------------------------------------- */

export interface LlmAuditRequest {
  readonly files: readonly AuditInputFile[];
  readonly severityFloor: Severity;
  readonly modelId: string;
  /** Advisory only — passed to the prompt for context. */
  readonly solcVersion?: string;
}

export interface LlmAuditResult {
  readonly findings: readonly AuditFinding[];
  readonly summary: string;
  readonly markdown: string;
}

export interface LlmClient {
  audit(req: LlmAuditRequest): Promise<LlmAuditResult>;
}

/* -------------------------------------------------------------------------- */
/* AnthropicLlmAuditClient                                                    */
/* -------------------------------------------------------------------------- */

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
  "You are a senior Solidity security auditor.",
  "Given one or more Solidity source files, produce a security audit.",
  "",
  "Output strict Markdown with this exact structure:",
  "  1. A first line beginning with `# ` containing a concise audit title.",
  "  2. A `## Summary` section: 1–3 short paragraphs.",
  "  3. A `## Findings` section: one `### ` heading per finding,",
  "     each followed by `- file: <path>:<line>`,",
  "     `- severity: <info|low|medium|high|critical>`,",
  "     `- description: …`, `- recommendation: …`.",
  "  4. After the Markdown, append a fenced JSON block with",
  "     `{ \"findings\": [<finding>], \"summary\": \"…\" }` where each",
  "     finding has the exact fields:",
  "       id, title, severity, file, line?, description, recommendation, source",
  "     and source MUST be the literal string \"llm\".",
  "Severities are limited to info/low/medium/high/critical.",
  "Do not invent line numbers — omit `line` if you are uncertain.",
].join("\n");

const zLlmJsonBlock = z
  .object({
    findings: z.array(zAuditFinding),
    summary: z.string(),
  })
  .strict();

export class AnthropicLlmAuditClient implements LlmClient {
  public constructor(private readonly client: AnthropicLike) {}

  public async audit(req: LlmAuditRequest): Promise<LlmAuditResult> {
    const userPrompt = buildUserPrompt(req);
    const resp = await this.client.messages.create({
      model: req.modelId,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
      .trim();
    return parseLlmAuditOutput(text);
  }
}

function buildUserPrompt(req: LlmAuditRequest): string {
  const lines: string[] = [];
  lines.push(`Severity floor: ${req.severityFloor}.`);
  if (req.solcVersion) {
    lines.push(`Declared solc version (advisory): ${req.solcVersion}.`);
  }
  lines.push("");
  for (const f of req.files) {
    lines.push(`--- BEGIN ${f.path} ---`);
    lines.push(f.content);
    lines.push(`--- END ${f.path} ---`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Parse an LLM response into `LlmAuditResult`. The expected shape is
 * the SYSTEM_PROMPT contract above; on parse failure we return an
 * empty findings list plus a single `info`-severity flag so the
 * downstream pipeline records the unparsable output rather than
 * silently dropping it.
 */
export function parseLlmAuditOutput(markdown: string): LlmAuditResult {
  const fence = markdown.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!fence) {
    return makeUnparsableResult(markdown, "no JSON block in LLM output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]!);
  } catch (err) {
    return makeUnparsableResult(markdown, (err as Error).message);
  }
  const r = zLlmJsonBlock.safeParse(parsed);
  if (!r.success) {
    return makeUnparsableResult(markdown, r.error.issues[0]?.message ?? "schema");
  }
  // Reshape findings to satisfy exactOptionalPropertyTypes: omit `line`
  // when undefined rather than emitting `line: undefined`.
  const findings: AuditFinding[] = r.data.findings.map((f) => {
    const base = {
      id: f.id,
      title: f.title,
      severity: f.severity,
      file: f.file,
      description: f.description,
      recommendation: f.recommendation,
      source: f.source,
    } as const;
    return f.line !== undefined ? { ...base, line: f.line } : base;
  });
  return { findings, summary: r.data.summary, markdown };
}

function makeUnparsableResult(markdown: string, why: string): LlmAuditResult {
  const flag: AuditFinding = {
    id: "llm-unparsable-output",
    title: "LLM audit output unparsable",
    severity: "info",
    file: "<llm>",
    description: `LLM audit output could not be parsed (${why}).`,
    recommendation: "Re-run the audit; consider lowering severity floor.",
    source: "llm",
  };
  return {
    findings: [flag],
    summary: "<llm output unparsable>",
    markdown: markdown || "# Audit\n\n(no LLM output)",
  };
}
