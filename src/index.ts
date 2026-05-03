/**
 * Public entry point for `@eto/mcp`. Re-exports the issuer modules
 * available today; the gateway HTTP server lives in a sibling task.
 */

export * from "./issuers/worldcoin.js";

// bank-mock issuer (T-1.4.2.3, FN-042) — re-export with explicit names
// so per-issuer helpers (`jcsCanonicalize`, `IssueCredentialClient`,
// etc.) don't shadow other adapters' symbols.
export {
  BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX,
  BankMockIssueError,
  InMemoryBankMockStore,
  buildBankFiatRampTestVc,
  issueBankFiatRampTest,
  jcsCanonicalize as jcsCanonicalizeBankMock,
  revokeBankFiatRampTest,
} from "./issuers/bank-mock.js";
export type {
  BankMockIssueRequest,
  BankMockIssueResponse,
  BankMockIssuerDeps,
  BankMockRevokeRequest,
  BankMockRevokeResponse,
  BankMockRow,
  BankMockStore,
  IssueCredentialClient as BankMockIssueCredentialClient,
  RevokeCredentialClient as BankMockRevokeCredentialClient,
  SlotClock as BankMockSlotClock,
  VcPinner as BankMockVcPinner,
} from "./issuers/bank-mock.js";

// civic adapter (T-1.4.1.3, FN-039) — re-export with explicit names so
// the per-issuer helpers and shared interfaces don't shadow the
// worldcoin adapter's symbols (both adapters define their own
// `NullifierStore`, `ClaimHasher`, `VERIFIED_HUMAN_SCHEMA_ID`, etc.).
export {
  CivicIssuer,
  StubCivicVerifier,
  base58Decode as base58DecodeCivic,
  buildVerifiedHumanVc as buildVerifiedHumanVcCivic,
  civicNullifierFromGatewayToken,
  defaultClaimHasher as defaultCivicClaimHasher,
  deriveCredentialPda as deriveCivicCredentialPda,
  ed25519SignatureVerifier as civicEd25519SignatureVerifier,
  jcsCanonicalize as jcsCanonicalizeCivic,
  InMemoryNullifierStore as InMemoryCivicNullifierStore,
  VERIFIED_HUMAN_SCHEMA_ID as CIVIC_VERIFIED_HUMAN_SCHEMA_ID,
} from "./issuers/civic.js";
export type {
  AgentCardSignatureVerifier as CivicAgentCardSignatureVerifier,
  ChainClient as CivicChainClient,
  ClaimHasher as CivicClaimHasher,
  CivicConfig,
  CivicGatewayTokenState,
  CivicIssueRequest,
  CivicIssueResponse,
  CivicIssuerDeps,
  CivicIssuerErrorCode,
  CivicVerifier,
  CivicVerifyResult,
  IpfsPinner as CivicIpfsPinner,
  IssueCredentialArgs as CivicIssueCredentialArgs,
  IssueCredentialResult as CivicIssueCredentialResult,
  IssuerLogger as CivicIssuerLogger,
  NullifierBinding as CivicNullifierBinding,
  NullifierStore as CivicNullifierStore,
  VerifiedHumanVc as CivicVerifiedHumanVc,
} from "./issuers/civic.js";
export { CivicIssuerError } from "./issuers/civic.js";

// kyc-test adapter (T-1.4.2.1, FN-040) — re-export with explicit names so
// the per-issuer `deriveNullifier` / `jcsCanonicalize` helpers don't
// shadow the worldcoin adapter's symbols.
export {
  HmacKycTestFormTokenSigner,
  KYC_TEST_MIN_DWELL_SECONDS,
  KYC_TEST_SCHEMA_ID_HEX,
  KycTestIssueError,
  buildKycTestVc,
  deriveNullifier as deriveKycTestNullifier,
  issueKycTest,
  jcsCanonicalize as jcsCanonicalizeKycTest,
  normalizeName as normalizeKycTestName,
  renderKycTestFormHtml,
} from "./issuers/kyc-test.js";
export type {
  KycTestDedupeRow,
  KycTestDedupeStore,
  KycTestFormSubmission,
  KycTestFormTokenSigner,
  KycTestIssueCredentialClient,
  KycTestIssueRequest,
  KycTestIssueResponse,
  KycTestIssuerDeps,
  KycTestSlotClock,
  KycTestVcPinner,
} from "./issuers/kyc-test.js";

// skill-cert issuer (T-1.4.2.2, FN-041) — re-export with explicit names so
// the per-issuer `canonicalJson` / `sha256Hex` helpers and shared
// `ChainClient` / `IpfsPinner` / `IssueCredentialArgs` interfaces don't
// collide with the worldcoin adapter's symbols.
export {
  InMemorySkillBindingStore,
  SKILL_CERT_SCHEMA_PREFIX,
  SKILL_CERT_SCHEMA_SUFFIX,
  SKILL_CERT_VC_CONTEXT,
  SkillCertIssuer,
  StaticSkillWhitelist,
  buildSkillCertClaim,
  canonicalJson as canonicalJsonSkillCert,
  defaultClaimHasher as defaultSkillCertClaimHasher,
  schemaIdForSkill,
  sha256Hex as sha256HexSkillCert,
} from "./issuers/skill-cert.js";
export type {
  AgentCardPubkey as SkillCertAgentCardPubkey,
  ChainClient as SkillCertChainClient,
  ClaimHasher as SkillCertClaimHasher,
  Hex32 as SkillCertHex32,
  IpfsPinner as SkillCertIpfsPinner,
  IssueCredentialArgs as SkillCertIssueCredentialArgs,
  IssueCredentialResult as SkillCertIssueCredentialResult,
  SkillBinding,
  SkillBindingStore,
  SkillCertIssueRequest,
  SkillCertIssueResponse,
  SkillCertIssuerConfig,
  SkillCertIssuerDeps,
  SkillCertIssuerErrorCode,
  SkillId,
  SkillWhitelist,
} from "./issuers/skill-cert.js";
export { SkillCertIssuerError } from "./issuers/skill-cert.js";

