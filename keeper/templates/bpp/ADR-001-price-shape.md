# ADR-001: Canonical Price Shape for BPP Catalog Responses

**Status:** Accepted  
**Date:** 2026-05-04  
**Deciders:** FN-077

## Context

FN-201 acceptance criteria originally specified prices in integer cents
(`{ amount: number, currency: "USD" }`). However, every shipping BPP
(data-analyze, code-audit-solidity, text-summarize, web-research,
image-generate, bank) already uses the token-denominated shape
`{ amount: string, currency: "ETO" }` via `keeper/templates/bpp/`.
Migrating all BPPs to integer cents would require touching every
catalog file plus the bpp-keeper runtime, the credential-gate, and
downstream conformance tests — scope that belongs in separate,
deliberate refactor tasks rather than a blocking prerequisite.

## Decision

**Keep the existing token-denominated price shape:**

```ts
{ amount: string; currency: "ETO" | string }
```

This is the canonical shape for BPP catalog responses. All BPPs MUST
use this shape. The FN-201/FN-202 acceptance criteria that reference
"price in cents" are amended: cents-denominated USD prices are out of
scope for the current BPP tier. Fiat amounts (if needed for display)
are a UI concern and MUST be converted client-side from the ETO amount
using the published exchange rate.

## Consequences

- **No BPP migration required.** All existing BPPs (bank, data-analyze,
  code-audit-solidity, text-summarize, web-research, image-generate)
  are already conformant.
- **FN-201/FN-202** acceptance criteria must be updated to remove the
  "price in cents" requirement or explicitly scope it to a future
  fiat-denomination tier.
- **New BPPs** MUST use `{ amount: string; currency: string }` and
  document their token unit in their README.
- **Follow-up tasks:** If a fiat-denominated tier is later required,
  open a new task (not a retroactive migration) scoped to the
  conformance layer only.
