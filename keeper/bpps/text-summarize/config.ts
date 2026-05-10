/**
 * Capability tags and runtime config for the `text:summarize` BPP
 * (FN-075). The values here are the canonical pattern the four
 * sibling reference BPPs (FN-076–079) will mirror.
 */

import type { BppConfig, CapabilityTags } from "../../templates/bpp/index.js";

/**
 * Fixed dev pubkey used as the BPP authority in examples and tests.
 * Real deployments override via the `TEXT_SUMMARIZE_AUTHORITY` env.
 */
export const DEV_AUTHORITY_PUBKEY =
  "TextSummarizeBppAuthority111111111111111111";

/** Canonical capability tags advertised by `text:summarize` v1.0.0. */
export const tags: CapabilityTags = {
  domain: "text",
  action: "summarize",
  version: "1.0.0",
  price: { amount: "0.10", currency: "ETO", cents: 10 },
  // TODO(FN-081): once the verified-human credential schema lands,
  // populate this with `{ schema: <verified-human-hash>, ... }` so the
  // BPP rejects anonymous BAPs at Beckn `init` time.
  requiredCredentials: [],
  description:
    "Summarise an HTML page, PDF, or plain-text input into a concise " +
    "Markdown brief. Supports prose or bullet styles and a configurable " +
    "target length up to 2000 words.",
};

/** Resolve the BPP authority from env, falling back to the dev pubkey. */
export function resolveAuthority(): string {
  return process.env.TEXT_SUMMARIZE_AUTHORITY ?? DEV_AUTHORITY_PUBKEY;
}

/** Build the runtime `BppConfig`. Reads env at call time, not module-load. */
export function buildConfig(): BppConfig {
  return {
    name: "text-summarize-bpp",
    modelId: process.env.KEEPER_MODEL ?? "claude-sonnet-4-6",
    authority: resolveAuthority(),
    capabilityTags: tags,
    requiredBapCredentials: [],
    handlerTimeoutSec: 90,
  };
}

/** Canonical config snapshot. Captured once at module load for ergonomics. */
export const config: BppConfig = buildConfig();
