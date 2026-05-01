/**
 * `web:research` BPP handler (FN-077).
 *
 * Validates inbound `ResearchInput`, runs the structured pipeline
 *   planner → search → fetch → synthesizer
 * and packages the result into a Markdown `ResearchReport` whose
 * `sha256` is bound over its `content`. All errors — including
 * schema-validation failures — are converted to
 * `{ status: "failure", reason }` with a stable code so the runtime
 * routes them through `chain.failTask`.
 *
 * Stable failure codes:
 *   - `input_invalid: <flattened>`     — schema validation failed
 *   - `empty_query`                    — query was empty/whitespace
 *   - `input_too_large`                — query above hard cap
 *   - `search_provider_not_configured` — surfaced from HttpSearchProvider
 *   - `no_sources_found`               — zero usable sources after fetch
 *   - `synthesis_failed: <inner>`      — synthesizer threw
 *   - `handler_error: <short>`         — anything else
 */

import { createHash } from "node:crypto";
import type { BppHandler, TaskResult } from "../../templates/bpp/index.js";
import {
  zResearchInput,
  DEFAULT_MAX_SOURCES,
  DEPTH_PROFILES,
  QUERY_MAX_CHARS,
  type Citation,
  type ResearchInput,
  type ResearchOutput,
  type ResearchReport,
} from "./types.js";
import type { SearchHit, SearchProvider } from "./search-provider.js";
import { hostOf } from "./search-provider.js";
import type { FetchedPage } from "./fetcher.js";
import type { LlmClient } from "./planner.js";
import { planQueries, type QueryPlan } from "./planner.js";
import { synthesize, type EvidenceItem } from "./synthesizer.js";

