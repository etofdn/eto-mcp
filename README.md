# `@eto/mcp`

Operational gateway services for ETO — bridges between external identity
systems and the on-chain `IssueCredential` flow defined in
[`spec/SINGULARITY-LAYER-1.md`](../spec/SINGULARITY-LAYER-1.md).

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
