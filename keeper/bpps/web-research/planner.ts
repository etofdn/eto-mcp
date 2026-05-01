/**
 * Query planner for the `web:research` BPP (FN-077).
 *
 * `planQueries(query, opts, deps)` calls the injected `LlmClient` to
 * expand the user query into 3–7 structured sub-queries. We instruct
 * the model to reply with strict JSON `{ subQueries, rationale }`,
 * parse via Zod, and on parse failure fall back to `[query]` (so a
 * misbehaving model never blocks the report).
 *
 * Production wires `LlmClient` to `@anthropic-ai/sdk` via the shared
 * `AnthropicLlmClient` adapter (see this file). Tests inject a fake.
 */

import { z } from "zod";
import { DEPTH_PROFILES, type ResearchDepth } from "./types.js";

/* -------------------------------------------------------------------------- */
/* LlmClient seam (shared between planner + synthesizer)                      */
/* -------------------------------------------------------------------------- */

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmCompleteRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly modelId: string;
  readonly maxTokens: number;
}

export interface LlmCompleteResponse {
  readonly text: string;
}

export interface LlmClient {
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}

/* -------------------------------------------------------------------------- */
/* Anthropic adapter                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Structural shape we require from an Anthropic SDK client. Captured
 * here (instead of importing `@anthropic-ai/sdk` types) so this file
 * compiles whether or not the SDK is installed; the production path
 * passes a real `Anthropic` instance from the SDK.
 */
export interface AnthropicLike {
  readonly messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

export class AnthropicLlmClient implements LlmClient {
  public constructor(private readonly client: AnthropicLike) {}

  public async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const resp = await this.client.messages.create({
      model: req.modelId,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = resp.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
      .trim();
    return { text };
  }
}

/**
 * Helper used by `main.ts` to construct an `AnthropicLlmClient` from
 * env at startup. Throws `anthropic_api_key_missing` when the key is
 * absent and `WEB_RESEARCH_FAKE` is not set. Kept as a separate factory
 * (rather than auto-wiring) so the planner / synthesiser remain pure.
 *
 *   TODO(real LLM key plumbing): swap to the keeper-wide credential
 *   manager once `start.ts` lands its env loader.
 */
export function loadAnthropicFromEnv(makeClient: (apiKey: string) => AnthropicLike): AnthropicLike {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key === "") {
    throw new Error("anthropic_api_key_missing");
  }
  return makeClient(key);
}

/* -------------------------------------------------------------------------- */
/* Planner                                                                    */
/* -------------------------------------------------------------------------- */

export const MIN_SUB_QUERIES = 3;
export const MAX_SUB_QUERIES = 7;
export const SUB_QUERY_MAX_CHARS = 256;

const zSubQueryPlan = z
  .object({
    subQueries: z.array(z.string().min(1)).min(1),
    rationale: z.string().default(""),
  })
  .passthrough();

export interface PlanQueriesOpts {
  readonly depth: ResearchDepth;
  readonly modelId: string;
}

export interface PlanQueriesDeps {
  readonly llm: LlmClient;
}

export interface QueryPlan {
  readonly subQueries: readonly string[];
  readonly rationale: string;
}

const PLANNER_SYSTEM = [
  "You are a research planner.",
  "Given a user research query, decompose it into focused sub-queries that a web search engine can answer well.",
  "Reply with STRICT JSON only — no prose, no Markdown fences. Schema:",
  '  {"subQueries": ["...","..."], "rationale": "short prose"}',
  `Produce between ${MIN_SUB_QUERIES} and ${MAX_SUB_QUERIES} sub-queries; each one must be a short search-engine-friendly phrase, ≤ ${SUB_QUERY_MAX_CHARS} characters.`,
  "Cover distinct angles (definition, mechanism, comparisons, criticisms, recent developments) where relevant.",
].join("\n");

export async function planQueries(
  query: string,
  opts: PlanQueriesOpts,
  deps: PlanQueriesDeps,
): Promise<QueryPlan> {
  if (query.trim().length === 0) {
    throw new Error("empty_query");
  }
  const profile = DEPTH_PROFILES[opts.depth];
  const target = Math.min(
    MAX_SUB_QUERIES,
    Math.max(MIN_SUB_QUERIES, profile.subQueries),
  );

  const userPrompt = [
    `Research query: ${query}`,
    `Target sub-query count: ${target}.`,
    "Respond with strict JSON as described in the system prompt.",
  ].join("\n");

  let raw: string;
  try {
    const resp = await deps.llm.complete({
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
      modelId: opts.modelId,
      maxTokens: 1024,
    });
    raw = resp.text;
  } catch {
    return { subQueries: [query], rationale: "llm_call_failed; falling back to [query]" };
  }

  const parsed = tryParseJsonPlan(raw);
  if (parsed === null) {
    return {
      subQueries: [query],
      rationale: "planner_parse_failed; falling back to [query]",
    };
  }

  const cleaned = parsed.subQueries
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.length > SUB_QUERY_MAX_CHARS ? s.slice(0, SUB_QUERY_MAX_CHARS) : s));

  // Dedupe, preserve order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const q of cleaned) {
    const k = q.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(q);
    if (deduped.length >= MAX_SUB_QUERIES) break;
  }

  if (deduped.length === 0) {
    return {
      subQueries: [query],
      rationale: "planner_empty; falling back to [query]",
    };
  }

  return { subQueries: deduped, rationale: parsed.rationale };
}

/**
 * Parse a model response as a JSON `{ subQueries, rationale }`.  The
 * model occasionally wraps the JSON in `\`\`\`json` fences — strip
 * them. Returns `null` on any parse / schema failure.
 */
function tryParseJsonPlan(raw: string): { subQueries: string[]; rationale: string } | null {
  const trimmed = stripCodeFence(raw.trim());
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    // Fallback: pull the first {...} blob out of the response.
    const m = /\{[\s\S]*\}/m.exec(trimmed);
    if (!m) return null;
    try {
      json = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const r = zSubQueryPlan.safeParse(json);
  if (!r.success) return null;
  return { subQueries: r.data.subQueries, rationale: r.data.rationale };
}

function stripCodeFence(s: string): string {
  if (!s.startsWith("```")) return s;
  // ```json\n...\n``` → ...
  const inner = s.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  return inner;
}
