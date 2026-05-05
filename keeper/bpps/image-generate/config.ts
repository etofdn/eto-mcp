/**
 * Capability tags and runtime config for the `image:generate` BPP
 * (FN-078). Mirrors the `text:summarize` (FN-075) pattern so FN-077 /
 * FN-079 can copy this layout.
 */

import {
  zBppConfig,
  type BppConfig,
  type CapabilityTags,
} from "../../templates/bpp/index.js";

/**
 * Fixed dev pubkey used as the BPP authority in examples and tests.
 * Real deployments override via the `IMAGE_GENERATE_AUTHORITY` env.
 */
export const DEV_AUTHORITY_PUBKEY =
  "ImageGenerateBppAuthority11111111111111111";

/** Canonical capability tags advertised by `image:generate` v1.0.0. */
export const tags: CapabilityTags = {
  domain: "image",
  action: "generate",
  version: "1.0.0",
  price: { amount: "0.50", currency: "ETO", cents: 50 },
  // TODO(FN-081): once the verified-human credential schema lands,
  // populate this with `{ schema: <verified-human-hash>, ... }` so the
  // BPP rejects anonymous BAPs at Beckn `init` time.
  requiredCredentials: [],
  description:
    "Generate an image from a text prompt and pin the resulting bytes " +
    "to IPFS, returning the ipfs:// URI as a signed artifact. Supports " +
    "Replicate / Together / Stability behind a single ImageProvider seam.",
};

/** Resolve the BPP authority from env, falling back to the dev pubkey. */
export function resolveAuthority(): string {
  return process.env.IMAGE_GENERATE_AUTHORITY ?? DEV_AUTHORITY_PUBKEY;
}

/** Build the runtime `BppConfig`. Reads env at call time, not module-load. */
export function buildConfig(): BppConfig {
  return {
    name: "image-generate-bpp",
    modelId: process.env.IMAGE_GENERATE_MODEL ?? "flux-schnell",
    authority: resolveAuthority(),
    capabilityTags: tags,
    requiredBapCredentials: [],
    handlerTimeoutSec: 180,
  };
}

/** Canonical config snapshot. Captured once at module load for ergonomics. */
export const config: BppConfig = buildConfig();

// Assert at module load that `config` parses cleanly against the
// template schema. A deviation here is a programming error and should
// surface as a hard failure when the BPP is imported.
zBppConfig.parse(config);
