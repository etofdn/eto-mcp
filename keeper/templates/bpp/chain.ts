/**
 * FN-112 / FN-117 — shared signing-chain barrel re-export.
 *
 * The canonical `SigningRuntimeChain` lives in
 * `keeper/bpps/text-summarize/chain-adapter.ts` (FN-075). The other
 * reference BPPs (`code-audit-solidity`, `web-research`, `data-analyze`)
 * already re-export from there; `image-generate` keeps its own
 * byte-identical copy by convention.
 *
 * This module exists so test files and downstream consumers can write
 *   import { SigningRuntimeChain, makeStubSigner } from
 *     "../../keeper/templates/bpp/index.js";
 * instead of reaching into a per-BPP shim. Eliminates the 5 aliased
 * imports in `keeper/bpps/__tests__/handler.complete-task.test.ts` and
 * the per-BPP-named imports in the 6 unit test files listed in FN-117.
 *
 * Single source of truth: do NOT add an independent class here. If the
 * signing logic changes, change `text-summarize/chain-adapter.ts` and
 * the change propagates everywhere via this barrel.
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
} from "../../bpps/text-summarize/chain-adapter.js";
