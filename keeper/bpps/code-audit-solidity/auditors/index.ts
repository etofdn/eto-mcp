/**
 * Audit orchestrator for the `code:audit:solidity` BPP (FN-076).
 *
 * Composes the static-tool auditor (slither/mythril) and the LLM
 * auditor into a single `runAudit(files, opts, deps)` call that:
 *
 *  1. Runs the static auditor (no-ops when neither tool is on PATH).
 *  2. ALWAYS runs the LLM auditor (it provides the narrative and a
 *     severity ranking even when static tools fired).
 *  3. Merges findings, deduping on `(file, line, title)` and keeping
 *     the higher-severity entry.
 *  4. Filters by `severityFloor`.
 *  5. Renders a Markdown report (title, summary, tools-run line,
 *     severity-grouped finding list).
 *  6. Returns `AuditReport` + the rendered markdown.
 */

import {
  SEVERITY_RANK,
  type AuditFinding,
  type AuditInputFile,
  type AuditReport,
  type AuditSource,
  type Severity,
} from "../types.js";
import type { LlmClient } from "./llm.js";
import type { StaticAuditorResult } from "./static.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface RunAuditOpts {
  readonly severityFloor: Severity;
  readonly modelId: string;
  readonly solcVersion?: string;
}

export interface RunAuditDeps {
  readonly staticAuditor: (
    files: readonly AuditInputFile[],
  ) => Promise<StaticAuditorResult>;
  readonly llm: LlmClient;
  readonly now: () => number;
}

export interface RunAuditResult {
  readonly report: AuditReport;
  readonly markdown: string;
}

/* -------------------------------------------------------------------------- */
/* runAudit                                                                   */
/* -------------------------------------------------------------------------- */

export async function runAudit(
  files: readonly AuditInputFile[],
  opts: RunAuditOpts,
  deps: RunAuditDeps,
): Promise<RunAuditResult> {
  const staticResult = await deps.staticAuditor(files);
  const llmResult = await deps.llm.audit({
    files,
    severityFloor: opts.severityFloor,
    modelId: opts.modelId,
    ...(opts.solcVersion !== undefined ? { solcVersion: opts.solcVersion } : {}),
  });

  const merged = mergeFindings([
    ...staticResult.findings,
    ...llmResult.findings,
  ]);
  const filtered = merged.filter(
    (f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[opts.severityFloor],
  );
  const sorted = [...filtered].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  const toolsRun: AuditSource[] = [...staticResult.toolsRun, "llm"];
  const summary = llmResult.summary || "(no summary)";

  const markdown = renderMarkdown({
    title: "Solidity Audit",
    summary,
    toolsRun,
    findings: sorted,
    modelId: opts.modelId,
  });

  const report: AuditReport = {
    summary,
    findings: sorted,
    toolsRun,
    modelId: opts.modelId,
  };

  return { report, markdown };
}

/* -------------------------------------------------------------------------- */
/* Merge / dedupe                                                             */
/* -------------------------------------------------------------------------- */

function dedupeKey(f: AuditFinding): string {
  return `${f.file}|${f.line ?? ""}|${f.title.toLowerCase()}`;
}

export function mergeFindings(all: readonly AuditFinding[]): AuditFinding[] {
  const byKey = new Map<string, AuditFinding>();
  for (const f of all) {
    const key = dedupeKey(f);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
      continue;
    }
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
      byKey.set(key, f);
    }
  }
  return Array.from(byKey.values());
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering                                                         */
/* -------------------------------------------------------------------------- */

interface RenderArgs {
  readonly title: string;
  readonly summary: string;
  readonly toolsRun: readonly AuditSource[];
  readonly findings: readonly AuditFinding[];
  readonly modelId: string;
}

export function renderMarkdown(args: RenderArgs): string {
  const lines: string[] = [];
  lines.push(`# ${args.title}`);
  lines.push("");
  lines.push(`**Tools run:** ${args.toolsRun.join(", ")}  `);
  lines.push(`**Model:** ${args.modelId}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(args.summary);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (args.findings.length === 0) {
    lines.push("_No findings at or above the requested severity floor._");
    lines.push("");
    return lines.join("\n");
  }
  for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
    const group = args.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`### ${sev.toUpperCase()}`);
    lines.push("");
    for (const f of group) {
      lines.push(`#### ${f.title}`);
      lines.push("");
      lines.push(`- **file:** \`${f.file}${f.line !== undefined ? `:${f.line}` : ""}\``);
      lines.push(`- **severity:** ${f.severity}`);
      lines.push(`- **source:** ${f.source}`);
      lines.push(`- **description:** ${f.description}`);
      lines.push(`- **recommendation:** ${f.recommendation}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
