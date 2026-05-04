# FN-077: Issuers embed `claimCommitments` per §10.3.1

## Summary

All five reference issuer services now embed a per-leaf `claimCommitments`
array into the off-chain VC body **before** computing
`claim_hash = sha256(JCS(vcWithoutProof))`, per
`spec/SINGULARITY-LAYER-1.md` §10.3.1 (ratified by FN-212, primitive landed
by FN-082, and previously documented in the banking JSON-LD templates by
FN-200).

This is **additive** — no existing field is removed — but `claim_hash` for
**newly issued** credentials now binds the per-attribute Poseidon-2
commitments. Pre-FN-077 issued credentials are unaffected; their existing
on-chain `claim_hash` continues to validate against their original
(no-`claimCommitments`) JCS bytes.

## What changed

- **New shared utility** `src/issuers/claim-commitments.ts` exporting
  `computeClaimCommitments(credentialSubject, opts?)` and the
  `ClaimCommitment` type. Implements §10.3.1 byte-stable lex ordering of
  `fieldPath`s, `idx = 0..n-1`, `commitment = Poseidon2_t3([value, salt, idx])`,
  `saltCommitment = Poseidon2_t3([salt, 0, idx])`, 32-byte LE lowercase hex
  (no `0x`). Salts are sourced from `globalThis.crypto.getRandomValues` by
  default; tests inject deterministic CSPRNGs via the `randomBytes` hook.
- Five reference issuers wired:
  `src/issuers/worldcoin.ts`, `civic.ts`, `kyc-test.ts`, `skill-cert.ts`,
  `bank-mock.ts`. Each builds its VC envelope, computes
  `claimCommitments`, embeds the array on the envelope, and only then
  computes `claim_hash` / pins / submits `IssueCredential`. Each issuer
  exposes an optional `randomBytes` dep for test determinism.
- `tests/issuers/claim-commitments.test.ts` (new) pins the §10.3.1 contract
  end-to-end with KAT regressions against `poseidon2` + `encodeFr` +
  `encodeSalt` + `bytesToHex32`.
- Banking JSON-LD templates (`spec/banking/credentials/*.json`) already
  declare the property courtesy of FN-200 — no template changes here.

## What did NOT change

- `src/issuers/bank.ts` (production banking issuer) is intentionally **not**
  wired in this changeset. A follow-up task (filed via the Fusion board) will
  bring `bank.ts` onto the same path so that production-issued banking
  credentials commit to `claimCommitments`.
- The `eto-zk` Rust crate, on-chain verifier VK, and Groth16 keys are
  untouched. The TS port of Poseidon-2 lives in `src/crypto/poseidon2.ts`
  and is the FN-212-ratified parameter set, KAT-locked against the Rust
  reference.

## Array-leaf encoding (v0)

§10.3.1's encoding table does not enumerate arrays. As a v0 convention this
implementation encodes array leaves via `encodeFr(JSON.stringify(arr))` —
i.e. the string path with NFC + 31-byte truncation + length byte. A
follow-up will be filed if §10.3.1 later mandates per-element encoding.

## Compatibility

- **On-chain:** semantics-additive. New issuances commit to a new
  `claim_hash` value; old credentials still verify against their original
  bytes.
- **Off-chain consumers:** any consumer that re-derives `claim_hash` MUST
  now include the issuer's `claimCommitments` array in its JCS input
  (it is a top-level VC field).
