/**
 * `text:summarize` BPP handler (FN-075).
 *
 * Validates inbound `SummarizeInput`, fetches/decodes the source via
 * the injected fetcher, calls the injected summariser, and packages
 * the result into a Markdown `Artifact` whose `sha256` is bound over
 * its `content`. All errors — including schema validation failures —
 * are converted to `{ status: "failure", reason }` with a stable code
 * so the runtime routes them through `chain.failTask`.
 */

import type { BppHandler, TaskResult } from "../../templates/bpp/index.js";
import type { FetchSourceDeps, FetchedSource } from "./fetcher.js";
import { fetchSource } from "./fetcher.js";
import type { SummarizeDeps, SummarizeResult } from "./summarizer.js";
import { sha256Hex, summarize } from "./summarizer.js";
import type {
  Artifact,
  SummarizeInput,
  SummarizeOutput,
} from "./types.js";
import { zSummarizeInput } from "./types.js";

export interface CreateHandlerDeps {
  readonly fetcher: (source: SummarizeInput["source"]) => Promise<FetchedSource>;
  readonly summarizer: (
    text: string,
    opts: { modelId: string; targetLengthWords?: number; style?: "bullets" | "prose" },
  ) => Promise<SummarizeResult>;
  readonly modelId: string;
  /** Wall-clock seconds. Default `Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
}

export function createTextSummarizeHandler(
  deps: CreateHandlerDeps,
): BppHandler<unknown, SummarizeOutput> {
  return {
    async handleTask(req): Promise<TaskResult<SummarizeOutput>> {
      const parsed = zSummarizeInput.safeParse(req.input);
      if (!parsed.success) {
        return {
          status: "failure",
          reason: `input_invalid: ${flattenZodIssues(parsed.error.issues)}`,
        };
      }
      const input = parsed.data;

      let fetched: FetchedSource;
      try {
        // Zod's inferred output uses `maxBytes?: number | undefined`; the
        // structural shape is identical to `SummarizeSource` (which uses
        // `maxBytes?: number` under exactOptionalPropertyTypes), so coerce.
        fetched = await deps.fetcher(input.source as SummarizeInput["source"]);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      let summarised: SummarizeResult;
      try {
        const opts: {
          modelId: string;
          targetLengthWords?: number;
          style?: "bullets" | "prose";
        } = { modelId: deps.modelId };
        if (input.targetLengthWords !== undefined) {
          opts.targetLengthWords = input.targetLengthWords;
        }
        if (input.style !== undefined) opts.style = input.style;
        summarised = await deps.summarizer(fetched.text, opts);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      const now = (deps.now ?? defaultNow)();
      const artifact: Artifact = {
        mimeType: "text/markdown",
        content: summarised.markdown,
        sha256: sha256Hex(summarised.markdown),
        producedAtSec: now,
      };
      return {
        status: "success",
        output: {
          artifact,
          sourceBytes: fetched.sourceBytes,
          modelId: deps.modelId,
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Wiring helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Convenience factory that closes over `fetchSource` + `summarize` with
 * the injected primitives. Used by `main.ts`; tests prefer the lower-
 * level `createTextSummarizeHandler` so they can stub each seam.
 */
export function buildHandlerFromPrimitives(args: {
  readonly fetchDeps: FetchSourceDeps;
  readonly summarizeDeps: SummarizeDeps;
  readonly modelId: string;
  readonly now?: () => number;
}): BppHandler<unknown, SummarizeOutput> {
  const handlerDeps: CreateHandlerDeps = {
    fetcher: (source) => fetchSource(source, args.fetchDeps),
    summarizer: (text, opts) => summarize(text, opts, args.summarizeDeps),
    modelId: args.modelId,
    ...(args.now !== undefined ? { now: args.now } : {}),
  };
  return createTextSummarizeHandler(handlerDeps);
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
 * fetcher / summariser already use stable codes (`source_too_large`,
 * `fetch_failed: 503`, `pdf_extraction_unavailable`, `empty_source`,
 * `llm_empty_response`); anything else is wrapped as `internal_error`.
 */
function stableReason(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const KNOWN = [
    "source_too_large",
    "fetch_failed",
    "pdf_extraction_unavailable",
    "unsupported_content_type",
    "empty_source",
    "llm_empty_response",
    "input_too_large",
  ];
  for (const k of KNOWN) {
    if (msg.startsWith(k)) return msg;
  }
  return `internal_error: ${msg}`;
}
