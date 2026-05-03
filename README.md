# `@eto/mcp`

Operational gateway services for ETO — bridges between external identity
systems and the on-chain `IssueCredential` flow defined in
[`spec/SINGULARITY-LAYER-1.md`](../spec/SINGULARITY-LAYER-1.md).

## Beckn HTTP bridge

The `src/gateway/beckn.ts` module exports an Express router and a
`createBecknApp()` factory exposing Beckn v2.0 LTS endpoints — `/search`,
`/select`, `/init`, `/confirm`, plus a `/health` liveness probe. Each
action endpoint validates the envelope shape and returns a synchronous
`ACK`. Per-action `message` schema validation lands in **FN-087** and
BAP/BPP role logic in **FN-088..FN-091**. See
[`docs/beckn-bridge.md`](./docs/beckn-bridge.md) for the full envelope,
error table, and public-surface reference.

This package is a self-contained TypeScript module that runs under either
Bun (production) or Node ≥ 20 (CI). It contains pure business logic with
no HTTP transport — the gateway server wires routes onto `WorldcoinIssuer`
in a sibling task.

## Layout

```
eto-mcp/
├── src/
│   ├── index.ts                       # public re-exports
│   ├── config.ts                      # env-driven issuer config
│   └── issuers/
│       ├── worldcoin.ts               # bridge service (T-1.4.1.2 / FN-038)
│       ├── worldcoin.types.ts         # request/response + DI interfaces
│       ├── civic.ts                   # civic fallback issuer (T-1.4.1.3 / FN-039)
│       └── civic.types.ts
├── test/
│   ├── worldcoin.test.ts              # vitest unit tests
│   └── civic.test.ts
├── tests/
│   └── issuers/
│       └── worldcoin.test.ts          # end-to-end issuer flow (FN-044)
├── package.json
├── tsconfig.json / tsconfig.build.json
└── vitest.config.ts
```

## Worldcoin issuer (`@eto/mcp/issuers/worldcoin`)

Implements the design in
[`spec/issuers/worldcoin-integration.md`](../spec/issuers/worldcoin-integration.md):

1. Verifies an OIDC `id_token` (JWT) issued by `https://id.worldcoin.org`.
2. Verifies the wallet's Ed25519 signature over `nullifier || agent_card_pubkey`.
3. Calls `POST /api/v2/verify/{appId}` on the Worldcoin Cloud API with
   `signal = sha256(agent_card_pubkey)` and
   `action = "eto.verified-human.v1"`.
4. Looks up the `nullifier_hash` in a pluggable store:
   - same nullifier + same card → returns the existing record (idempotent),
   - same nullifier + different card → 409,
   - miss → continues.
5. Builds the JSON-LD VC envelope, pins it to IPFS, and submits an
   `IssueCredential` tx via the injected `ChainClient`.

All external dependencies are **dependency-injected**: the package ships
a `createFetchCloudVerifier` reference impl that talks to the real
Worldcoin API, plus an `InMemoryNullifierStore` for devnet / tests.
Production deploys swap in Redis/Postgres for the store and a real
chain client.

### Schema

The on-chain schema id is

```
sha256("eto.beckn.schema.verified-human.v1")
```

exposed as `VERIFIED_HUMAN_SCHEMA_ID`.

### Required configuration

| Env var | Purpose |
| --- | --- |
| `WORLDCOIN_APP_ID` | OIDC `aud`; injected as `appId`. |
| `WORLDCOIN_API_KEY` | Cloud API bearer token. |
| `ETO_WORLDCOIN_ISSUER_KEYPAIR` | Path to the Ed25519 keypair authorized as `issuer_authority`. |

The `id_token` audience and issuer are validated against
`https://id.worldcoin.org` and the configured `appId`.

## Acceptance criteria (FN-038)

