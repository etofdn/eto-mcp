---
"@eto/mcp": major
---

**Breaking:** `CapabilityTags.price.cents` is now required (TypeScript and Zod).

Previously `cents` was an optional additive field introduced by FN-098. As of FN-102,
all six reference BPPs (bank, code-audit-solidity, text-summarize, web-research,
data-analyze, image-generate) populate `cents`, so the optional escape hatch is removed.

**Why:** `cents` is the canonical integer minor-unit settlement amount. Making it required
eliminates the silent-zero failure mode where downstream settlement consumers would
coalesce a missing field to 0 instead of failing fast.

**Migration:** Add `cents: <integer minor units>` to your `capabilityTags.price` object.
For ETO amounts, multiply the decimal `amount` by 100 (e.g. `"0.50"` → `cents: 50`).
For zero-cost BPPs use `cents: 0`. A BPP that omits this field now fails
`zBppConfig.parse()` at boot.
