export { authenticate, requireCapability, runWithAuth, type AuthContext } from "./auth.js";
export { createSession, verifySession, createDevSession, hasCapability, CAPABILITY_SCOPES, type SessionPayload, type Capability, type AuthStrategy } from "./session.js";
export { rateLimiter, RateLimiter } from "./rate-limiter.js";
export {
  becknRouter,
  createBecknApp,
  becknRequestSchema,
  becknError,
  type BecknAction,
  type BecknContext,
  type BecknRequest,
  type BecknAckResponse,
  type BecknNackResponse,
} from "./beckn.js";
// FN-092 follow-up: the inbound-bap router/pipeline + StubOnChainSearchClient
// + FixtureCatalogResponseAggregator + their typing surface were planned for
// the bridge conformance work but never landed in src/gateway/inbound-bap.ts.
// The re-export block kept building because TypeScript only validates type
// names at the .d.ts boundary while the runtime values resolved to undefined,
// which silently broke `tests/bridge-conformance.test.ts` (TypeError:
// StubOnChainSearchClient is not a constructor) and through that the
// `typecheck · test · build` required check on every PR.
// Removed from the public re-exports until inbound-bap.ts ships them. The
// existing inbound-bap surface (mountInboundBap, becknSearchToOnChainArgs,
// stubSubmit, etc.) keeps working untouched — see src/gateway/inbound-bap.ts.
export {
  postOnSearch,
  validateCallbackUri,
  CallbackTargetForbidden,
  CallbackTimeout,
  CallbackHttpError,
  type BecknOnSearchEnvelope,
} from "./inbound-bap-callback.js";
export {
  createInboundBppConfirmHandler,
  defaultForwardConfirm,
  defaultPostBapCallback,
  isBapUriAllowed,
  type OnConfirmEnvelope,
  type ForwardConfirmFn,
  type PostBapCallbackFn,
} from "./inbound-bpp.js";
export {
  dispatchOnSearch,
  buildBppOnSearchEnvelope,
  postBppOnSearch,
  stubGetCatalogResponses,
  stringifyBppEnvelope,
  validateOnSearchEnvelope,
  isPrivateOrLoopbackHost,
  type BppCatalogRow,
  type BppOnSearchEnvelope,
  type OutboundBppDeps,
  type PostBppOnSearchResult,
} from "./outbound-bpp.js";
