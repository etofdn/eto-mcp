/**
 * Public barrel for the `data:analyze` reference BPP (FN-079).
 */

export {
  config,
  tags,
  buildConfig,
  resolveAuthority,
  DEV_AUTHORITY_PUBKEY,
} from "./config.js";
export {
  createDataAnalyzeHandler,
  buildHandlerFromPrimitives,
  type CreateHandlerDeps,
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
  fetchCsv,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  type FetchLike,
  type FetchLikeResponse,
  type FetchCsvDeps,
  type FetchedCsv,
} from "./source-loader.js";
export {
  profileCsv,
  parseCsv,
  detectDelimiter,
  type ProfileOpts,
  type ProfileDeps,
  type ProfileResult,
  type DatasetSample,
  type ColumnFlags,
} from "./analyzers/profiler.js";
export {
  analyze,
  sha256Hex,
  AnthropicLlmClient,
  type LlmClient,
  type LlmRequest,
  type AnthropicLike,
  type AnalyzeOpts,
  type AnalyzeDeps,
  type AnalyzeResult,
} from "./analyzers/planner.js";
export {
  zAnalyzeInput,
  zAnalyzeOutput,
  zAnalyzeSource,
  zArtifact,
  zDatasetProfile,
  zAnalysisReport,
  decodedBase64Bytes,
  URL_MAX_CHARS,
  TEXT_MAX_BYTES,
  CSV_BASE64_MAX_BYTES,
  DEFAULT_MAX_ROWS,
  MAX_MAX_ROWS,
  QUESTION_MAX_CHARS,
  type Artifact,
  type AnalyzeInput,
  type AnalyzeInputUrl,
  type AnalyzeInputCsv,
  type AnalyzeInputCsvBase64,
  type AnalyzeSource,
  type AnalyzeOutput,
  type Delimiter,
  type ColumnProfile,
  type DatasetProfile,
  type AnalysisReport,
  type InferredType,
} from "./types.js";
export { main } from "./main.js";
export {
  assertSelfSkillCredential,
  inMemoryAgentCardLoader,
  MissingSelfCredentialError,
  type AgentCardLoader,
  type AssertSelfSkillCredentialDeps,
  type MissingSelfCredentialDetail,
} from "./self-cred.js";
