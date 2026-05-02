/**
 * Public IO types for the `data:analyze` reference BPP (FN-079).
 *
 * `AnalyzeInput` is a discriminated union over three CSV-source kinds —
 * `url`, `csv`, `csvBase64` — plus optional shaping knobs (`delimiter`,
 * `hasHeader`, `maxRows`, `question`). `AnalyzeOutput` carries a single
 * Markdown `Artifact` together with the structured `DatasetProfile` and
 * `AnalysisReport` so downstream consumers can re-derive the artifact.
 *
 * Mirrors FN-075 (`text:summarize`) layout: Zod schemas are the single
 * source of truth for runtime validation, and limits live in one place
 * so the handler can short-circuit to a `failure` with a stable code.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

export const URL_MAX_CHARS = 2048;
/** Hard cap on inline `text` payload — 8 MB. */
export const TEXT_MAX_BYTES = 8 * 1024 * 1024;
/** Hard cap on decoded `csvBase64` payload — 32 MB. */
export const CSV_BASE64_MAX_BYTES = 32 * 1024 * 1024;
/** Default cap on parsed rows. */
export const DEFAULT_MAX_ROWS = 100_000;
/** Hard upper bound on `maxRows`. */
export const MAX_MAX_ROWS = 500_000;
/** Cap on caller-supplied focus `question` length. */
export const QUESTION_MAX_CHARS = 1024;

/* -------------------------------------------------------------------------- */
/* AnalyzeInput                                                               */
/* -------------------------------------------------------------------------- */

export type Delimiter = "," | ";" | "\t" | "auto";

export interface AnalyzeInputUrl {
  readonly kind: "url";
  readonly url: string;
  readonly maxBytes?: number;
}
export interface AnalyzeInputCsv {
  readonly kind: "csv";
  readonly text: string;
}
export interface AnalyzeInputCsvBase64 {
  readonly kind: "csvBase64";
  readonly data: string;
  readonly filename?: string;
}

export type AnalyzeSource =
  | AnalyzeInputUrl
  | AnalyzeInputCsv
  | AnalyzeInputCsvBase64;

export interface AnalyzeInput {
  readonly source: AnalyzeSource;
  readonly delimiter?: Delimiter;
  readonly hasHeader?: boolean;
  readonly maxRows?: number;
  readonly question?: string;
}

/* -------------------------------------------------------------------------- */
/* DatasetProfile                                                             */
/* -------------------------------------------------------------------------- */

export type InferredType =
  | "boolean"
  | "integer"
  | "number"
  | "date"
  | "string"
  | "mixed";

export interface ColumnProfile {
  readonly name: string;
  readonly inferredType: InferredType;
  readonly nonNullCount: number;
  readonly nullCount: number;
  readonly distinctCount: number;
  readonly min?: number | string;
  readonly max?: number | string;
  readonly mean?: number;
  readonly stddev?: number;
  readonly topValues?: ReadonlyArray<{ value: string; count: number }>;
}

