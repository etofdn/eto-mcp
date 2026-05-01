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

