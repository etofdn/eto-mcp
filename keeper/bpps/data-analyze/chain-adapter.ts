/**
 * Signing chain adapter for the `data:analyze` BPP (FN-079).
 *
 * Per the FN-079 spec ("import-don't-fork" rule), this BPP re-exports
 * the FN-075 (`text:summarize`) `SigningRuntimeChain` and stub signer
 * verbatim. The signed payload schema, canonical JSON serialiser, and
 * stub signer are identical across the five reference BPPs so a
 * single downstream submitter (FN-082 / FN-085) can verify any
 * BPP's signed envelopes uniformly.
 *
 * If you need to extend the signing surface, do so in the FN-075
 * module — not here — to keep the contract centralised.
 *
 *   TODO(real signer via eto-signing-service): replace the stub signer
 *   with a FROST threshold-ed25519 client.
 */

export {
  SigningRuntimeChain,
  makeStubSigner,
  canonicalJson,
  type Signer,
  type SignedEnvelope,
  type SignedCompletePayload,
  type SignedFailPayload,
  type SignedCallRecord,
  type SigningRuntimeChainOpts,
} from "../text-summarize/chain-adapter.js";
