# FN-200: claimCommitments block in banking credential JSON-LD templates

## Summary

Extends the four banking credential schemas in `spec/banking/credentials/` to
include the §10.3.1 `claimCommitments` JSON-LD block ratified by FN-212 and
implemented in FN-082.

## Affected templates

- `spec/banking/credentials/account-checking.json`
- `spec/banking/credentials/account-savings.json`
- `spec/banking/credentials/card-debit.json`
- `spec/banking/credentials/tax-1099.json`

## Changes

Each schema now:

1. Declares `claimCommitments` in `properties` and `required`.
2. Pins the per-entry shape from §10.3.1: `{ fieldPath, idx, commitment, saltCommitment }`,
   with `commitment` / `saltCommitment` constrained to 64-hex (32-byte LE).
3. Ships a worked `examples[]` envelope whose `claimCommitments` array contains
   **real Poseidon-2 outputs over BN254 `Fr`, `t=3`** produced by
   `eto-zk-cli commit` (FN-082) — not placeholder hex.

## Reproducibility

Two helper scripts are checked in alongside the schemas:

- `scripts/fn-200-build-commitments.mjs` — drives `eto-zk-cli commit` over the
  example credentialSubject objects and emits the full claimCommitments arrays.
- `scripts/fn-200-emit-schemas.mjs` — patches each schema with the
  `claimCommitments` definition + worked example.

Salts in the example envelopes are deterministic test salts (byte `i+1`
repeated 32 times for the i-th sorted entry). Real issuers MUST sample salts
from a CSPRNG and never reuse them.

## Tests

`tests/bank/credential-schemas.test.ts` (new) compiles each schema under
ajv 2020-12 and asserts the embedded example validates, that
`claimCommitments` covers every credentialSubject leaf, and that entries are
sorted lexicographically by `fieldPath` with `idx` matching position.

## Unblocks

- FN-077 — selective-disclosure ZK proof embedding via `claim_commitment` slot 0.
- Bank issuer flows that emit checking / savings / card / 1099 credentials now
  have a concrete schema-of-record for the `claimCommitments` envelope.
