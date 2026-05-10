# Bank-as-BPP keeper module (FN-096)

The **bank BPP** exposes five financial-domain Beckn capabilities as a
single multi-capability catalogue.  It is composed against the FN-073
BPP template and mirrors the directory layout of the reference BPPs
(FN-075–079), extended with a two-tier registration design to stay
within the AgentCard `metadata_uri` budget.

This BPP is **dev-time tooling**: it is excluded from the published
`@eto/mcp` package (`tsconfig.build.json`) and is run directly by the
keeper process.

## What this BPP is

The bank BPP is the Beckn-side interface of the ETO test bank.  It
advertises five capability tags — `bank.checking`, `bank.savings`,
`bank.fiat-ramp`, `bank.card`, `bank.wire` — inside a single signed
`BankCatalog`, and registers one AgentCard whose `metadata_uri` carries
a compact **umbrella tag** (`{ domain: "bank", action: "catalog" }`).

Concrete handler logic for each capability is intentionally stubbed
(`not_implemented: bank.<key>`) in this scaffold.  Downstream tasks
fill in the real logic (see §Capabilities below).

## Capabilities

| Capability key     | Action     | Implemented by           |
| ------------------ | ---------- | ------------------------ |
| `bank.checking`    | `checking` | FN-097, FN-115           |
| `bank.savings`     | `savings`  | FN-121                   |
| `bank.fiat-ramp`   | `fiat-ramp`| FN-107 (onramp), FN-145 (offramp) |
| `bank.card`        | `card`     | FN-125                   |
| `bank.wire`        | `wire`     | FN-119                   |

Each capability advertises zero-fee `ETO` pricing by default.  Pricing
overrides land as part of the catalogue task (FN-098).  Required
credentials for account-open actions are provided by FN-099 and wired
into config by the handlers themselves.

## Two-tier registration design

The BPP template (FN-073) pins capability tags into an AgentCard's
`metadata_uri` as a `data:application/json;base64,…` URL.  That field
has a ≤ 256-byte inline budget (with a 512-byte hard cap before the
`MetadataPinner` escape hatch is required), which is too small to hold
five capability descriptions plus pricing and credential requirements.

To stay within budget the bank BPP uses a **two-tier** approach:

1. **Umbrella tag** (pinned in AgentCard `metadata_uri`):
   ```jsonc
   { "domain": "bank", "action": "catalog", "version": "0.1.0", … }
   ```
   This fits in the inline budget and tells querying BAPs "this agent
   runs the bank catalogue."

2. **`BankCatalog` + `CatalogCommitPayload`** (published separately):
   The full per-capability catalogue (five capabilities with pricing,
   credentials, and descriptions) is signed and recorded via
   `publishBankCatalog` in `catalog-publisher.ts`.
   TODO(FN-055): when on-chain `PublishCatalog` lands, the
   `CatalogCommitRecorder` interface becomes an RPC adapter.

## Directory layout

| File                    | Owner      | Purpose                                                         |
| ----------------------- | ---------- | --------------------------------------------------------------- |
| `types.ts`              | FN-096     | `BankCapabilityKey`, `BankCapability`, `BankCatalog`, `CatalogCommitPayload`, Zod schemas |
| `catalog.ts`            | FN-096     | `BANK_CAPABILITY_KEYS`, `buildBankCatalog`, `canonicalCatalogJson`, `catalogHashHex`, `buildCatalogCommit` |
| `config.ts`             | FN-096     | `buildConfig`, `DEV_BANK_AUTHORITY_PUBKEY`, `resolveBankAuthority`, singletons |
| `handler.ts`            | FN-096     | `createBankHandler` — stub dispatcher (not_implemented per capability) |
| `chain-adapter.ts`      | FN-096     | Re-exports `SigningRuntimeChain`, `makeStubSigner` from text-summarize |
| `catalog-publisher.ts`  | FN-096     | `CatalogCommitRecorder`, `InMemoryCatalogCommitRecorder`, `publishBankCatalog` |
| `main.ts`               | FN-096     | Runnable smoke-check entrypoint                                 |
| `required-creds.ts`     | FN-099     | Per-action required-credential policy (single SoT).             |
| `mock-usd-ledger.ts`    | FN-110     | v0 mock USD ledger: `MockUsdLedger`, ramp events, `usd()`, errors. |
| `handlers/index.ts`     | FN-132     | 1099 issuance flow sketch handlers barrel.                      |
| `handlers/issue-card.ts`| FN-125     | `issueCard` — v0 stub: issues `card.debit.<jurisdiction>.v1` credential against a CheckingAccount. |
| `index.ts`              | shared     | Public barrel; re-exports all public surface.                   |