- [x] **Validates Worldcoin proof against Worldcoin's public verifier.**
      `WorldcoinIssuer.issue` calls the injected `CloudVerifier` (default:
      `POST https://developer.worldcoin.org/api/v2/verify/{appId}` with
      bearer auth) and rejects on any non-success path. The OIDC
      `id_token` JWT is independently verified.
- [x] **Issues `verified-human` credential to caller's AgentCard.**
      A successful proof drives an `IssueCredential` tx through the
      `ChainClient` with `schema=VERIFIED_HUMAN_SCHEMA_ID`,
      `subjectAgentCard=req.agentCardPubkey`,
      `claimHash=sha256(JCS(vc))`, and `claimUri=ipfs://...`.
- [x] **Idempotent (re-submission of same proof returns existing cred).**
      The injected `NullifierStore` is consulted before any chain tx.
      Re-submission with the same `(nullifier, agent_card_pubkey)`
      returns the cached `credential_pda` / `tx_signature` with
      `idempotent: true` and does **not** call `IssueCredential` again.

## Civic issuer (`@eto/mcp/issuers/civic`) — T-1.4.1.3 / FN-039

Geographically-broader fallback to the Worldcoin adapter. See
[`spec/issuers/civic-integration.md`](../spec/issuers/civic-integration.md)
for the full design. Each adapter under `src/issuers/` follows the same
contract:

1. Verify the third-party proof (Civic gateway token) server-side.
2. Compute a stable `nullifier` for the verified subject and look it up
   in a dedupe store.
3. Idempotent re-issue for the same `(nullifier, agent_card_pubkey)`;
   reject conflicting bindings (`409`).
4. On miss, build the JCS-canonical VC, call `IssueCredential` against
   the chain, persist the dedupe row, return the credential PDA.

Issuer config is loaded from environment variables (see
`src/config.ts`):

| Variable                    | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `CIVIC_GATEKEEPER_NETWORK`  | Base58 Civic gatekeeper-network pubkey.        |
| `CIVIC_ISSUER_KEYPAIR_PATH` | Filesystem path to the Civic issuer keypair.   |
| `CIVIC_NETWORK_ID`          | 32-byte hex `IssuerNetwork` id for Civic.      |

The Civic issuer is enabled iff `CIVIC_GATEKEEPER_NETWORK` and
`CIVIC_ISSUER_KEYPAIR_PATH` are both non-empty. Instantiating
`CivicIssuer` against a disabled config throws
`CivicIssuerError("UPSTREAM_OUTAGE", …, 503)` synchronously.

## Tests

```bash
cd eto-mcp
npm install   # or: bun install
npm test
npm run typecheck
npm run build
```

## kyc.us-test mock issuer (`@eto/mcp/issuers/kyc-test`)

**Mock — not real KYC.** Implements T-1.4.2.1 (FN-040) so demos can
exercise a Beckn offer that requires `schema = kyc.us-test` before a
regulated partner is wired in. The credential schema id is
`sha256("eto.beckn.schema.kyc.us-test.v1")`, deliberately distinct from
`verified-human` so a relying party can never confuse the two.

Flow:

1. Bridge renders a `name + DOB` form via `renderKycTestFormHtml`,
   embedding a bridge-signed `formToken` that pins
   `flowStartedAtUnix`.
2. Client-side JS enforces a ≥ 30-second cosmetic dwell before
   enabling submit.
3. `issueKycTest` re-validates the HMAC tag, enforces the dwell
   server-side (`KYC_TEST_MIN_DWELL_SECONDS`), derives
   `nullifier = sha256(domain | normalizedName | dobIso)`, consults
   the dedupe store (idempotent same-card / `409` different-card),
   builds the JCS-canonical VC, pins it, and submits
   `IssueCredential` only after a successful chain tx.

The adapter is fully dependency-injected (form-token signer, dedupe
store, slot clock, VC pinner, chain client), mirroring the worldcoin
adapter contract.

## `skill-cert` issuer (`@eto/mcp/issuers/skill-cert`)

