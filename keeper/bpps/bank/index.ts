/**
 * Public barrel for the bank-as-BPP keeper module.
 *
 * Combines:
 *   - FN-096 scaffold: types, catalog primitives, config, handler,
 *     chain adapter, catalog-publisher, and main runner.
 *   - FN-099 required-cred policy (`required-creds.ts`).
 *   - FN-110 v0 mock USD ledger (`mock-usd-ledger.ts`) — dev/test
 *     only; never imported by the published `dist/` build.
 *   - FN-132 tax-1099 sketch (`handlers/index.ts`).
 *
 * Downstream consumers (FN-097 issuer service, FN-098 catalogue,
 * FN-107 onramp / FN-108 offramp handlers, FN-115 / FN-121 account-
 * open flows) import from this module:
 *
 *   import {
 *     config, catalog, tags,
 *     buildBankCatalog, catalogHashHex, BANK_CAPABILITY_KEYS,
 *     createBankHandler, publishBankCatalog, InMemoryCatalogCommitRecorder,
 *     requiredCredsForAction,
 *     MockUsdLedger,
 *   } from "@eto/mcp/keeper/bpps/bank";
 */

// ── FN-096 scaffold ─────────────────────────────────────────────────────────

export {
  // types
  zBankCapability,
  zBankCatalog,
  zCatalogCommitPayload,
  type BankCapabilityKey,
  type BankCapability,
  type BankCatalog,
  type CatalogCommitPayload,
  type OpenCheckingInput,
  type OpenCheckingOutput,
  type OpenSavingsInput,
  type OpenSavingsOutput,
  type FiatRampInput,
  type FiatRampOutput,
  type CardInput,
  type CardOutput,
  type WireInput,
  type WireOutput,
} from "./types.js";

export {
  // catalog primitives
  BANK_CAPABILITY_KEYS,
  buildBankCatalog,
  canonicalCatalogJson,
  catalogHashHex,
  buildCatalogCommit,
  type BuildBankCatalogOpts,
} from "./catalog.js";

export {
  // config
  DEV_BANK_AUTHORITY_PUBKEY,
  resolveBankAuthority,
  buildConfig,
  BANK_UMBRELLA_TAGS,
  config,
  tags,
  catalog,
  type BuildConfigOpts,
  type BuildConfigResult,
} from "./config.js";

export {
  // handler
  createBankHandler,
  type BankHandlerDeps,
} from "./handler.js";

export {
  // chain adapter (re-exports from text-summarize)
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
  // catalog publisher
  InMemoryCatalogCommitRecorder,
  publishBankCatalog,
  type CatalogCommitRecorder,
  type PublishedCommitRecord,
  type CatalogSigner,
  type PublishBankCatalogResult,
} from "./catalog-publisher.js";

export { main as bankMain } from "./main.js";

// ── FN-099 required-cred policy ─────────────────────────────────────────────

export * from "./required-creds.js";

// ── FN-132 tax-1099 issuance flow sketch ────────────────────────────────────

// 1099 issuance flow sketch (FN-132 / T-3.13.1.3) — bank-as-BPP tax flow.
export * from "./handlers/index.js";

// ── FN-110 mock USD ledger ───────────────────────────────────────────────────

export {
  MockUsdLedger,
  InsufficientFundsError,
  LedgerCorruptError,
  usd,
  zRampDirection,
  zRampEvent,
  zLedgerSnapshot,
  type UsdAccountId,
  type UsdAmountCents,
  type RampDirection,
  type RampEvent,
  type LedgerSnapshot,
  type MockUsdLedgerOpts,
} from "./mock-usd-ledger.js";
