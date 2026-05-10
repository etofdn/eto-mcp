---
"@eto/mcp": patch
---

FN-066: Audited the `GatewayConfig` / `RuntimeConfig` surface area deleted by
FN-067 from `src/config.ts`. Confirmed via repo-wide grep that none of those
symbols (`GatewayConfig`, `RuntimeConfig`, `loadGatewayConfig`, `loadCivicConfig`,
`loadAppConfig`, `validateNetwork`) have any remaining callers outside the file
itself. The shapes were not viable replacements for the canonical `RuntimeConfig`
singleton (Block 2 lacked `auth.sessionTtlSeconds`, `auth.refreshTtlSeconds`,
`tx`, and `chain`; Block 3 lacked `etoRpcUrl` and `tx` entirely).

`loadAppConfig`, `loadCivicConfig`, and `loadBecknBridgeConfig` are retained
verbatim as they serve the issuers layer (`src/issuers/`). The `RuntimeConfig`
singleton (`config`) exported from `src/config.ts` is the single source of
truth for all 14 non-issuer callers — no migration needed.