T-1.4.2.2 / FN-041.

Whitelist-based issuer for `skill.<name>` credentials (e.g.
`skill.solidity-audit`). Used by the five reference BPPs to assert
their capabilities at Beckn `init` time.

- **Schema id:** `sha256("eto.beckn.schema.skill-cert." + skill + ".v1")`,
  one schema per skill.
- **Whitelist enforcement:** the bridge consults a pluggable
  `SkillWhitelist` on every request; subjects not on the list get a
  `NOT_WHITELISTED` (HTTP 403) error.
- **Idempotency:** at most one credential per `(subject, skill)`. A
  re-submission returns the cached PDA / tx signature with
  `idempotent: true`. Lost races on the binding store fall back to the
  canonical row.
- **Reference impls:** `StaticSkillWhitelist` (Map-backed) and
  `InMemorySkillBindingStore` ship for tests and devnet. Production
  swaps both for durable, atomic backends.

```ts
import {
  InMemorySkillBindingStore,
  SkillCertIssuer,
  StaticSkillWhitelist,
} from "@eto/mcp/issuers/skill-cert";

const issuer = new SkillCertIssuer(
  { issuerDid: "did:eto:issuer:skill-cert" },
  {
    whitelist: new StaticSkillWhitelist({
      "solidity-audit": [BPP_SOLIDITY_AUDIT_PUBKEY],
    }),
    bindingStore: new InMemorySkillBindingStore(),
    chain,
    ipfs,
  },
);

const res = await issuer.issue({
  skill: "solidity-audit",
  subjectAgentCard: BPP_SOLIDITY_AUDIT_PUBKEY,
});
```

## Scripts

- `npm run build` — emit `dist/` via `tsconfig.build.json`
- `npm run typecheck` — strict typecheck (no emit)
- `npm test` — vitest suite

## `bank.fiat-ramp-test` mock issuer (`@eto/mcp/issuers/bank-mock`)

T-1.4.2.3 / FN-042.

**Mock — not a real bank.** Mints a `bank.fiat-ramp-test` credential
when the mock bank BPP reports a checking-account opening, dedupes on
`checkingAccountId`, and exposes a `revoke` entry point that flips the
on-chain `Credential.revoked` bit via `RevokeCredential`.

## Bank real issuer (`@eto/mcp/issuers/bank`)

T-3.9.1.3 / FN-097.

Production issuer service for the bank-as-BPP catalogue's account and
card flows. Runs under the bank's issuer authority key and exposes
async entry points for the three credential families:

| Entry point | Credential schema | Binding key |
| --- | --- | --- |
| `issueCheckingCredential` | `account.checking.v1` | `checkingAccountPda` |
| `issueSavingsCredential` | `account.savings.v1` | `savingsAccountPda` |
| `issueCardCredential` | `card.debit.v1` | `cardIdHash` |
| `revokeBankCredential` | any of the above | `(kind, bindingKey)` |

All side-effects are dependency-injected (`BankIssuerDeps`). The only
bundled store is `InMemoryBankIssuerStore`; a durable adapter is a
follow-up. Idempotent on natural binding key; emits `BankIssuerError`
for binding conflicts, chain failures, and validation errors. See
`src/issuers/bank.ts` and `src/issuers/bank.types.ts`.

## Services

### Audit-trail event indexer (`@eto/mcp` → `src/services/indexer/audit-trail.ts`)

