/**
 * Signing chain adapter for the bank-as-BPP keeper module
 * (FN-096 / T-3.9.1.2).
 *
 * Thin re-export and specialisation of the `SigningRuntimeChain` pattern
 * established in `bpps/text-summarize/chain-adapter.ts`.  The bank BPP
 * reuses the exact same implementation without modification — any future
 * bank-specific signing extensions belong here, NOT in the shared
 * text-summarize module.
 *
 * TODO(factor-out): the duplication between this file and the
 * text-summarize chain-adapter is intentional per FN-096 scope — do NOT
 * factor a shared module in this task.  A cleanup task should be created
 * via fn_task_create if the duplication becomes maintenance-burdensome.
 *
 * TODO(real signer via eto-signing-service): replace `makeStubSigner` with
 * a FROST threshold-ed25519 client once FN-082/FN-085 land.
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
