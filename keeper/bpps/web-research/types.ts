/**
 * Public IO types for the `web:research` reference BPP (FN-077).
 *
 * `ResearchInput` is a research query plus optional shaping knobs
 * (`depth`, `maxSources`, `recencyDays`, `allowedDomains`,
 * `blockedDomains`, `targetLengthWords`).  `ResearchOutput` carries a
 * single Markdown `ResearchReport` whose `sha256` is bound over its
 * `content`, plus the structured `Citation[]` referenced by the report.
 *
 * The Zod schemas are the single source of truth for runtime
 * validation — the BPP handler invokes them on every inbound `Init`.
 * Limits are enforced at the schema layer so the handler can short-
 * circuit to `failure` with a stable error code (see `handler.ts`).
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Limits / defaults                                                          */
/* -------------------------------------------------------------------------- */

/** Hard cap on `query` length (chars). */
export const QUERY_MAX_CHARS = 1024;
/** Hard cap on the total number of sources actually fetched/cited. */
export const MAX_SOURCES_HARD_CAP = 20;
/** Hard cap on the requested `targetLengthWords` of the report. */
export const MAX_TARGET_LENGTH_WORDS = 4000;
/** Default report length (≈ a long executive memo). */
export const DEFAULT_TARGET_LENGTH_WORDS = 600;
/** Default `maxSources` when caller leaves it unset. */
export const DEFAULT_MAX_SOURCES = 8;

/** Recognised research depths. */
export const RESEARCH_DEPTHS = ["shallow", "standard", "deep"] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

/**
 * Per-depth knobs the planner / search use to shape fan-out. Keeping
 * the table here (rather than buried inside the planner) makes it
 * trivially testable.
 */
export interface DepthProfile {
  readonly subQueries: number;
  readonly resultsPerSubQuery: number;
}
export const DEPTH_PROFILES: Readonly<Record<ResearchDepth, DepthProfile>> = {
  shallow: { subQueries: 2, resultsPerSubQuery: 3 },
  standard: { subQueries: 3, resultsPerSubQuery: 5 },
  deep: { subQueries: 5, resultsPerSubQuery: 6 },
};

/* -------------------------------------------------------------------------- */
/* ResearchInput                                                              */
/* -------------------------------------------------------------------------- */

export interface ResearchInput {
  readonly query: string;
  readonly depth?: ResearchDepth;
  readonly maxSources?: number;
  /** Bias toward sources newer than this many days. `0` ⇒ no bias. */
  readonly recencyDays?: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly targetLengthWords?: number;
}

/* -------------------------------------------------------------------------- */
/* Citation / ResearchReport / ResearchOutput                                 */
/* -------------------------------------------------------------------------- */

/** A single source the report cites. */
export interface Citation {
  readonly url: string;
  readonly title: string;
  readonly publisher?: string;
  /** Unix seconds — when the source itself was published, if known. */
  readonly publishedAtSec?: number;
  /** Unix seconds — when the BPP fetched the source. */
  readonly accessedAtSec: number;
  /** sha256 hex of the snippet/extract actually fed to the synthesiser. */
  readonly snippetSha256: string;
}

/** Markdown report artifact. */
export interface ResearchReport {
  readonly mimeType: "text/markdown";
  readonly content: string;
  /** Lowercase hex sha256 of `content` (utf-8 bytes). */
  readonly sha256: string;
  readonly producedAtSec: number;
}

export interface ResearchOutput {
  readonly artifact: ResearchReport;
  readonly citations: readonly Citation[];
  readonly query: string;
  readonly subQueries: readonly string[];
  readonly modelId: string;
  readonly sourceCount: number;
}

/* -------------------------------------------------------------------------- */
/* Zod schemas                                                                */
/* -------------------------------------------------------------------------- */

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * A domain entry — accepts either a bare hostname (`example.com`) or a
 * full `http(s):` URL whose host we lift off via `URL`. Validation is
 * permissive for hostnames and strict for URLs.
 */
const zDomain = z
  .string()
  .min(1)
  .max(253)
  .superRefine((v, ctx) => {
    if (v.startsWith("http://") || v.startsWith("https://")) {
      try {
        new URL(v);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "malformed http(s) url",
        });
      }
      return;
    }
    // Bare hostname: letters, digits, dots, hyphens, optional port.
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "malformed hostname (use a bare hostname or full http(s) URL)",
      });
    }
  });

export const zResearchInput = z
  .object({
    query: z
      .string()
      .max(QUERY_MAX_CHARS, `query exceeds ${QUERY_MAX_CHARS} chars`)
      .superRefine((v, ctx) => {
        if (v.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "query is empty",
          });
        }
      }),
    depth: z.enum(RESEARCH_DEPTHS).optional(),
    maxSources: z
      .number()
      .int()
      .positive()
      .max(MAX_SOURCES_HARD_CAP, `maxSources exceeds ${MAX_SOURCES_HARD_CAP}`)
      .optional(),
    recencyDays: z.number().int().nonnegative().optional(),
    allowedDomains: z.array(zDomain).max(64).optional(),
    blockedDomains: z.array(zDomain).max(64).optional(),
    targetLengthWords: z
      .number()
      .int()
      .positive()
      .max(MAX_TARGET_LENGTH_WORDS)
      .optional(),
  })
  .strict();

export const zCitation = z
  .object({
    url: z.string().url(),
    title: z.string().min(1).max(512),
    publisher: z.string().min(1).max(256).optional(),
    publishedAtSec: z.number().int().nonnegative().optional(),
    accessedAtSec: z.number().int().nonnegative(),
    snippetSha256: z.string().regex(HEX64_RE, "snippetSha256 must be 64 hex chars"),
  })
  .strict();

export const zResearchReport = z
  .object({
    mimeType: z.literal("text/markdown"),
    content: z.string().min(1),
    sha256: z.string().regex(HEX64_RE, "sha256 must be 64 hex chars"),
    producedAtSec: z.number().int().nonnegative(),
  })
  .strict();

export const zResearchOutput = z
  .object({
    artifact: zResearchReport,
    citations: z.array(zCitation),
    query: z.string().min(1),
    subQueries: z.array(z.string().min(1)),
    modelId: z.string().min(1),
    sourceCount: z.number().int().nonnegative(),
  })
  .strict();