T-3.13.1.1 / FN-130. Off-chain read-only service that, given any
`AgentCard` authority, ingests the chain's `KytTrace` (Beckn `init` /
`confirm` / `rate`) and `RevocationRootUpdated` events through an
injectable `KytEventSource` and emits a deterministic JSON-LD audit
feed shaped as a `VerifiableCredential` of type
`["VerifiableCredential", "AuditTrailFeed"]`. Events are sorted by
`(slot, txSignature)` for byte-stable output, and the
`credentialSubject.summary` carries per-stage counters. Signing is opt-in via the injected `VcSigner` (FN-084); the default
`NoOpVcSigner` preserves the historical unsigned shape (no `proof`
key, issuer DID `did:eto:indexer:audit-trail:v0`). The production
source will subscribe to
`singularity:kyt:*` and `singularity:revocation:root_updated` log
lines via Solana JSON-RPC `logsSubscribe`. Consumed downstream by the
1099 issuer (FN-132) and travel-rule generator (FN-133). Tests use the
shipped `InMemoryKytEventSource` reference implementation.

### 1099 issuance flow sketch (`@eto/mcp` → `keeper/bpps/bank/handlers/tax-1099-sketch.ts`)

T-3.13.1.3 / FN-132. Manually-triggered bank-as-BPP flow that, given a
`(agentCardAuthority, taxYear, jurisdiction)` triple, aggregates the year's
audit trail via FN-130's `AuditTrailIndexer`, reduces the feed into
per-year totals (`Tax1099Totals`), builds a `Tax1099Credential` JSON-LD
envelope conforming to `spec/banking/credentials/tax-1099.json`, pins the
JCS-canonical claim via an injectable `VcPinner`, and submits an
`IssueCredential` instruction under the schema id
`sha256("eto.beckn.schema.tax.1099.<jurisdiction>.<year>.v1")`. Entry point:
`runTax1099Sketch(deps, request)`. v0 is unsigned (`proof.proofValue` is
the placeholder `"<unsigned-v0>"`) and monetary fields (`totalIncome` etc.)
are always `"0.00"` until FN-117 / FN-118 wire eUSD ledger amounts. Uses
the same injectable `IssueCredentialClient`, `VcPinner`, and `SlotClock`
interfaces as the existing `bank-mock` issuer.

### Travel-rule report generator (`@eto/mcp` → `src/services/indexer/travel-rule.ts`)

T-3.13.1.4 / FN-133. Off-chain FATF-style report generator that, given
any `AgentCard` authority, consumes FN-130's `AuditTrailIndexer` audit
feed and emits a deterministic JSON-LD document of type
`["VerifiableCredential", "TravelRuleReport"]`. Only `confirm`-stage
KYT events are considered (settlement, not catalog browse / rating); an
event is included iff the originator and beneficiary resolve to two
distinct ISO-3166-1 α-2 jurisdictions **and** the USD-equivalent amount
strictly exceeds the configurable threshold (default **$3,000**).

Party records (name, account, jurisdiction, optional address and
national ID) are supplied via the injected `PartyDirectory`; USD amounts
are resolved via the injected `AmountResolver`. v0 ships the in-memory
reference implementations (`InMemoryPartyDirectory`,
`InMemoryAmountResolver`); production wiring (backed by the issuer
registry and `EtoRpcClient` transaction lookups) is a follow-up task.
Signing is opt-in via the injected `VcSigner` (FN-084); the default
`NoOpVcSigner` preserves the historical unsigned shape (issuer DID
`did:eto:indexer:travel-rule:v0`, no `proof` key on the document). Per
spec §9.3: `parties[0]` (BAP) is the originator;
`parties[1]` (BPP) is the beneficiary. Entries are sorted by
`(slot, txSignature)` for byte-stable output; the injectable `clock`
allows tests to pin `issuanceDate` for deterministic assertions.

### Audit / travel-rule signing (`@eto/mcp` → `src/services/indexer/vc-signer.ts`)

FN-084 + FN-030. Compliance-grade W3C VC Data Integrity proof blocks
for the audit-trail and travel-rule JSON-LD documents. Three proof
suites are supported, all sharing the same canonical preimage — only
the signature container differs:

