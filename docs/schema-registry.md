# ETO Beckn Schema Registry

> Tracking issue: [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11)
> Closes: FN-179, FN-193, FN-203 (FN-057 follow-through).
>
> **See also:** [`docs/agent-identity-model.md`](./agent-identity-model.md) — the agent identity model (`human × model × environment × session_scope`) that downstream A2A trust decisions evaluate. Disjoint from this credential registry.
>
> **See also:** [`docs/memo-schema-registry.md`](./memo-schema-registry.md) catalogs the disjoint **memo schema** registry (`eto.memo.*`) used to type SPL Memo v2 records anchored by `transfer_native` / `batch` and surfaced via `query_memos`. This document covers **credential schemas** (`eto.beckn.schema.*`), which are W3C VC payloads gated on-chain by `schema_hash = SHA-256(label)`. The two registries share a versioning philosophy but live under disjoint namespaces and have different identity / validation models (on-chain hash gating vs off-chain Ajv validation).

This document catalogs every Beckn-mapped credential schema referenced by the
eto-mcp codebase, their pre-image label (the string that hashes into the on-chain
`schema_hash`), and where the schema is consumed and produced.

## §1 — Why a registry

The on-chain Beckn `IssuerNetwork` accepts credentials gated by their
`schema_hash` (`SHA-256(utf8(<label>))`). Schema labels are ad-hoc strings
sprinkled across `src/issuers/*`, `keeper/bpps/*`, and several test fixtures.
Without a single source of truth:

- New BPPs cannot tell which issuer agents actually mint which credentials.
- Off-chain `verifyHolderCredentials` lookups can drift from on-chain
  `required_credentials` policy.
- Consumers cannot derive the canonical `schema_hash` without re-grepping the
  source tree.

This registry is the single normative list. The `schema_hash` for each label is
computed at boot from the table below; do not hard-code derived hashes
elsewhere.

## §2 — Naming convention

```
eto.beckn.schema.<domain>[.<sub>].<v>
```

- `<domain>` — coarse category (`account`, `card`, `bank`, `kyc`, `verified-human`,
  `sanctions`, `travel-rule`).
- `<sub>` — optional refinement (e.g. `checking`, `savings`, `debit`, `us-test`,
  `fiat-ramp-test`, `global`).
- `<v>` — major version, `v1`, `v2`, ... Schema additions are non-breaking
  (additive only); breaking changes mint a new version.

Pre-image strings are case-sensitive and used **byte-for-byte** as the
`SHA-256` input.

## §3 — Registered schemas (v1)

| Label                                          | Issuer agent                | Consumer                                                      | Source of truth                            |
|------------------------------------------------|-----------------------------|---------------------------------------------------------------|--------------------------------------------|
| `eto.beckn.schema.verified-human.v1`           | issuer (worldcoin proof)    | bank-bpp `verifyHolderCredentials` gate (open-checking, issue-card) | `src/issuers/worldcoin.ts` |
| `eto.beckn.schema.kyc.us-test.v1`              | issuer (kyc-test)           | bank-bpp `verifyHolderCredentials` gate (US test residents)   | `src/issuers/kyc-test.ts`                  |
| `eto.beckn.schema.account-holder.v1`           | issuer (bank-mock)          | derived attest after open-checking succeeds                   | `src/issuers/bank.ts`                      |
| `eto.beckn.schema.account.checking.v1`         | bank-bpp (open-checking)    | spec template `spec/banking/credentials/account-checking.json` | `src/issuers/bank.ts:buildAccountCheckingVc` |
| `eto.beckn.schema.account.savings.v1`          | bank-bpp (open-savings)     | spec template `spec/banking/credentials/account-savings.json`  | `src/issuers/bank.ts:buildAccountSavingsVc`  |
| `eto.beckn.schema.card.debit.v1`               | bank-bpp (issue-card)       | spec template `spec/banking/credentials/card-debit.json`       | `src/issuers/bank.ts:buildCardDebitVc`       |
| `eto.beckn.schema.bank.fiat-ramp-test.v1`      | bank-bpp (onramp / offramp) | bank dashboard onramp launcher                                | `keeper/bpps/bank/handlers/onramp.ts`      |
| `eto.beckn.schema.sanctions.global.v1`         | sanctions-screener (stub)   | bank-bpp catalog `required_credentials` (always required)     | `keeper/bpps/bank/catalog.json`            |
| `eto.beckn.schema.travel-rule.v1`              | bank-bpp (wire transfer)    | wire transfer + audit-trail                                   | `keeper/bpps/bank/handlers/wire.ts`        |

## §4 — Schema body templates

JSON Schema (Draft 2020-12) templates live under `spec/banking/credentials/`:

- `account-checking.json` — pre-image: `eto.beckn.schema.account.checking.v1`
- `account-savings.json` — pre-image: `eto.beckn.schema.account.savings.v1`
- `card-debit.json` — pre-image: `eto.beckn.schema.card.debit.v1`
- `tax-1099.json` — pre-image: `eto.beckn.schema.tax.1099.v1` (placeholder; not
  yet wired into an issuer)

Each template carries `@context`, `type`, `credentialSubject`, `claim_hash`,
`issuerAuthority` and (per FN-077, in flight) a `claimCommitments` block for
selective-disclosure ZK gating.

## §5 — Hash derivation

Both off-chain (`src/issuers/bank.types.ts`) and on-chain
(`programs/beckn/src/types.rs`) compute:

```
schema_hash = SHA-256(utf8(<label>))
```

There is exactly one well-known function per side; both must agree byte-for-byte.
A deterministic test in `tests/unit/schema-hash-parity.test.ts` enforces this
invariant when run against a freshly built Rust binary (gated on
`SCHEMA_HASH_PARITY_BIN`).

## §6 — Adding a new schema

1. Add the label string to the registry table above (§3) with a one-line
   description of issuer/consumer.
2. If the schema has a body, add a JSON Schema template under
   `spec/banking/credentials/`.
3. Add the constant to `src/issuers/bank.types.ts` (or the relevant per-domain
   types file).
4. If the on-chain Network needs to gate on it, add to the issuer's
   `issuable_schemas` and the consuming Network's `required_credentials`.
5. Bump the version (`v1` → `v2`) on any breaking change. Never reuse a label
   for a different shape.

## §7 — Out-of-scope (for v1)

- Cross-protocol mapping (W3C VC ↔ DIF Presentation Exchange): the registry
  catalogs labels but does not yet emit the W3C/DIF interop tables.
- DID-based discovery: schemas are looked up by label, not by DID document.
- Cryptographic schema commitments: today the `schema_hash` is `SHA-256(label)`,
  not `SHA-256(canonical-JSON-of-template)`. Tracked in FN-057's open-questions
  list as a follow-up.
