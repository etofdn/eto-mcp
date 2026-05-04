# FN-058: Caller-binding signature on skill-cert issuer

## Summary

Closes a SECURITY HIGH credential-squatting / race-front-run bug in
`src/issuers/skill-cert.ts`: the issuer accepted any caller's claim that a
given `subjectAgentCard` belonged to them, then minted an on-chain skill
credential bound to that pubkey. Because the binding store is first-write-
wins, an attacker who learned a whitelisted `(skill, victim)` tuple
(public on the allowlist surface) could front-run the legitimate owner and
permanently lock them out of their own skill credential.

## Fix

Adds the caller-binding-signature convention already in use by
`civic.ts` and `worldcoin.ts`:

- New `AgentCardSignatureVerifier` interface in `skill-cert.types.ts`,
  injected via `SkillCertIssuerDeps.signatureVerifier` (defaults to a
  Node-`crypto` Ed25519 implementation, `ed25519SkillCertSignatureVerifier`).
- New required request fields `agentCardSignature` (base64 Ed25519 signature)
  and `issuanceNonce` (caller-supplied freshness string).
- New canonical preimage helper `skillCertSignaturePreimage` returning
  `sha256("eto:skill-cert:v1" || skill || subjectAgentCard || issuanceNonce)`.
- New error code `INVALID_AGENT_CARD_SIGNATURE` (HTTP 401).
- Signature verification runs **between request shape validation and the
  idempotency / whitelist / chain steps**. A request whose signature does
  not validate against `subjectAgentCard` is rejected 401 before any
  side effect (no binding-store read, no whitelist call, no on-chain tx).

## Wire compatibility

This is a breaking change for callers of the `skill-cert` issuer — every
request body now requires `agentCardSignature` and `issuanceNonce`. The
five reference BPPs that consume this issuer must sign their issuance
requests with their AgentCard keypair before re-running their bootstrap
flow. The on-chain credential schema (`schemaIdForSkill`) and PDA layout
are unchanged.

## Tests

- Adds happy-path test using a real Ed25519 keypair.
- Adds front-run test where `subjectAgentCard != signer` and asserts 401
  rejection BEFORE any binding-store / whitelist / chain interaction.
- Adds preimage-binding tests (wrong skill in preimage, empty signature,
  empty nonce) all returning 401 with no side effects.