| `VC_PROOF_SUITE` value     | Proof `type`              | Container                                       |
| -------------------------- | ------------------------- | ----------------------------------------------- |
| `Ed25519Signature2020`     | `Ed25519Signature2020`    | `proofValue` = base64url(Ed25519(digest))       |
| `JsonWebSignature2020`     | `JsonWebSignature2020`    | `jws` = detached JWS, alg=EdDSA, b64=false      |
| `cose-2024`                | `DataIntegrityProof`      | `proofValue` = base64url(COSE_Sign1(digest))    |

Signing is **opt-in**: the default `NoOpVcSigner` emits the historical
unsigned shape (no `proof` key, byte-stable against pre-FN-084
fixtures). To enable signing, set `AUDIT_SIGNING_KEY_PATH` and inject
`createVcSignerFromEnv({ issuerDid })` into
`AuditTrailIndexerDeps.signer` / `TravelRuleReportGeneratorDeps.signer`.

**Env vars.**

- `AUDIT_SIGNING_KEY_PATH` — filesystem path to a 32-byte Ed25519 seed.
  The file may be raw 32 bytes, hex (with or without `0x` prefix), or
  base64 / base64url. Anything else throws `expected 32-byte Ed25519
  seed`. The loaded secret is never logged or echoed back in error
  messages.
- `VC_PROOF_SUITE` — one of `Ed25519Signature2020` (default),
  `JsonWebSignature2020`, or `cose-2024`. Unknown values throw
  `VC_PROOF_SUITE: unsupported value <x>`. With `AUDIT_SIGNING_KEY_PATH`
  unset, the value is ignored and `NoOpVcSigner` is returned.

**Proof block shapes.** Attached as `feed.proof` / `report.proof` when
a non-NoOp signer is configured.

*`Ed25519Signature2020` (legacy default):*

```jsonc
{
  "type": "Ed25519Signature2020",
  "created": "2026-05-02T12:34:56.000Z",
  "verificationMethod": "did:eto:issuer:bank-prod#key-1",
  "proofPurpose": "assertionMethod",
  "proofValue": "<base64url(Ed25519(sha256(JCS(vcWithoutProof))))>"
}
```

*`JsonWebSignature2020` (RFC 7515 §A.5 detached JWS):*

```jsonc
{
  "type": "JsonWebSignature2020",
  "created": "...",
  "verificationMethod": "<issuerDid>#key-1",
  "proofPurpose": "assertionMethod",
  // header = {"alg":"EdDSA","b64":false,"crit":["b64"]}
  // signing input = utf8(encodedHeader || ".") || sha256(JCS(vcWithoutProof))
  "jws": "<encodedHeader>..<base64urlSig>",
  "proofValue": "<same string as jws>"
}
```

*`DataIntegrityProof` with `cryptosuite: "cose-2024"` (COSE_Sign1):*

```jsonc
{
  "type": "DataIntegrityProof",
  "cryptosuite": "cose-2024",
  "created": "...",
  "verificationMethod": "<issuerDid>#key-1",
  "proofPurpose": "assertionMethod",
  // base64url of CBOR tag 18 [protected, {}, payload, signature]
  // protected = bstr({1: -8})  // alg = EdDSA
  // payload   = sha256(JCS(vcWithoutProof))     (32 bytes)
  // signature = Ed25519 over Sig_structure       (64 bytes)
  "proofValue": "<base64url(COSE_Sign1)>"
}
```

**Hash input (spec §11.4).** `claim_hash = sha256(JCS(vcWithoutProof))`
applies to **all three suites** — only the signature container differs.
The `proof` block itself is **excluded** from the JCS preimage; the
indexer wiring strips it before calling `signer.sign(...)` and only
attaches the returned proof afterwards.

**Backwards compatibility.** When `AUDIT_SIGNING_KEY_PATH` is unset (or
no `signer` is injected), the default `NoOpVcSigner` returns a sentinel
proof with `proofValue === ""`; the indexers detect this and OMIT the
`proof` key entirely so output is byte-identical to v0. All existing
fixture-based tests pass unchanged.
