/**
 * Public barrel for `eto-mcp/keeper/lib` (FN-074, T-2.7.1.2).
 *
 * Re-exports the composable BAP credential-gating helpers so BPP
 * authors can write:
 *
 *   import { requireCred, composeGates } from "../../keeper/lib";
 *
 * The module is dev-time tooling and is intentionally excluded from
 * the published `dist/` (same policy as `keeper/templates/**`).
 */

export * from "./cred-gate.js";
