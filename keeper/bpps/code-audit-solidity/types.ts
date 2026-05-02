/**
 * Public IO types for the `code:audit:solidity` reference BPP (FN-076).
 *
 * `AuditInput` is a discriminated union over three source kinds —
 * `inline`, `url`, `base64` — plus optional `solcVersion` (advisory)
 * and `severityFloor`. `AuditOutput` carries a Markdown `Artifact`
 * whose sha256 is bound over `content`, the structured `AuditReport`
 * (so downstream consumers can render their own UI), and the byte
 * count of the loaded source.
 *
 * The Zod schemas are the runtime source of truth — the BPP handler
 * invokes them on every inbound `Init`. Limits are enforced at the
 * schema layer so the handler can short-circuit to a stable
 * `failure` reason.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Hard cap on a single Solidity file's source. */
export const PER_FILE_MAX_BYTES = 256 * 1024;
/** Hard cap on total inline payload across all files. */
export const TOTAL_INLINE_MAX_BYTES = 2 * 1024 * 1024;
/** Hard cap on URL payload (single fetched file). */
export const URL_MAX_BYTES = 2 * 1024 * 1024;
/** Hard cap on URL string length. */
export const URL_MAX_CHARS = 2048;
/** Hard cap on file count for inline payloads. */
export const MAX_FILES = 32;

/* -------------------------------------------------------------------------- */
/* Severity                                                                   */
/* -------------------------------------------------------------------------- */

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Numeric ranking used for floor filtering and sort. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const AUDIT_SOURCES = ["slither", "mythril", "llm"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/* AuditInput                                                                 */
/* -------------------------------------------------------------------------- */

export interface AuditInputFile {
  readonly path: string;
  readonly content: string;
}

export interface AuditInputInline {
  readonly kind: "inline";
  readonly files: readonly AuditInputFile[];
}

export interface AuditInputUrl {
  readonly kind: "url";
  readonly url: string;
  readonly maxBytes?: number;
}

export interface AuditInputBase64 {
  readonly kind: "base64";
  readonly data: string;
  readonly filename: string;
}

export type AuditInputSource = AuditInputInline | AuditInputUrl | AuditInputBase64;

export interface AuditInput {
  readonly kind: AuditInputSource["kind"];
  readonly files?: readonly AuditInputFile[];
  readonly url?: string;
  readonly maxBytes?: number;
  readonly data?: string;
  readonly filename?: string;
  readonly solcVersion?: string;
  readonly severityFloor?: Severity;
}

/* -------------------------------------------------------------------------- */
/* AuditFinding / AuditReport                                                 */
/* -------------------------------------------------------------------------- */

export interface AuditFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly file: string;
  readonly line?: number;
  readonly description: string;
  readonly recommendation: string;
  readonly source: AuditSource;
}

export interface AuditReport {
  readonly summary: string;
  readonly findings: readonly AuditFinding[];
  readonly toolsRun: readonly AuditSource[];
  readonly modelId?: string;
}

/* -------------------------------------------------------------------------- */
/* Artifact / AuditOutput                                                     */
/* -------------------------------------------------------------------------- */

export interface Artifact {
  readonly mimeType: "text/markdown";
  readonly content: string;
  /** Lowercase hex sha256 of `content` (utf-8). */
  readonly sha256: string;
  readonly producedAtSec: number;
}

export interface AuditOutput {
  readonly artifact: Artifact;
  readonly report: AuditReport;
  readonly sourceBytes: number;
}

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

/* -------------------------------------------------------------------------- */
/* Zod schemas                                                                */
/* -------------------------------------------------------------------------- */

const HEX64_RE = /^[0-9a-f]{64}$/;
// Permissive semver: `MAJOR.MINOR.PATCH` optionally prefixed `^` / `~` /
// equality. Advisory-only: never executed as a constraint.
const SOLC_VERSION_RE = /^[\^~=]?\d+\.\d+\.\d+$/;

const zAuditFile = z
  .object({
    path: z
      .string()
      .min(1)
      .max(512)
      .refine((p) => !p.includes("..") && !p.startsWith("/"), {
        message: "path must not include '..' nor start with '/'",
      }),
    content: z.string(),
  })
  .strict();

const zSourceInline = z
  .object({
    kind: z.literal("inline"),
    files: z.array(zAuditFile).min(1).max(MAX_FILES),
    solcVersion: z
      .string()
      .regex(SOLC_VERSION_RE, "must be MAJOR.MINOR.PATCH (advisory)")
      .optional(),
    severityFloor: z.enum(SEVERITIES).default("low"),
  })
  .strict()
  .superRefine((v, ctx) => {
    let total = 0;
    for (let i = 0; i < v.files.length; i++) {
      const file = v.files[i]!;
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > PER_FILE_MAX_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", i, "content"],
          message: `file content exceeds ${PER_FILE_MAX_BYTES} bytes`,
        });
      }
      total += bytes;
    }
    if (total > TOTAL_INLINE_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: `inline payload exceeds ${TOTAL_INLINE_MAX_BYTES} bytes`,
      });
    }
  });

const zSourceUrl = z
  .object({
    kind: z.literal("url"),
    url: z
      .string()
      .min(1)
      .max(URL_MAX_CHARS, `url exceeds ${URL_MAX_CHARS} chars`)
      .url("malformed url"),
    maxBytes: z.number().int().positive().max(URL_MAX_BYTES).optional(),
    solcVersion: z
      .string()
      .regex(SOLC_VERSION_RE, "must be MAJOR.MINOR.PATCH (advisory)")
      .optional(),
    severityFloor: z.enum(SEVERITIES).default("low"),
  })
  .strict();

const zSourceBase64 = z
  .object({
    kind: z.literal("base64"),
    data: z.string().min(1),
    filename: z.string().min(1).max(256),
    solcVersion: z
      .string()
      .regex(SOLC_VERSION_RE, "must be MAJOR.MINOR.PATCH (advisory)")
      .optional(),
    severityFloor: z.enum(SEVERITIES).default("low"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (decodedBase64Bytes(v.data) > PER_FILE_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: `decoded data exceeds ${PER_FILE_MAX_BYTES} bytes`,
      });
    }
  });

/**
 * Author the input as a tagged union via `z.union` (not
 * `z.discriminatedUnion` — `discriminatedUnion` requires each arm to
 * be a bare `ZodObject`, which our `.superRefine`-wrapped arms are
 * not). The `kind` literal in each arm is enough to disambiguate.
 */
export const zAuditInput = z.union([zSourceInline, zSourceUrl, zSourceBase64]);

export const zAuditFinding = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(256),
    severity: z.enum(SEVERITIES),
    file: z.string().min(1).max(512),
    line: z.number().int().nonnegative().optional(),
    description: z.string().min(1).max(8192),
    recommendation: z.string().max(8192),
    source: z.enum(AUDIT_SOURCES),
  })
  .strict();

export const zAuditReport = z
  .object({
    summary: z.string(),
    findings: z.array(zAuditFinding),
    toolsRun: z.array(z.enum(AUDIT_SOURCES)),
    modelId: z.string().min(1).optional(),
  })
  .strict();

export const zArtifact = z
  .object({
    mimeType: z.literal("text/markdown"),
    content: z.string().min(1),
    sha256: z.string().regex(HEX64_RE, "sha256 must be 64 lowercase hex chars"),
    producedAtSec: z.number().int().nonnegative(),
  })
  .strict();

export const zAuditOutput = z
  .object({
    artifact: zArtifact,
    report: zAuditReport,
    sourceBytes: z.number().int().nonnegative(),
  })
  .strict();
