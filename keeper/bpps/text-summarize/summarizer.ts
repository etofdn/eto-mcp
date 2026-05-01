/**
 * Anthropic-backed summariser for the `text:summarize` BPP (FN-075).
 *
 * Production wires the `LlmClient` interface to `@anthropic-ai/sdk`
 * (resolved structurally so this file does NOT take a static import on
 * the SDK — keeps `keeper/` runnable without it). Tests inject a fake
 * `LlmClient` whose canned response we then assert against.
 */

import { createHash } from "node:crypto";
import type { SummarizeStyle } from "./types.js";
import {
  DEFAULT_TARGET_LENGTH_WORDS,
  MAX_TARGET_LENGTH_WORDS,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* LlmClient seam                                                             */
/* -------------------------------------------------------------------------- */

export interface LlmRequest {
  readonly text: string;
  readonly targetLengthWords: number;
  readonly style: SummarizeStyle;
  readonly modelId: string;
}

export interface LlmClient {
  summarize(req: LlmRequest): Promise<{ readonly markdown: string }>;
}

/* -------------------------------------------------------------------------- */
/* Anthropic adapter                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Structural shape we require from an Anthropic SDK client. Captured
 * here (instead of importing `@anthropic-ai/sdk` types) so this file
 * compiles whether or not the SDK is installed; the production
 * deployment path passes a real `Anthropic` instance from the SDK.
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
  "You are a precise document summariser.",
  "Output strict Markdown with this structure:",
  "  1. A single first line beginning with `# ` containing a concise title.",
  "  2. The body, honouring the requested style (`prose` ⇒ short paragraphs;",
  "     `bullets` ⇒ a `- ` bullet list).",
  "  3. A trailing `## Key Facts` section with three to seven bullet points.",
  "Honour the target length in words to within ±25%.",
  "Do not invent facts. If the source is empty or unreadable, return only `# (no content)`.",
].join("\n");

export class AnthropicLlmClient implements LlmClient {
  public constructor(private readonly client: AnthropicLike) {}

  public async summarize(req: LlmRequest): Promise<{ markdown: string }> {
    const userPrompt = [
      `Target length: about ${req.targetLengthWords} words.`,
      `Style: ${req.style}.`,
      "",
      "--- BEGIN SOURCE ---",
      req.text,
      "--- END SOURCE ---",
    ].join("\n");

    const resp = await this.client.messages.create({
      model: req.modelId,
      max_tokens: Math.min(4 * req.targetLengthWords, 4096),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const markdown = resp.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
      .trim();
    if (markdown.length === 0) {
      throw new Error("llm_empty_response");
    }
    return { markdown };
  }
}

/* -------------------------------------------------------------------------- */
/* summarize                                                                  */
/* -------------------------------------------------------------------------- */

export interface SummarizeOpts {
  readonly modelId: string;
  readonly targetLengthWords?: number;
  readonly style?: SummarizeStyle;
}

export interface SummarizeDeps {
  readonly llm: LlmClient;
}

export interface SummarizeResult {
  readonly markdown: string;
  readonly sourceSha256: string;
  readonly targetLengthWords: number;
  readonly style: SummarizeStyle;
}

export async function summarize(
  text: string,
  opts: SummarizeOpts,
  deps: SummarizeDeps,
): Promise<SummarizeResult> {
  if (text.trim().length === 0) {
    throw new Error("empty_source");
  }
  const targetLengthWords = clampTargetLength(opts.targetLengthWords);
  const style: SummarizeStyle = opts.style ?? "prose";

  const sourceSha256 = sha256Hex(text);

  const { markdown } = await deps.llm.summarize({
    text,
    targetLengthWords,
    style,
    modelId: opts.modelId,
  });
  if (markdown.trim().length === 0) {
    throw new Error("llm_empty_response");
  }
  return { markdown, sourceSha256, targetLengthWords, style };
}

function clampTargetLength(n: number | undefined): number {
  if (n === undefined) return DEFAULT_TARGET_LENGTH_WORDS;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TARGET_LENGTH_WORDS;
  return Math.min(n, MAX_TARGET_LENGTH_WORDS);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
