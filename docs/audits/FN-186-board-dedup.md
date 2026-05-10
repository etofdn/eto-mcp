# FN-186 — Deduplicate overlapping FN board tickets

## Scope

During the FN-002 v3 decomposition pass, three duplicate ticket pairs were created across separate runs of the decomposer:

1. **FN-117 / FN-138** — eUSD / KytTrace amount extension
2. **FN-120 / FN-139** — AmountResolver wiring
3. **FN-124 / FN-140** — Bank Dashboard E2E test

Each pair describes the same scope with at most cosmetic differences. This is pure board hygiene — close the duplicate, keep the canonical.

## Decision rule

For each pair: **keep the earlier-numbered ticket as canonical**, close the duplicate with a pointer comment, and merge any unique acceptance criteria from the duplicate into the survivor before closing.

## Audit results

### Pair 1: FN-117 (canonical) ↔ FN-138 (duplicate)

Both tickets cover extending `eUSD` and `KytTrace` to carry the per-tx amount field needed by the rate stage (FN-054). FN-117 was filed during the v2 decomposition; FN-138 was filed during v3 with identical scope.

- **Canonical:** FN-117
- **Action:** Close FN-138 with comment pointing to FN-117. No unique AC to merge.

### Pair 2: FN-120 (canonical) ↔ FN-139 (duplicate)

Wire `AmountResolver` into the Beckn init/confirm path so the on-chain handler can resolve the price from the Beckn message instead of trusting a duplicated client-side number. Both tickets describe the same wiring.

- **Canonical:** FN-120
- **Action:** Close FN-139 with comment pointing to FN-120. No unique AC to merge.

### Pair 3: FN-124 (canonical) ↔ FN-140 (duplicate)

Add a Bank Dashboard E2E test that exercises onramp → balance → wire → offramp end-to-end. FN-124 lists Playwright as the harness; FN-140 is harness-agnostic. Merge: keep FN-124's harness call-out plus FN-140's "test must run in <60s on CI" budget line.

- **Canonical:** FN-124
- **Action:** Append to FN-124 description: *"E2E suite must complete in <60s on CI (carried from FN-140 ACs)."* Close FN-140 with pointer to FN-124.

## Closures

The closures themselves are DB-level operations on the inner fusion DB (column → `archived` or `done` with a status note). The board tooling does the actual move; this document records the policy decision so the audit trail survives.

## Acceptance criteria

- [x] Each pair compared (sections above)
- [x] Canonical chosen per pair (earlier-numbered)
- [x] Unique AC from duplicates merged into survivor (FN-124 only)
- [x] Closure plan documented (above)
- [x] No new work created — board hygiene only
