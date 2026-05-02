/**
 * Public barrel for the BPP keeper template (FN-073, T-2.7.1.1).
 *
 * Downstream consumers (FN-074 credential-gate refinement, FN-075–079
 * reference BPPs, FN-085, FN-179) import from this module:
 *
 *   import {
 *     runBpp, registerBppAgentCard, defaultCredentialGate,
 *     type BppHandler, type BppConfig, type CapabilityTags,
 *   } from "@eto/mcp/keeper/templates/bpp";
 *
 * The module is dev-time tooling and is intentionally excluded from
 * the published `dist/` (see `tsconfig.build.json`).
 */

export * from "./types.js";
export * from "./register.js";
export * from "./credential-gate.js";
export * from "./runtime.js";