## Caller-authentication contract (FN-015)

Money- and identity-binding bank BPP handlers MUST verify that the
on-the-wire caller (the BAP whose signature was checked at the gateway)
is the same principal named by the request body before any side effect
runs. The shared contract lives in [`auth.ts`](./auth.ts):

```ts
import {
  type AuthenticatedRequest,
  assertCallerEquals,
  UNAUTHORIZED_CALLER_REASON, // = "unauthorized_caller"
} from "./auth.js";

export interface AuthenticatedRequest<T> {
  readonly callerPubkey: string; // hex pubkey verified by the gateway
  readonly body: T;              // existing per-handler request shape
}
```

Handlers receive an `AuthenticatedRequest<T>` and call
`assertCallerEquals(req.callerPubkey, req.body.subject)` as the FIRST
line of execution — BEFORE any credential, ledger, chain, or stub call.
A missing / empty / mismatched `callerPubkey` is rejected with the
canonical reason `unauthorized_caller`. Comparison is case-insensitive
over hex and length-checked / constant-time-ish via `timingSafeEqual`.

### Coverage status

| Handler                          | Caller-auth wired?  | Owner |
| -------------------------------- | ------------------- | ----- |
| `handlers/issue-card.ts`         | ✅ yes              | FN-015 |
| `handlers/open-checking.ts`      | ✅ yes              | FN-015 |
| `handlers/wire.ts`               | ⏳ pending           | FN-034 |
| `handlers/offramp.ts`            | ⏳ pending           | FN-034 |
| `handlers/onramp.ts`             | ⏳ pending           | FN-034 |
| `handlers/open-savings.ts`       | ⏳ pending           | FN-034 |

### Dispatcher plumbing point

`handler.ts` exports `extractCallerPubkey(req)`, the single point at
which a verified caller pubkey is read off the inbound `TaskRequest`
before the dispatcher wraps `req.input` as `AuthenticatedRequest<T>`
for a per-capability handler. Until **FN-073** (gateway BAP-signature
verification) and **FN-075** (populate the verified pubkey on
`TaskRequest`) land, `extractCallerPubkey` returns `undefined` for
every real request and the per-capability handlers continue to
short-circuit via `STUB_REASONS`. When FN-073 / FN-075 land, the
dispatcher MUST fail-closed with `UNAUTHORIZED_CALLER_REASON` if
`extractCallerPubkey` returns `undefined` BEFORE invoking a real
per-capability handler — the per-handler `assertCallerEquals` gate is
the second line of defence, not the first.

### Pitfall — do NOT confuse credential validity with caller authentication

The following are **credential / issuance-side checks**. They DO NOT
substitute for caller authentication and MUST NOT be repurposed as
such:

- `verifyHolderCredentials` — checks whether a subject possesses
  required on-chain credentials. Says nothing about who sent the
  current message.
- `verifyLinkedAccount` — checks ledger-side ownership of an account
  PDA. Same caveat.
- `verifyCheckingCredential` (and similar `verify*Credential` deps) —
  checks issuance metadata of an existing credential.
- `cred.issuer === bankIssuer.issuerAuthorityPubkey` (the prod adapter
  guard in `makeProdIssueCardCredential`) — confirms the bank is
  signing with the right authority key. It does not bind the
  caller's BAP signature to `cred.subject`.