/* -------------------------------------------------------------------------- */
/* Deps                                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateWebResearchHandlerDeps {
  readonly search: SearchProvider;
  readonly fetcher: (url: string) => Promise<FetchedPage>;
  readonly llm: LlmClient;
  readonly modelId: string;
  /** Wall-clock seconds. Default `Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
  /** Max parallel page fetches. Default 4. */
  readonly concurrency?: number;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createWebResearchHandler(
  deps: CreateWebResearchHandlerDeps,
): BppHandler<unknown, ResearchOutput> {
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    async handleTask(req): Promise<TaskResult<ResearchOutput>> {
      // 1. Schema-validate input.
      const parsed = zResearchInput.safeParse(req.input);
      if (!parsed.success) {
        // Surface specific stable codes for the most common failures
        // so downstream telemetry can bucket them cleanly.
        const flat = flattenZodIssues(parsed.error.issues);
        if (/query is empty/.test(flat)) {
          return { status: "failure", reason: "empty_query" };
        }
        if (new RegExp(`query exceeds ${QUERY_MAX_CHARS} chars`).test(flat)) {
          return { status: "failure", reason: "input_too_large" };
        }
        return { status: "failure", reason: `input_invalid: ${flat}` };
      }
      const input: ResearchInput = parsed.data as ResearchInput;
      const depth = input.depth ?? "standard";
      const maxSources = input.maxSources ?? DEFAULT_MAX_SOURCES;

      // 2. Plan sub-queries.
      let plan: QueryPlan;
      try {
        plan = await planQueries(
          input.query,
          { depth, modelId: deps.modelId },
          { llm: deps.llm },
        );
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === "empty_query") {
          return { status: "failure", reason: "empty_query" };
        }
        return { status: "failure", reason: `handler_error: planner:${shorten(msg)}` };
      }

      // 3. Search fan-out.
      const profile = DEPTH_PROFILES[depth];
      const searchOpts = buildSearchOpts(input, profile.resultsPerSubQuery);
      const allHits: SearchHit[] = [];
      try {
        for (const subQuery of plan.subQueries) {
          const hits = await deps.search.search(subQuery, searchOpts);
          for (const h of hits) allHits.push(h);
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith("search_provider_not_configured")) {
          return { status: "failure", reason: "search_provider_not_configured" };
        }
        return { status: "failure", reason: `handler_error: search:${shorten(msg)}` };
      }

      // 4. Dedupe by canonical URL, apply allow/block (defence in depth —
      //    FakeSearchProvider already filters; real providers may not),
      //    and cap to maxSources.
      const dedupedHits = dedupeAndCap(allHits, input, maxSources);
      if (dedupedHits.length === 0) {
        return { status: "failure", reason: "no_sources_found" };
      }

      // 5. Fetch each top hit with bounded concurrency.
      const evidence: EvidenceItem[] = [];
      try {
        const fetched = await mapConcurrent(dedupedHits, concurrency, async (hit) => {
          let page: FetchedPage;
          try {
            page = await deps.fetcher(hit.url);
          } catch (err) {
            return {
              hit,
              page: undefined,
              fetchError: (err as Error).message,
            } as const;
          }
          return { hit, page, fetchError: undefined } as const;
        });
        for (const { hit, page, fetchError } of fetched) {
          if (page === undefined) {
            evidence.push({
              url: hit.url,
              title: hit.title,
              ...(hit.publisher !== undefined ? { publisher: hit.publisher } : {}),
              ...(hit.publishedAtSec !== undefined
                ? { publishedAtSec: hit.publishedAtSec }
                : {}),
              accessedAtSec: now(),
              text: "",
              ...(fetchError !== undefined ? { fetchError } : {}),
            });
            continue;
          }
          evidence.push({
            url: hit.url,
            title: hit.title,
            ...(hit.publisher !== undefined ? { publisher: hit.publisher } : {}),
            ...(hit.publishedAtSec !== undefined
              ? { publishedAtSec: hit.publishedAtSec }
              : {}),
            accessedAtSec: page.fetchedAtSec,
            text: page.text,
            ...(page.fetchError !== undefined ? { fetchError: page.fetchError } : {}),
          });
        }
      } catch (err) {
        return {
          status: "failure",
          reason: `handler_error: fetch:${shorten((err as Error).message)}`,
        };
      }

      // Drop sources where we have neither extractable text nor a hit
      // snippet to fall back on. If everything is gone, fail cleanly.
      const usable = evidence.filter(
        (e) => e.text.trim().length > 0 || e.fetchError === undefined,
      );
      if (usable.length === 0) {
        return { status: "failure", reason: "no_sources_found" };
      }

      // 6. Synthesise.
      let synthesisResult: { markdown: string; citations: Citation[] };
      try {
        synthesisResult = await synthesize(
          input.query,
          usable,
          {
            modelId: deps.modelId,
            ...(input.targetLengthWords !== undefined
              ? { targetLengthWords: input.targetLengthWords }
              : {}),
          },
          { llm: deps.llm },
        );
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith("synthesis_failed") || msg === "no_sources_found") {
          return { status: "failure", reason: msg };
        }
        return { status: "failure", reason: `handler_error: synth:${shorten(msg)}` };
      }

      // 7. Build artifact.
      const artifact: ResearchReport = {
        mimeType: "text/markdown",
        content: synthesisResult.markdown,
        sha256: sha256Hex(synthesisResult.markdown),
        producedAtSec: now(),
      };

      return {
        status: "success",
        output: {
          artifact,
          citations: synthesisResult.citations,
          query: input.query,
          subQueries: plan.subQueries,
          modelId: deps.modelId,
          sourceCount: synthesisResult.citations.length,
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function buildSearchOpts(
  input: ResearchInput,
  resultsPerSubQuery: number,
): {
  maxResults: number;
  recencyDays?: number;
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
} {
  const o: {
    maxResults: number;
    recencyDays?: number;
    allowedDomains?: readonly string[];
    blockedDomains?: readonly string[];
  } = { maxResults: resultsPerSubQuery };
  if (input.recencyDays !== undefined) o.recencyDays = input.recencyDays;
  if (input.allowedDomains !== undefined) o.allowedDomains = input.allowedDomains;
  if (input.blockedDomains !== undefined) o.blockedDomains = input.blockedDomains;
  return o;
}

/**
 * Dedupe by canonical URL (lowercase host + pathname; query string
 * preserved as a tiebreaker) and cap to `maxSources`. Allow/block
 * lists are re-applied here as defence in depth.
 */
function dedupeAndCap(
  hits: readonly SearchHit[],
  input: ResearchInput,
  maxSources: number,
): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  const allow = input.allowedDomains ?? [];
  const block = input.blockedDomains ?? [];
  for (const h of hits) {
    const host = hostOf(h.url);
    if (host === "") continue;
    if (block.some((d) => domainSuffixMatch(d, host))) continue;
    if (allow.length > 0 && !allow.some((d) => domainSuffixMatch(d, host))) continue;
    const key = canonicalUrlKey(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= maxSources) break;
  }
  return out;
}

function canonicalUrlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/$/, "")}?${u.search}`;
  } catch {
    return url;
  }
}

function domainSuffixMatch(entry: string, host: string): boolean {
  let needle = entry.toLowerCase();
  if (needle.startsWith("http://") || needle.startsWith("https://")) {
    needle = hostOf(needle);
  }
  needle = needle.split(":")[0] ?? "";
  if (needle === "") return false;
  if (host === needle) return true;
  return host.endsWith(`.${needle}`);
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function flattenZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): string {
  return issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

function shorten(s: string): string {
  return s.length <= 80 ? s : `${s.slice(0, 77)}...`;
}
