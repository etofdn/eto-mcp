/**
 * Provider factory + `FakeImageProvider` for the `image:generate` BPP
 * (FN-078).
 *
 * `selectProvider` picks one of `replicate` / `together` / `stability`
 * based on the `ProviderConfig.kind` discriminant; `FakeImageProvider`
 * is the deterministic provider used by tests and the worked example
 * (`IMAGE_GENERATE_FAKE=1`).
 */

import { createHash } from "node:crypto";
import {
  ReplicateImageProvider,
  DEFAULT_REPLICATE_MODEL,
} from "./replicate.js";
import {
  TogetherImageProvider,
  DEFAULT_TOGETHER_MODEL,
} from "./together.js";
import { StabilityImageProvider } from "./stability.js";
import type {
  GenerateRequest,
  GenerateResult,
  ImageProvider,
  ProviderConfig,
  ProviderDeps,
} from "./types.js";

export {
  ReplicateImageProvider,
  DEFAULT_REPLICATE_MODEL,
  REPLICATE_API_BASE,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from "./replicate.js";
export {
  TogetherImageProvider,
  DEFAULT_TOGETHER_MODEL,
  TOGETHER_API_URL,
} from "./together.js";
export {
  StabilityImageProvider,
  DEFAULT_STABILITY_MODEL,
  STABILITY_API_URL,
} from "./stability.js";
export type {
  ImageProvider,
  GenerateRequest,
  GenerateResult,
  ProviderConfig,
  ProviderDeps,
  ReplicateProviderConfig,
  TogetherProviderConfig,
  StabilityProviderConfig,
  FetchLike,
} from "./types.js";

/**
 * Factory: pick the right provider for `cfg`.
 *
 * NB: missing API keys throw `provider_unconfigured: <kind>` from the
 * provider constructor — this factory doesn't try to validate ahead.
 */
export function selectProvider(
  cfg: ProviderConfig,
  deps: ProviderDeps = {},
): ImageProvider {
  switch (cfg.kind) {
    case "replicate":
      return new ReplicateImageProvider(cfg, deps);
    case "together":
      return new TogetherImageProvider(cfg, deps);
    case "stability":
      return new StabilityImageProvider(cfg, deps);
    default: {
      // exhaustive guard
      const _never: never = cfg;
      throw new Error(`unknown provider kind: ${String(_never)}`);
    }
  }
}

/**
 * Resolve the provider kind from env when a `ProviderConfig` is not
 * known up front (used by `main.ts`). Honours
 * `IMAGE_GENERATE_PROVIDER`, otherwise falls back to whichever API
 * token is present in the environment.
 */
export function resolveProviderConfigFromEnv(): ProviderConfig | null {
  const requested = process.env.IMAGE_GENERATE_PROVIDER;
  if (requested === "replicate" || process.env.REPLICATE_API_TOKEN) {
    return {
      kind: "replicate",
      model: process.env.REPLICATE_MODEL ?? DEFAULT_REPLICATE_MODEL,
    };
  }
  if (requested === "together" || process.env.TOGETHER_API_KEY) {
    return {
      kind: "together",
      model: process.env.TOGETHER_MODEL ?? DEFAULT_TOGETHER_MODEL,
    };
  }
  if (requested === "stability" || process.env.STABILITY_API_KEY) {
    return { kind: "stability" };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* FakeImageProvider                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Canonical 67-byte 1×1 transparent PNG. `IDAT` chunk data starts at
 * byte offset 41 (8-byte sig + IHDR{12+13+4} = 8+25 = 33 → next chunk
 * length(4)+type(4) = +8 → 41). `IDAT` content runs 41..58.
 *
 * We override the first 16 bytes of the IDAT data with a sha256
 * prefix of the prompt so that two distinct prompts produce distinct
 * byte sequences (the resulting PNG will not decode as a real image —
 * the IDAT zlib stream is corrupted — but tests only assert on byte
 * identity / sha256, never on pixel decoding).
 */
const TRANSPARENT_PNG_1X1: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

const IDAT_DATA_OFFSET = 41;

export class FakeImageProvider implements ImageProvider {
  public readonly kind = "fake";
  public readonly modelId: string;

  public constructor(opts: { readonly modelId?: string } = {}) {
    this.modelId = opts.modelId ?? "fake-model";
  }

  public async generate(req: GenerateRequest): Promise<GenerateResult> {
    const digest = createHash("sha256")
      .update(req.prompt, "utf8")
      .digest();
    const bytes = new Uint8Array(TRANSPARENT_PNG_1X1);
    // Overwrite first 13 bytes of IDAT chunk data (the chunk is exactly
    // 13 bytes long per the IHDR LEN=13 above) with a digest prefix so
    // distinct prompts ⇒ distinct byte sequences.
    for (let i = 0; i < 13; i += 1) {
      bytes[IDAT_DATA_OFFSET + i] = digest[i] ?? 0;
    }
    return {
      bytes,
      mimeType: "image/png",
      providerJobId: `fake-${digest.toString("hex").slice(0, 16)}`,
      modelId: this.modelId,
    };
  }
}
