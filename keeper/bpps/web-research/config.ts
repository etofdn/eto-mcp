/**
 * Capability tags and runtime config for the `web:research` BPP
 * (FN-077). Mirrors the FN-075 / FN-076 pattern.
 */

import type { BppConfig, CapabilityTags } from "../../templates/bpp/index.js";

/**
 * Fixed dev pubkey used as the BPP authority in examples and tests.
 * Real deployments override via `WEB_RESEARCH_AUTHORITY`.
 */
export const DEV_AUTHORITY_PUBKEY =
  "WebResearchBppAuthority11111111111111111111";

/** Canonical capability tags advertised by `web:research` v1.0.0. */
export const tags: CapabilityTags = {
  domain: "web",
  action: "research",
  version: "1.0.0",
  price: { amount: "0.50", currency: "ETO", cents: 50 },
  // TODO(FN-081): once the verified-human credential schema lands,
  // populate this with the schema hash so the BPP rejects anonymous
  // BAPs at Beckn `init`.
  requiredCredentials: [],
  description:
    "Run a structured multi-step web search for a research question. " +
    "Plans sub-queries, fans out across an injected search provider, " +
    "fetches and extracts top sources, and synthesises a sourced " +
    "Markdown report with an executive summary, numbered findings, and " +
    "a citation list referencing every source by URL and access time.",
};

/** Resolve the BPP authority from env, falling back to the dev pubkey. */
export function resolveAuthority(): string {
  return process.env.WEB_RESEARCH_AUTHORITY ?? DEV_AUTHORITY_PUBKEY;
}

/** Build the runtime `BppConfig`. Reads env at call time, not module-load. */
export function buildConfig(): BppConfig {
  return {
    name: "web-research-bpp",
    modelId: process.env.KEEPER_MODEL ?? "claude-sonnet-4-6",
    authority: resolveAuthority(),
    capabilityTags: tags,
    requiredBapCredentials: [],
    handlerTimeoutSec: 180,
  };
}

/** Canonical config snapshot. Captured once at module load for ergonomics. */
export const config: BppConfig = buildConfig();
