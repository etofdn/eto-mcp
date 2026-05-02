/**
 * Signing chain adapter for the `code:audit:solidity` BPP (FN-076).
 *
 * Re-exports `SigningRuntimeChain` and `makeStubSigner` from the
 * sibling `text-summarize` BPP (FN-075). Keeping the implementation
 * single-sourced lets all reference BPPs share the canonical-JSON
 * signing payload schema.
 *
 *   // keep in sync with FN-075
 *
 * If FN-075 ever ships its signing logic via a shared module, this
 * file can collapse to a one-line re-export and the comment above
 * dropped.
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