export interface DatasetProfile {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly columns: readonly ColumnProfile[];
  readonly delimiter: "," | ";" | "\t";
  readonly encoding: "utf-8";
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* AnalysisReport                                                             */
/* -------------------------------------------------------------------------- */

export interface AnalysisReport {
  readonly summary: string;
  readonly findings: readonly string[];
  readonly anomalies: readonly string[];
  readonly suggestedQuestions: readonly string[];
  readonly answer?: string;
}

/* -------------------------------------------------------------------------- */
/* Artifact / AnalyzeOutput                                                   */
/* -------------------------------------------------------------------------- */

export interface Artifact {
  readonly mimeType: "text/markdown";
  readonly content: string;
  readonly sha256: string;
  readonly producedAtSec: number;
}

export interface AnalyzeOutput {
  readonly artifact: Artifact;
  readonly profile: DatasetProfile;
  readonly report: AnalysisReport;
  readonly sourceBytes: number;
  readonly modelId: string;
}

/* -------------------------------------------------------------------------- */
/* Zod schemas                                                                */
/* -------------------------------------------------------------------------- */

const HEX64_RE = /^[0-9a-f]{64}$/;

const zUrl = z
  .string()
  .min(1)
  .max(URL_MAX_CHARS, `url exceeds ${URL_MAX_CHARS} chars`)
  .url("malformed url");

const zSourceUrl = z
  .object({
    kind: z.literal("url"),
    url: zUrl,
    maxBytes: z.number().int().positive().max(CSV_BASE64_MAX_BYTES).optional(),
  })
  .strict();

const zSourceCsv = z
  .object({
    kind: z.literal("csv"),
    text: z.string().min(1),
  })
  .strict();

const zSourceCsvBase64 = z
  .object({
    kind: z.literal("csvBase64"),
    data: z
      .string()
      .min(1)
      .max(Math.ceil((CSV_BASE64_MAX_BYTES * 4) / 3) + 16),
    filename: z.string().max(256).optional(),
  })
  .strict();

export const zAnalyzeSource = z.discriminatedUnion("kind", [
  zSourceUrl,
  zSourceCsv,
  zSourceCsvBase64,
]);

export const zAnalyzeInput = z
  .object({
    source: zAnalyzeSource,
    delimiter: z.enum([",", ";", "\t", "auto"]).optional(),
    hasHeader: z.boolean().optional(),
    maxRows: z.number().int().positive().max(MAX_MAX_ROWS).optional(),
    question: z.string().min(1).max(QUESTION_MAX_CHARS).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const s = v.source;
    if (s.kind === "csv" && Buffer.byteLength(s.text, "utf8") > TEXT_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "text"],
        message: `csv.text exceeds ${TEXT_MAX_BYTES} bytes`,
      });
    }
    if (
      s.kind === "csvBase64" &&
      decodedBase64Bytes(s.data) > CSV_BASE64_MAX_BYTES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "data"],
        message: `csvBase64.data decoded size exceeds ${CSV_BASE64_MAX_BYTES} bytes`,
      });
    }
  });

export const zArtifact = z
  .object({
    mimeType: z.literal("text/markdown"),
    content: z.string().min(1),
    sha256: z.string().regex(HEX64_RE, "sha256 must be 64 lowercase hex chars"),
    producedAtSec: z.number().int().nonnegative(),
  })
  .strict();

export const zColumnProfile = z
  .object({
    name: z.string(),
    inferredType: z.enum([
      "boolean",
      "integer",
      "number",
      "date",
      "string",
      "mixed",
    ]),
    nonNullCount: z.number().int().nonnegative(),
    nullCount: z.number().int().nonnegative(),
    distinctCount: z.number().int().nonnegative(),
    min: z.union([z.number(), z.string()]).optional(),
    max: z.union([z.number(), z.string()]).optional(),
    mean: z.number().optional(),
    stddev: z.number().optional(),
    topValues: z
      .array(
        z
          .object({ value: z.string(), count: z.number().int().nonnegative() })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const zDatasetProfile = z
  .object({
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    columns: z.array(zColumnProfile),
    delimiter: z.enum([",", ";", "\t"]),
    encoding: z.literal("utf-8"),
    truncated: z.boolean(),
  })
  .strict();

export const zAnalysisReport = z
  .object({
    summary: z.string(),
    findings: z.array(z.string()),
    anomalies: z.array(z.string()),
    suggestedQuestions: z.array(z.string()),
    answer: z.string().optional(),
  })
  .strict();

export const zAnalyzeOutput = z
  .object({
    artifact: zArtifact,
    profile: zDatasetProfile,
    report: zAnalysisReport,
    sourceBytes: z.number().int().nonnegative(),
    modelId: z.string().min(1),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Decoded byte length of a base64 string (without actually decoding). */
export function decodedBase64Bytes(b64: string): number {
  const trimmed = b64.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  let padding = 0;
  if (trimmed.endsWith("==")) padding = 2;
  else if (trimmed.endsWith("=")) padding = 1;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}
