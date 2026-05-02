/**
 * Public IO types for the `text:summarize` reference BPP (FN-075).
 *
 * `SummarizeInput` is a discriminated union over three source kinds —
 * `url`, `pdfBase64`, and `text` — plus optional shaping knobs
 * (`targetLengthWords`, `style`). `SummarizeOutput` carries a single
 * Markdown `Artifact` whose `sha256` is bound over `content`, the
 * decoded byte count of the source, and the model id used to summarise.
 *
 * The Zod schemas are the single source of truth for runtime validation
 * — the BPP handler invokes them on every inbound `Init`.  Limits are
 * enforced at the schema layer so the handler can short-circuit to
 * `failure` with a stable error code (see `handler.ts`).
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Limits (kept in one place; referenced by both the schemas and the handler) */
/* -------------------------------------------------------------------------- */

/** Hard cap on `url` length — generous, but well below typical limits. */
export const URL_MAX_CHARS = 2048;
/** Hard cap on raw `text` payload — 256 KB. */
export const TEXT_MAX_BYTES = 256 * 1024;
/** Hard cap on decoded PDF size — 8 MB. */
export const PDF_MAX_BYTES = 8 * 1024 * 1024;
/** Default summary target. */
export const DEFAULT_TARGET_LENGTH_WORDS = 200;
/** Maximum summary target — guards model token usage. */
export const MAX_TARGET_LENGTH_WORDS = 2000;

/* -------------------------------------------------------------------------- */
/* SummarizeInput                                                             */
/* -------------------------------------------------------------------------- */

/** A pointer to remote text/HTML/PDF content. */
export interface SummarizeInputUrl {
  readonly kind: "url";
  readonly url: string;
  /**
   * Cap on bytes the fetcher will pull from the URL. Defaults to 4 MB
   * if omitted (see `fetcher.ts`).
   */
  readonly maxBytes?: number;
}

/** A base64-encoded PDF blob inlined in the request. */
export interface SummarizeInputPdf {
  readonly kind: "pdfBase64";
  readonly data: string;
  readonly filename?: string;
}

/** Plain text inlined in the request. */
export interface SummarizeInputText {
  readonly kind: "text";
  readonly text: string;
}

/** Input source, plus optional shaping. */
export type SummarizeSource =
  | SummarizeInputUrl
  | SummarizeInputPdf
  | SummarizeInputText;

export type SummarizeStyle = "bullets" | "prose";

export interface SummarizeInput {
  readonly source: SummarizeSource;
  readonly targetLengthWords?: number;
  readonly style?: SummarizeStyle;
}

/* -------------------------------------------------------------------------- */
/* SummarizeOutput / Artifact                                                 */
/* -------------------------------------------------------------------------- */

/** A single content artifact produced by the BPP. */
export interface Artifact {
  readonly mimeType: "text/markdown";
  readonly content: string;
  /** Lowercase hex sha256 of `content` (utf-8 bytes). */
  readonly sha256: string;
  /** Unix seconds at which the artifact was produced. */
  readonly producedAtSec: number;
}

export interface SummarizeOutput {
  readonly artifact: Artifact;
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
    maxBytes: z.number().int().positive().max(PDF_MAX_BYTES).optional(),
  })
  .strict();

const zSourcePdf = z
  .object({
    kind: z.literal("pdfBase64"),
    data: z.string().min(1).max(Math.ceil((PDF_MAX_BYTES * 4) / 3) + 16),
    filename: z.string().max(256).optional(),
  })
  .strict();

const zSourceText = z
  .object({
    kind: z.literal("text"),
    text: z.string().min(1),
  })
  .strict();

export const zSummarizeSource = z.discriminatedUnion("kind", [
  zSourceUrl,
  zSourcePdf,
  zSourceText,
]);

export const zSummarizeInput = z
  .object({
    source: zSummarizeSource,
    targetLengthWords: z
      .number()
      .int()
      .positive()
      .max(MAX_TARGET_LENGTH_WORDS)
      .optional(),
    style: z.enum(["bullets", "prose"]).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const s = v.source;
    if (s.kind === "text" && Buffer.byteLength(s.text, "utf8") > TEXT_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "text"],
        message: `text exceeds ${TEXT_MAX_BYTES} bytes`,
      });
    }
    if (s.kind === "pdfBase64" && decodedBase64Bytes(s.data) > PDF_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "data"],
        message: `pdfBase64.data decoded size exceeds ${PDF_MAX_BYTES} bytes`,
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

export const zSummarizeOutput = z
  .object({
    artifact: zArtifact,
    sourceBytes: z.number().int().nonnegative(),
    modelId: z.string().min(1),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Decoded byte length of a base64 string (without actually decoding). */
export function decodedBase64Bytes(b64: string): number {
  // Strip whitespace; tolerate both standard and url-safe alphabets.
  const trimmed = b64.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  let padding = 0;
  if (trimmed.endsWith("==")) padding = 2;
  else if (trimmed.endsWith("=")) padding = 1;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}