Caller authentication is the caller-message-authorship gate enforced
by `assertCallerEquals` against a gateway-verified `callerPubkey`.
All other checks layer on top.

## Running the smoke check

```bash
cd eto-mcp
bun run keeper/bpps/bank/main.ts
```

Expected output:

```
[info]  registered AgentCard { pda: "...", idempotent: false }
[info]  CatalogCommit published { catalogHash: "...", capabilities: 5, ... }
[info]  bank BPP smoke check complete { ..., registeredCapabilities: 5, failedEvents: 5, allNotImplemented: true }
[info]  failed (not_implemented) { taskId: "bank-smoke-bank.checking", reason: "not_implemented: bank.checking — see FN-097, FN-115|..." }
[info]  failed (not_implemented) { taskId: "bank-smoke-bank.savings", ... }
[info]  failed (not_implemented) { taskId: "bank-smoke-bank.fiat-ramp", ... }
[info]  failed (not_implemented) { taskId: "bank-smoke-bank.card", ... }
[info]  failed (not_implemented) { taskId: "bank-smoke-bank.wire", ... }
```

Override the BPP authority:

```bash
BANK_BPP_AUTHORITY=MyAuthorityPubkey... bun run keeper/bpps/bank/main.ts
```

## Required-credential policy (FN-099)

`required-creds.ts` is the canonical TypeScript module describing
which credentials a BAP MUST present at Beckn `init` time to invoke
each bank service.

**Account-open actions** — `bank.checking.open` and
`bank.savings.open` — both REQUIRE:

1. `verified-human` — schema
   `sha256("eto.beckn.schema.verified-human.v1")`, any issuer,
   must be active (not revoked, in validity window).
2. `kyc.us-test` — schema
   `sha256("eto.beckn.schema.kyc.us-test.v1")` (re-exported from
   FN-040's `KYC_TEST_SCHEMA_ID_HEX`), any issuer, must be active.

## Mock USD ledger (FN-110)

`mock-usd-ledger.ts` provides an off-chain, JSON-file-backed simulation
of USD account balances and chronological ramp events (USD ⇄ eUSD) that
the bank BPP onramp / offramp handlers and their tests can wire into.

## TODO list

The following capabilities are deferred to downstream tasks:

- **FN-097** — Bank BPP issuer service (checking-account credential issuance)
- **FN-098** — Bank BPP catalogue JSON (static price-list)
- **FN-099** (done) — Required-credential policy (verified-human + kyc.us-test gates)
- **FN-100** — Bank BPP integration tests
- **FN-115** — Open-checking handler (`bank.checking` real logic)
- **FN-119** — Wire transfer handler (`bank.wire` real logic)
- **FN-121** — Open-savings handler (`bank.savings` real logic)
- **FN-125** — Issue-card handler (`bank.card` real logic)
- (FN-107, FN-145) — Fiat-ramp onramp/offramp handlers (`bank.fiat-ramp` real logic)
- **FN-055** — On-chain `PublishCatalog` instruction (replaces `InMemoryCatalogCommitRecorder`)

## Test layout

`eto-mcp/tests/unit/bank-bpp.test.ts` covers:

1. `BANK_CAPABILITY_KEYS` — length (5) and spec order
2. `buildBankCatalog` — capabilities, domain, version, Zod parse
3. `canonicalCatalogJson` — byte-stability, key sort, array order
4. `catalogHashHex` — snapshot regression, hex format
5. `computeBankNetworkId` integration — `networkIdHex` matches FN-095
6. `buildConfig` — valid `BppConfig` with umbrella tag
7. `createBankHandler` dispatch — `not_implemented` + `unknown_action`
8. `publishBankCatalog` + `InMemoryCatalogCommitRecorder`
9. `main()` invocation — smoke check

## Lifecycle test (FN-123)

`eto-mcp/tests/bank/accounts.test.ts` — end-to-end happy-path integration test for the E11 checking & savings mission. Covers: open checking → deposit → withdraw → wire → open savings → yield accrual, with eUSD conservation invariant checked at every step.
