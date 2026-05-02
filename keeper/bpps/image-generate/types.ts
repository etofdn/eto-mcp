/**
 * Public IO types for the `image:generate` reference BPP (FN-078).
 *
 * Layout mirrors `text:summarize` (FN-075). Inputs are validated by
 * `zImageGenerateInput` at the handler boundary; outputs are signed
 * via the chain adapter and recorded as a structured `Artifact` whose
 * `ipfsUri` points at the pinned image bytes.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Limits / defaults                                                          */
/* -------------------------------------------------------------------------- */

export const PROMPT_MAX_CHARS = 4000;
export const NEGATIVE_PROMPT_MAX_CHARS = 2000;
export const ALLOWED_DIMENSIONS = [256, 512, 768, 1024, 1280, 1536] as const;
export type AllowedDimension = (typeof ALLOWED_DIMENSIONS)[number];
export const DEFAULT_DIMENSION: AllowedDimension = 1024;
export const DEFAULT_STEPS = 8;
export const MAX_STEPS = 50;

export const SUPPORTED_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageFormat = (typeof SUPPORTED_OUTPUT_FORMATS)[number];
export const SUPPORTED_PROVIDERS = [
  "replicate",
  "together",
  "stability",
] as const;
export type ProviderKind = (typeof SUPPORTED_PROVIDERS)[number];

export const SUPPORTED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type ImageMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* IO types                                                                   */
/* -------------------------------------------------------------------------- */

export interface ImageGenerateInput {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly width?: AllowedDimension;
  readonly height?: AllowedDimension;
  readonly steps?: number;
  readonly seed?: number;
  readonly outputFormat?: ImageFormat;
  readonly provider?: ProviderKind;
}

export interface Artifact {
  readonly mimeType: ImageMimeType;
  readonly ipfsUri: `ipfs://${string}`;
  readonly cid: string;
  /** Lowercase 64-char hex sha256 of the raw image bytes. */
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly producedAtSec: number;
  readonly prompt: string;
}

export interface ImageGenerateOutput {
  readonly artifact: Artifact;
  readonly provider: string;
  readonly modelId: string;
  readonly providerJobId: string;
  readonly durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Zod schemas                                                                */
/* -------------------------------------------------------------------------- */

const HEX64_RE = /^[0-9a-f]{64}$/;
const IPFS_URI_RE = /^ipfs:\/\/[a-z0-9]+/;
const CID_RE = /^[a-z0-9]+$/;

const zDimension = z
  .number()
  .int()
  .refine(
    (n): n is AllowedDimension =>
      (ALLOWED_DIMENSIONS as readonly number[]).includes(n),
    {
      message: `must be one of ${ALLOWED_DIMENSIONS.join(", ")}`,
    },
  );

export const zImageGenerateInput = z
  .object({
    prompt: z.string().min(1).max(PROMPT_MAX_CHARS),
    negativePrompt: z.string().max(NEGATIVE_PROMPT_MAX_CHARS).optional(),
    width: zDimension.optional(),
    height: zDimension.optional(),
    steps: z.number().int().min(1).max(MAX_STEPS).optional(),
    seed: z.number().int().nonnegative().optional(),
    outputFormat: z.enum(SUPPORTED_OUTPUT_FORMATS).optional(),
    provider: z.enum(SUPPORTED_PROVIDERS).optional(),
  })
  .strict();

export const zArtifact = z
  .object({
    mimeType: z.enum(SUPPORTED_MIME_TYPES),
    ipfsUri: z.string().regex(IPFS_URI_RE, "must start with ipfs://"),
    cid: z.string().min(1).regex(CID_RE, "cid must be lowercase alphanumeric"),
    sha256: z.string().regex(HEX64_RE, "sha256 must be 64 lowercase hex chars"),
    sizeBytes: z.number().int().nonnegative(),
    producedAtSec: z.number().int().nonnegative(),
    prompt: z.string().min(1).max(PROMPT_MAX_CHARS),
  })
  .strict();

export const zImageGenerateOutput = z
  .object({
    artifact: zArtifact,
    provider: z.string().min(1),
    modelId: z.string().min(1),
    providerJobId: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