// audit-trail indexer (T-3.13.1.1, FN-130) — read-only off-chain feed builder
// that ingests `KytTrace` and `RevocationRootUpdated` events for an AgentCard
// authority and emits a deterministic JSON-LD `VerifiableCredential`. v0 is
// unsigned; FN-132 (1099 issuer) and FN-133 (travel-rule generator) consume it.
export {
  AUDIT_TRAIL_CONTEXT_ETO,
  AUDIT_TRAIL_CONTEXT_VC,
  AUDIT_TRAIL_ISSUER_DID,
  AUDIT_TRAIL_VC_TYPE,
  AuditTrailIndexer,
  AuditTrailIndexerError,
  InMemoryKytEventSource,
  buildAuditFeed,
  counterpartyWireSchema,
  kytStageWireSchema,
  kytTraceEventSchema,
  partyTraceWireSchema,
  revocationRootUpdatedEventSchema,
} from "./services/indexer/index.js";
export type {
  AuditFeedEvent,
  AuditFeedJsonLd,
  AuditFeedKytEvent,
  AuditFeedRevocationEvent,
  AuditFeedSummary,
  AuditLogger,
  AuditTrailIndexerDeps,
  AuditTrailIndexerErrorCode,
  BuildAuditFeedOpts,
  CounterpartyWire,
  InMemoryKytEventSourceInit,
  KytEventSource,
  KytEventSourceQueryOpts,
  KytStageWire,
  KytTraceEvent,
  PartyTraceWire,
  RevocationRootUpdatedEvent,
} from "./services/indexer/index.js";

// travel-rule report generator (T-3.13.1.4, FN-133) — derived FATF-style
// JSON-LD report. Consumes FN-130's audit feed; v0 is unsigned.
export {
  TRAVEL_RULE_CONTEXT_ETO,
  TRAVEL_RULE_CONTEXT_FATF,
  TRAVEL_RULE_DEFAULT_THRESHOLD_USD,
  TRAVEL_RULE_ISSUER_DID,
  TRAVEL_RULE_REPORT_TYPE,
  TravelRuleError,
  TravelRuleReportGenerator,
  InMemoryPartyDirectory,
  InMemoryAmountResolver,
  buildTravelRuleReport,
  isCrossJurisdiction,
  meetsThreshold,
  shouldReport,
  amountResolverEntrySchema,
  ivms101GeographicAddressSchema,
  ivms101LegalNameSchema,
  ivms101NationalIdentificationSchema,
  ivms101NaturalNameSchema,
  ivms101PartyNameSchema,
  ivms101PartySchema,
  jurisdictionCodeSchema,
  partyDirectoryEntrySchema,
} from "./services/indexer/travel-rule.js";
export type {
  AmountResolver,
  AmountResolverEntry,
  BuildReportOpts,
  Ivms101GeographicAddress,
  Ivms101LegalName,
  Ivms101NationalIdentification,
  Ivms101NaturalName,
  Ivms101Party,
  Ivms101PartyName,
  JurisdictionCode,
  PartyDirectory,
  PartyDirectoryLookupOpts,
  ShouldReportResult,
  TravelRuleEntry,
  TravelRuleErrorCode,
  TravelRuleReportGeneratorDeps,
  TravelRuleReportJsonLd,
} from "./services/indexer/travel-rule.js";

// VC signer for audit-trail / travel-rule documents (FN-084 + FN-030)
// — supports `Ed25519Signature2020`, `JsonWebSignature2020` (JOSE
// detached JWS), and `DataIntegrityProof` (cryptosuite `cose-2024`)
// proof blocks per W3C VC Data Integrity / RFC 8785. Suite selected
// via the `VC_PROOF_SUITE` env var.
export {
  CoseVcSigner,
  DEFAULT_UNSIGNED_DID,
  Ed25519VcSigner,
  JoseVcSigner,
  NoOpVcSigner,
  base64UrlEncode,
  canonicalizeJcs,
  createVcSignerFromEnv,
  decodeEd25519Seed,
} from "./services/indexer/vc-signer.js";
export type {
  CreateVcSignerFromEnvOpts,
  DataIntegrityCoseProof,
  Ed25519Signature2020Proof,
  Ed25519VcSignerFromKeyFileOpts,
  Ed25519VcSignerInit,
  JsonWebSignature2020Proof,
  ProofSuite,
  VcProof,
  VcSigner,
} from "./services/indexer/vc-signer.js";

