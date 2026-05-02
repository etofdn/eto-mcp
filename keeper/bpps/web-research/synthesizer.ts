/**
 * Report synthesizer for the `web:research` BPP (FN-077).
 *
 * `synthesize(query, evidence, deps)` calls the injected `LlmClient`
 * with the user query plus per-source extracts (each truncated to a
 * safe budget) and returns a structured Markdown `ResearchReport`
 * plus a typed `Citation[]` aligned to the evidence by URL.
 *
 * The synthesiser is intentionally tolerant of evidence with empty
 * `text` (e.g. unavailable sources) — it instructs the model to mark
 * such sources unavailable rather than refuse to produce a report.
 */

import { createHash } from "node:crypto";
import type { LlmClient } from "./planner.js";
import type { Citation } from "./types.js";
import {
  DEFAULT_TARGET_LENGTH_WORDS,
  MAX_TARGET_LENGTH_WORDS,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-source evidence fed to the synthesiser. `text` may be empty
 * when the fetch failed or returned an unsupported content-type.
 */
export interface EvidenceItem {
  readonly url: string;
  readonly title: string;
  readonly publisher?: string;
  readonly publishedAtSec?: number;
  readonly accessedAtSec: number;
  readonly text: string;
  readonly fetchError?: string;
}

export interface SynthesizeOpts {
  readonly modelId: string;
  readonly targetLengthWords?: number;
}

export interface SynthesizeDeps {
  readonly llm: LlmClient;
}

export interface SynthesizeResult {
  readonly markdown: string;
  readonly citations: Citation[];
}

/** Per-evidence character budget (≈ 500 tokens). Tuned empirically. */
export const PER_EVIDENCE_CHAR_BUDGET = 2000;

/* -------------------------------------------------------------------------- */
/* synthesize                                                                 */
/* -------------------------------------------------------------------------- */

export async function synthesize(
  query: string,
  evidence: readonly EvidenceItem[],
  opts: SynthesizeOpts,
  deps: SynthesizeDeps,
): Promise<SynthesizeResult> {
  if (query.trim().length === 0) {
    throw new Error("empty_query");
  }
  if (evidence.length === 0) {
    throw new Error("no_sources_found");
  }

  const targetLengthWords = clampTargetLength(opts.targetLengthWords);

  // Truncate per-source extracts and keep stable indices.
  const indexed = evidence.map((e, i) => ({
    n: i + 1,
    url: e.url,
    title: e.title,
    publisher: e.publisher,
    publishedAtSec: e.publishedAtSec,
    accessedAtSec: e.accessedAtSec,
    extract: truncate(e.text, PER_EVIDENCE_CHAR_BUDGET),
    fetchError: e.fetchError,
    snippetSha256: sha256Hex(truncate(e.text, PER_EVIDENCE_CHAR_BUDGET)),
  }));

  const system = SYNTHESIZER_SYSTEM;
  const userPrompt = [
    `Research query: ${query}`,
    `Target length: about ${targetLengthWords} words.`,
    "",
    "Sources (cite by [N] index):",
    "",
    ...indexed.map(
      (e) =>
        `[${e.n}] ${e.title} — ${e.url}` +
        (e.fetchError !== undefined
          ? ` (UNAVAILABLE: ${e.fetchError})`
          : "") +
        (e.extract.length > 0 ? `\n${e.extract}` : "\n(no extract)"),
    ),
  ].join("\n");

  let markdown: string;
  try {
    const resp = await deps.llm.complete({
      system,
      messages: [{ role: "user", content: userPrompt }],
      modelId: opts.modelId,
      maxTokens: Math.min(4 * targetLengthWords + 512, 8192),
    });
    markdown = resp.text.trim();
  } catch (err) {
    throw new Error(`synthesis_failed: ${(err as Error).message}`);
  }

  if (markdown.length === 0) {
    throw new Error("synthesis_failed: llm_empty_response");
  }

  const citations: Citation[] = indexed.map((e) => {
    const c: Citation = {
      url: e.url,
      title: e.title,
      ...(e.publisher !== undefined ? { publisher: e.publisher } : {}),
      ...(e.publishedAtSec !== undefined
        ? { publishedAtSec: e.publishedAtSec }
        : {}),
      accessedAtSec: e.accessedAtSec,
      snippetSha256: e.snippetSha256,
    };
    return c;
  });

  return { markdown, citations };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const SYNTHESIZER_SYSTEM = [
  "You are a careful research analyst.",
  "Given a research query and a numbered list of sources, write a sourced Markdown report.",
  "Required structure (in this exact order):",
  "  1. A `# ` H1 with a short title.",
  "  2. An `## Executive Summary` section (2–4 sentences).",
  "  3. A `## Findings` section: numbered findings, each citing supporting sources by `[N]` index.",
  "  4. A `## Citations` section listing every source as `[N] Title — URL` (one per line).",
  "Do not invent facts. If a source is marked UNAVAILABLE, do not cite it for substantive claims; you may note the gap.",
  "Honour the requested target length to within ±25%.",
].join("\n");

function clampTargetLength(n: number | undefined): number {
  if (n === undefined) return DEFAULT_TARGET_LENGTH_WORDS;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TARGET_LENGTH_WORDS;
  return Math.min(n, MAX_TARGET_LENGTH_WORDS);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
