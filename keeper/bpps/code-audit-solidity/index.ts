/**
 * Public barrel for the `code:audit:solidity` reference BPP (FN-076).
 */

export {
  config,
  tags,
  buildConfig,
  resolveAuthority,
  resolveSelfIssuerSet,
  parseSelfIssuersEnv,
  DEV_AUTHORITY_PUBKEY,
  DEV_SELF_ISSUER_PUBKEY,
  type SolidityAuditBppConfig,
} from "./config.js";
export {
  zAuditInput,
  zAuditOutput,
  zAuditFinding,
  zAuditReport,
  zArtifact,
  decodedBase64Bytes,
  PER_FILE_MAX_BYTES,
  TOTAL_INLINE_MAX_BYTES,
  URL_MAX_BYTES,
  URL_MAX_CHARS,
  MAX_FILES,
  SEVERITIES,
  SEVERITY_RANK,
  AUDIT_SOURCES,
  type Severity,
  type AuditSource,
  type AuditInput,
  type AuditInputSource,
  type AuditInputInline,
  type AuditInputUrl,
  type AuditInputBase64,
  type AuditInputFile,
  type AuditFinding,
  type AuditReport,
  type AuditOutput,
  type Artifact,
} from "./types.js";
export {
  loadSources,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_URL_MAX_BYTES,
  type FetchLike,
  type FetchLikeResponse,
  type LoadSourcesDeps,
  type LoadedSources,
} from "./source-loader.js";
export {
  runStaticAuditor,
  type StaticAuditorDeps,
  type StaticAuditorResult,
  type SpawnLike,
  type SpawnResult,
  type WhichLike,
} from "./auditors/static.js";
export {
  AnthropicLlmAuditClient,
  parseLlmAuditOutput,
  type LlmClient,
  type LlmAuditRequest,
  type LlmAuditResult,
  type AnthropicLike,
} from "./auditors/llm.js";
export {
  runAudit,
  mergeFindings,
  renderMarkdown,
  type RunAuditOpts,
  type RunAuditDeps,
  type RunAuditResult,
} from "./auditors/index.js";
export {
  assertSelfSkillCredential,
  inMemoryAgentCardLoader,
  MissingSelfCredentialError,
  type AgentCardLoader,
  type AssertSelfSkillCredentialDeps,
  type MissingSelfCredentialDetail,
} from "./self-cred.js";
export {
  createSolidityAuditHandler,
  sha256Hex,
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
export { main, SOLIDITY_AUDIT_SCHEMA_ID } from "./main.js";
