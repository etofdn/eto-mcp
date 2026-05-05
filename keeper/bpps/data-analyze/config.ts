/**
 * Capability tags and runtime config for the `data:analyze` BPP
 * (FN-079). Mirrors the FN-075 (`text:summarize`) pattern so the five
 * reference BPPs share a consistent surface.
 */

import type { BppConfig, CapabilityTags } from "../../templates/bpp/index.js";

/** Fixed dev pubkey used as the BPP authority in examples and tests. */
export const DEV_AUTHORITY_PUBKEY =
  "DataAnalyzeBppAuthority11111111111111111111";

/** Canonical capability tags advertised by `data:analyze` v1.0.0. */
export const tags: CapabilityTags = {
  domain: "data",
  action: "analyze",
  version: "1.0.0",
  price: { amount: "0.25", currency: "ETO", cents: 25 },
  // TODO(FN-081): once the verified-human credential schema lands,
  // populate this with `{ schema: <verified-human-hash>, ... }` so the
  // BPP rejects anonymous BAPs at Beckn `init` time.
  requiredCredentials: [],
  description:
    "Analyse a CSV/TSV dataset (URL, inline text, or base64 blob): " +
    "infer column types, compute summary statistics, surface anomalies, " +
    "and synthesise a Markdown report with findings and suggested " +
    "follow-up questions.",
};

/** Resolve the BPP authority from env, falling back to the dev pubkey. */
export function resolveAuthority(): string {
  return process.env.DATA_ANALYZE_AUTHORITY ?? DEV_AUTHORITY_PUBKEY;
}

/** Build the runtime `BppConfig`. Reads env at call time. */
export function buildConfig(): BppConfig {
  return {
    name: "data-analyze-bpp",
    modelId: process.env.KEEPER_MODEL ?? "claude-sonnet-4-6",
    authority: resolveAuthority(),
    capabilityTags: tags,
    requiredBapCredentials: [],
    handlerTimeoutSec: 180,
  };
}

/** Canonical config snapshot. */
export const config: BppConfig = buildConfig();
