/**
 * `data:analyze` BPP handler (FN-079).
 *
 * Validates inbound `AnalyzeInput`, fetches the CSV via the injected
 * fetcher, profiles it, calls the analyzer, and packages the result
 * into a Markdown `Artifact` whose `sha256` is bound over its
 * `content`. All errors — including schema validation failures — are
 * converted to `{ status: "failure", reason }` with a stable code so
 * the runtime routes them through `chain.failTask`.
 */

import type { BppHandler, TaskResult } from "../../templates/bpp/index.js";
import type { FetchCsvDeps, FetchedCsv } from "./fetcher.js";
import { fetchCsv } from "./fetcher.js";
import type { ProfileDeps, ProfileResult, ProfileOpts } from "./profiler.js";
import { profileCsv } from "./profiler.js";
import type { AnalyzeDeps, AnalyzeOpts, AnalyzeResult } from "./analyzer.js";
import { analyze, sha256Hex } from "./analyzer.js";
import type {
  AnalyzeInput,
  AnalyzeOutput,
  Artifact,
  Delimiter,
} from "./types.js";
import {
  DEFAULT_MAX_ROWS,
  zAnalyzeInput,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Public seam                                                                */
/* -------------------------------------------------------------------------- */

export interface CreateHandlerDeps {
  readonly fetcher: (source: AnalyzeInput["source"]) => Promise<FetchedCsv>;
  readonly profiler: (text: string, opts: ProfileOpts) => ProfileResult;
  readonly analyzer: (
    profile: ProfileResult["profile"],
    sample: ProfileResult["sample"],
    opts: AnalyzeOpts,
  ) => Promise<AnalyzeResult>;
  readonly modelId: string;
  /** Wall-clock seconds. Default `Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
}

export function createDataAnalyzeHandler(
  deps: CreateHandlerDeps,
): BppHandler<unknown, AnalyzeOutput> {
  return {
    async handleTask(req): Promise<TaskResult<AnalyzeOutput>> {
      const parsed = zAnalyzeInput.safeParse(req.input);
      if (!parsed.success) {
        return {
          status: "failure",
          reason: `input_invalid: ${flattenZodIssues(parsed.error.issues)}`,
        };
      }
      const input = parsed.data as AnalyzeInput;

      // 1. Fetch.
      let fetched: FetchedCsv;
      try {
        fetched = await deps.fetcher(input.source);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      // 2. Profile.
      const profileOpts: ProfileOpts = {
        delimiter: (input.delimiter ?? "auto") as Delimiter,
        hasHeader: input.hasHeader ?? true,
        maxRows: Math.min(input.maxRows ?? DEFAULT_MAX_ROWS, 500_000),
      };
      let profiled: ProfileResult;
      try {
        profiled = deps.profiler(fetched.text, profileOpts);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }
      if (
        profiled.profile.columnCount === 0 ||
        profiled.profile.rowCount === 0
      ) {
        return { status: "failure", reason: "empty_dataset" };
      }

      // 3. Analyze.
      let analysed: AnalyzeResult;
      try {
        const opts: AnalyzeOpts = {
          modelId: deps.modelId,
          columnFlags: profiled.columnFlags,
          ...(input.question !== undefined ? { question: input.question } : {}),
        };
        analysed = await deps.analyzer(profiled.profile, profiled.sample, opts);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      // 4. Package.
      const now = (deps.now ?? defaultNow)();
      const artifact: Artifact = {
        mimeType: "text/markdown",
        content: analysed.markdown,
        sha256: sha256Hex(analysed.markdown),
        producedAtSec: now,
      };
      return {
        status: "success",
        output: {
          artifact,
          profile: profiled.profile,
          report: analysed.report,
          sourceBytes: fetched.sourceBytes,
          modelId: deps.modelId,
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Wiring helper                                                              */
/* -------------------------------------------------------------------------- */

export function buildHandlerFromPrimitives(args: {
  readonly fetchDeps: FetchCsvDeps;
  readonly profileDeps?: ProfileDeps;
  readonly analyzeDeps: AnalyzeDeps;
  readonly modelId: string;
  readonly now?: () => number;
}): BppHandler<unknown, AnalyzeOutput> {
  const handlerDeps: CreateHandlerDeps = {
    fetcher: (source) => fetchCsv(source, args.fetchDeps),
    profiler: (text, opts) => profileCsv(text, opts, args.profileDeps),
    analyzer: (profile, sample, opts) =>
      analyze(profile, sample, opts, args.analyzeDeps),
    modelId: args.modelId,
    ...(args.now !== undefined ? { now: args.now } : {}),
  };
  return createDataAnalyzeHandler(handlerDeps);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

function flattenZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): string {
  return issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

/**
 * Map a thrown error to a stable failure reason. Errors thrown by the
 * fetcher / profiler / analyser already use stable codes; anything
 * else is wrapped as `handler_internal_error`.
 */
function stableReason(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const KNOWN = [
    "input_too_large",
    "fetch_failed",
    "source_too_large",
    "encoding_unsupported",
    "unsupported_content_type",
    "empty_dataset",
    "llm_invalid_response",
  ];
  for (const k of KNOWN) {
    if (msg.startsWith(k)) return msg;
  }
  return `handler_internal_error: ${msg}`;
}
