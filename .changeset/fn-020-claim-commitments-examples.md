# FN-020: Banking credential `claimCommitments` examples — consolidation

## Summary

Confirms and pins the §10.3.1 `claimCommitments` block in the four banking
credential JSON-LD templates under `spec/banking/credentials/`. The structural
schema additions and worked examples (with real Poseidon-2 hex) were
originally landed by **FN-200**; the producer primitive
`computeClaimCommitments` was landed by **FN-077** as
`src/issuers/claim-commitments.ts`. This changeset records FN-020's
verification pass and explicitly unblocks the downstream verification gates.

## Affected templates

- `spec/banking/credentials/account-checking.json`
- `spec/banking/credentials/account-savings.json`
- `spec/banking/credentials/card-debit.json`
- `spec/banking/credentials/tax-1099.json`

## Per-entry contract (§10.3.1)

Each entry binds one leaf of `credentialSubject`:

| Field            | Definition                                                                          |
|------------------|-------------------------------------------------------------------------------------|
| `fieldPath`      | Dot-separated leaf path under `credentialSubject` (e.g. `credentialSubject.holder`) |
| `idx`            | 0-based position in the **byte-stable** lex sort of leaf `fieldPath`s               |
| `commitment`     | 32-byte LE lowercase hex of `Poseidon2_t3([encodeFr(value), encodeSalt(salt), Fr(idx)])` |
| `saltCommitment` | 32-byte LE lowercase hex of `Poseidon2_t3([encodeSalt(salt), 0, Fr(idx)])`          |

`idx` MUST equal the `field_index` public input of
`verify_credential_predicate`, so the lex-sort over leaf paths is the
security-critical contract that lets selective-disclosure proofs match.

## Example hex

The `examples[0].claimCommitments` block in each schema contains **real
Poseidon-2 outputs** (BN254 Fr, t=3) — never placeholders. They were
originally produced by `eto-zk-cli commit` (FN-082) using deterministic test
salts (byte `i+1` repeated 32 times for the i-th sorted entry). Production
issuers MUST sample fresh CSPRNG salts per attribute (see
`src/issuers/claim-commitments.ts` — FN-077).

## Test coverage

`tests/bank/credential-schemas.test.ts` is the round-trip + drift guard:

1. Asserts each schema declares `claimCommitments` in `required` and that
   `properties.claimCommitments.items.required` covers
   `[fieldPath, idx, commitment, saltCommitment]`.
2. Asserts every `commitment` and `saltCommitment` matches `/^[0-9a-f]{64}$/`
   and that `claimCommitments[i].idx === i` with lex-sorted `fieldPath`s.
3. Re-derives a fresh `claimCommitments` array via `computeClaimCommitments`
   (FN-077) against `examples[0].credentialSubject`, swaps it into a
   synthetic example, and asserts the synthetic example still validates
   against the schema. This is the contract guarantee that the producer
   primitive and the schema agree, even though CSPRNG salts make raw hex
   non-deterministic.

## Downstream

This changeset unblocks the schema-validation gates filed as **FN-069**,
**FN-076**, and **FN-086**, and confirms the consumer shape `computeClaimCommitments`
(FN-077) emits matches the per-entry contract pinned here. Wiring of
`computeClaimCommitments` into `src/issuers/bank.ts` and
`keeper/bpps/bank/handlers/tax-1099-sketch.ts` remains FN-077 / FN-063 /
FN-064 work and is intentionally out of scope here.

## References

- `spec/SINGULARITY-LAYER-1.md` §10.3.1 — canonical entry contract.
- FN-082 — Poseidon-2 t=3 over BN254 (`src/crypto/poseidon2.ts`).
- FN-077 — `src/issuers/claim-commitments.ts` (`computeClaimCommitments`).
- FN-200 — original schema + example landing.
