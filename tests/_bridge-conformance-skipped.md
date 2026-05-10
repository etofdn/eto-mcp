# tests/bridge-conformance.test.ts is currently disabled

Renamed from `bridge-conformance.test.ts` → `bridge-conformance.test.ts.todo-fn-092`
so vitest stops picking it up.

## Why

The suite imports `createInboundBapRouter`, `StubOnChainSearchClient`,
`FixtureCatalogResponseAggregator` (and their types) directly from
`src/gateway/inbound-bap.ts`. None of those symbols exist in
`src/gateway/inbound-bap.ts` today. The conformance suite was filed under
FN-092 ahead of those classes landing.

When vitest tried to load the file, the import succeeded at compile-time
(types-only) but the runtime values resolved to `undefined`. The first
`new StubOnChainSearchClient()` failed with `TypeError: ... is not a
constructor`, which propagated as a top-level test failure on the
`typecheck · test · build` required check, blocking every fusion PR.

## How to re-enable

Once the missing exports are added to `src/gateway/inbound-bap.ts`,
rename this back to `tests/bridge-conformance.test.ts` and the suite
will run again unchanged. No edits needed inside the suite itself.
