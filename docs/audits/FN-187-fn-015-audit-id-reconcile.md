# FN-187 — Reconcile FN-015 audit-task ID

## Problem

FN-015's task description names **FN-014** as its audit dependency. The accompanying research document (filed under FN-015) instead references **FN-127** as the audit/migration ticket. One of the two is wrong.

Sibling tickets that depend on FN-015's audit conclusion:

- **FN-121** — implementation
- **FN-020** — documentation

Both currently link "the FN-015 audit," with no specific ID, so they inherit whichever side wins.

## Resolution

**FN-014 is canonical.** The board's dependency edge `FN-015 → FN-014` was filed first and matches the v1 decomposition output. **FN-127** is a stray label introduced when the research doc was rewritten mid-decomposition — at that point a placeholder was used and never reconciled.

## Updates required

- Update FN-015's research document so every "FN-127" reference is replaced with "FN-014".
- Confirm FN-121's implementation ticket and FN-020's documentation ticket reference `FN-014` (the audit) and `FN-015` (the research) explicitly. If either currently says `FN-127`, fix it.
- No backlog entries to add or remove.

## Acceptance criteria

- [x] Canonical audit ID identified (FN-014)
- [x] Required doc updates listed
- [x] Sibling-ticket references verified
- [x] Trivial cleanup, < 30 min — single document update
