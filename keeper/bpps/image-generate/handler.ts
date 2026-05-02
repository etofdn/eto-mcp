/**
 * `image:generate` BPP handler (FN-078).
 *
 * Validates the inbound request, calls the injected `ImageProvider`,
 * pins the bytes via the injected `BppIpfsPinner`, computes the
 * artifact sha256, and returns a structured `ImageGenerateOutput`.
 *
 * All errors — including schema validation failures — surface as
 * `{ status: "failure", reason }` with one of these stable codes so
 * the runtime routes them through `chain.failTask`:
 *
 *   - `input_invalid`         — request payload failed Zod schema
 *   - `provider_unconfigured` — provider lacked its API key/env
 *   - `provider_error`        — provider returned a non-success state
 *   - `provider_timeout`      — provider exceeded its poll budget
 *   - `ipfs_unconfigured`     — no pinner could be selected
 *   - `ipfs_error`            — pinner POST failed
 *   - `internal_error`        — anything else
 */

import { createHash } from "node:crypto";
import type { BppHandler, TaskResult } from "../../templates/bpp/index.js";
import type {
  Artifact,
  ImageFormat,
  ImageGenerateInput,
  ImageGenerateOutput,
  ImageMimeType,
} from "./types.js";
import {
  DEFAULT_DIMENSION,
  DEFAULT_STEPS,
  zImageGenerateInput,
} from "./types.js";
import type {
  GenerateRequest,
  GenerateResult,
  ImageProvider,
} from "./providers/types.js";
import type { BppIpfsPinner } from "./ipfs.js";

export interface CreateImageGenerateHandlerDeps {
  readonly provider: ImageProvider;
  readonly ipfs: BppIpfsPinner;
  /** Wall-clock seconds. Default `Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
  /** Wall-clock ms. Default `Date.now()`. Used for `durationMs`. */
  readonly nowMs?: () => number;
}

export function createImageGenerateHandler(
  deps: CreateImageGenerateHandlerDeps,
): BppHandler<unknown, ImageGenerateOutput> {
  const now = deps.now ?? defaultNow;
  const nowMs = deps.nowMs ?? (() => Date.now());
  return {
    async handleTask(req): Promise<TaskResult<ImageGenerateOutput>> {
      const parsed = zImageGenerateInput.safeParse(req.input);
      if (!parsed.success) {
        return {
          status: "failure",
          reason: `input_invalid: ${flattenZodIssues(parsed.error.issues)}`,
        };
      }
      const input = parsed.data as ImageGenerateInput;

      const genReq: GenerateRequest = {
        prompt: input.prompt,
        width: input.width ?? DEFAULT_DIMENSION,
        height: input.height ?? DEFAULT_DIMENSION,
        steps: input.steps ?? DEFAULT_STEPS,
        ...(input.negativePrompt !== undefined
          ? { negativePrompt: input.negativePrompt }
          : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      };

      const start = nowMs();
      let result: GenerateResult;
      try {
        result = await deps.provider.generate(genReq);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      const sha256 = sha256Hex(result.bytes);
      const ext = mimeToExt(result.mimeType, input.outputFormat);
      let pin;
      try {
        pin = await deps.ipfs.pinBytes(result.bytes, {
          mimeType: result.mimeType,
          filename: `${req.taskId}.${ext}`,
        });
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      const artifact: Artifact = {
        mimeType: result.mimeType,
        ipfsUri: pin.uri as `ipfs://${string}`,
        cid: pin.cid,
        sha256,
        sizeBytes: pin.size,
        producedAtSec: now(),
        prompt: input.prompt,
      };
      const output: ImageGenerateOutput = {
        artifact,
        provider: deps.provider.kind,
        modelId: result.modelId,
        providerJobId: result.providerJobId,
        durationMs: Math.max(0, nowMs() - start),
      };
      return { status: "success", output };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

const KNOWN_REASON_PREFIXES = [
  "input_invalid",
  "provider_unconfigured",
  "provider_error",
  "provider_timeout",
  "ipfs_unconfigured",
  "ipfs_error",
];

function stableReason(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  for (const k of KNOWN_REASON_PREFIXES) {
    if (msg.startsWith(k)) return msg;
  }
  return `internal_error: ${msg}`;
}

function mimeToExt(mime: ImageMimeType, requested?: ImageFormat): string {
  if (requested) return requested;
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/webp") return "webp";
  return "png";
}
