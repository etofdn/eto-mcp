# FN-063: Bank production issuer embeds `claimCommitments` per §10.3.1

## Summary

Wires `computeClaimCommitments` into `src/issuers/bank.ts` (the
production banking issuer covering `account.checking.v1`,
`account.savings.v1`, and `card.debit.v1`), mirroring the pattern landed
by FN-077 for the five reference issuers (`worldcoin`, `civic`,
`kyc-test`, `skill-cert`, `bank-mock`).

For every newly issued bank credential, the shared `issueCredential`
helper now:

1. Builds the off-chain VC envelope via the per-kind `build*Vc` factory.
2. Computes per-leaf Poseidon-2 commitments over `credentialSubject`
   using `src/issuers/claim-commitments.ts`.
3. Embeds the resulting array under top-level `claimCommitments` on the
   VC **before** JCS canonicalisation.
4. Computes `claim_hash = sha256(JCS(vc))` over the VC *with*
   `claimCommitments` so the on-chain hash binds them.
5. Submits `IssueCredential` and pins the canonicalised JCS as the
   off-chain `claim_uri`.

## Test surface

`BankIssuerDeps.randomBytes?: (len: number) => Uint8Array` is now a
public injection point — defaulting to `globalThis.crypto.getRandomValues`
in production, but overridable in tests so commitment outputs (and
therefore `claim_hash`) are deterministic and pinnable as KAT regressions.
This matches the surface already exposed by `BankMockIssuerDeps`,
`KycTestIssuerDeps`, `CivicIssuerDeps`, and the worldcoin / skill-cert
deps.

## Compatibility

- Additive on the `BankIssuerDeps` surface (`randomBytes` is optional).
- Pre-FN-063 issued bank credentials are unaffected; their existing
  on-chain `claim_hash` continues to validate against their original
  pre-image.
- Newly issued bank credentials' `claim_hash` now binds
  `claimCommitments`, completing §10.3.1 conformance across the
  production issuer surface.
