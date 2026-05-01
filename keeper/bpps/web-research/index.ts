/**
 * Public barrel for the `web:research` reference BPP (FN-077).
 *
 * Downstream consumers (FN-082 end-to-end test, FN-085 RPC wiring,
 * sibling reference BPPs that copy this layout) should import from
 * this module:
 *
 *   import {
 *     config, tags,
 *     createWebResearchHandler,
 *     SigningRuntimeChain,
 *     zResearchInput, zResearchOutput,
 *     FakeSearchProvider,
 *   } from "@eto/mcp/keeper/bpps/web-research";
 */

export {
  config,
  tags,
  buildConfig,
  resolveAuthority,
  DEV_AUTHORITY_PUBKEY,
} from "./config.js";
export {
  createWebResearchHandler,
  sha256Hex,
  type CreateWebResearchHandlerDeps,
} from "./handler.js";
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
} from "./chain-adapter.js";
export {
  FakeSearchProvider,
  HttpSearchProvider,
  defaultFakeCorpus,
  domainMatches,
  filterAndCap,
  hostOf,
  type FakeCorpusEntry,
  type FakeSearchProviderOpts,
  type FetchLike as SearchFetchLike,
  type HttpSearchProviderName,
  type HttpSearchProviderOpts,
  type SearchHit,
  type SearchOpts,
  type SearchProvider,
} from "./search-provider.js";
export {
  fetchPage,
  assertPublicHttpUrl,
  DEFAULT_PAGE_MAX_BYTES,
  DEFAULT_PAGE_TIMEOUT_MS,
  type FetchPageDeps,
  type FetchedPage,
  type FetchLike as PageFetchLike,
  type FetchLikeResponse as PageFetchLikeResponse,
} from "./fetcher.js";
export {
  planQueries,
  AnthropicLlmClient,
  loadAnthropicFromEnv,
  MIN_SUB_QUERIES,
  MAX_SUB_QUERIES,
  SUB_QUERY_MAX_CHARS,
  type AnthropicLike,
  type LlmClient,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmMessage,
  type PlanQueriesDeps,
  type PlanQueriesOpts,
  type QueryPlan,
} from "./planner.js";
export {
  synthesize,
  PER_EVIDENCE_CHAR_BUDGET,
  type EvidenceItem,
  type SynthesizeDeps,
  type SynthesizeOpts,
  type SynthesizeResult,
} from "./synthesizer.js";
export {
  zResearchInput,
  zResearchOutput,
  zCitation,
  zResearchReport,
  DEPTH_PROFILES,
  RESEARCH_DEPTHS,
  QUERY_MAX_CHARS,
  MAX_SOURCES_HARD_CAP,
  MAX_TARGET_LENGTH_WORDS,
  DEFAULT_TARGET_LENGTH_WORDS,
  DEFAULT_MAX_SOURCES,
  type Citation,
  type DepthProfile,
  type ResearchDepth,
  type ResearchInput,
  type ResearchOutput,
  type ResearchReport,
} from "./types.js";
export { main } from "./main.js";
