# Agent Identity Model: human × model × environment

> Tracking issue: [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11)
> Status: **specification** — landed by FN-058. Wiring is split across:
> FN-059 (authority inheritance enforcement), FN-060 (A2A coordination),
> FN-061 (model attestation research / OAuth-for-AI-agents).
>
> This document is the canonical reference for the `AgentIdentity` shape
> exported from `src/models/agent-identity.ts`. The TypeScript module is
> reference-only until FN-059; nothing in production code imports it yet.

## §1 — Overview

ETO MCP today authenticates **sessions** — a thirdweb-issued (or dev/stdio)
HMAC-signed bearer token whose `sub` identifies a wallet-controlling human.
That single axis is sufficient when the only actor is a human-driven CLI.

It is *not* sufficient once two AI agents need to cooperate (A2A — see FN-054
/ FN-060). Trust between agents requires answering three orthogonal questions
that the current `SessionClaims` shape collapses into one:

1. **Whose authority does the agent act under?** (the human-in-the-loop)
2. **Which model produced the agent's actions?** (the AI provider)
3. **Where is the agent running?** (the MCP server + cryptographic anchor)

The fourth field — `session_scope` — narrows those answers to a single bounded
MCP session so a leaked or expired token can't be replayed under a stale
identity.

This spec defines:

```
AgentIdentity = {
  human_authority,
  model_attestation,
  environment,
  session_scope,
}
```

…the rules for **authority inheritance** between agents that share a
`human_authority`, the eventual **verification roadmap** for
`model_attestation`, and the **interim path** that builds an `AgentIdentity`
from today's `session_info` MCP tool with no provider integration.

## §2 — The four fields

Each field below documents:
- **Type** — the canonical TypeScript shape (see `src/models/agent-identity.ts`).
- **Source of truth** — what tool / module produces it today.
- **Threat model** — what an attacker would need to forge it.

### §2.1 `human_authority`

The verified human principal whose authority the agent borrows.

```ts
interface HumanAuthority {
  sub: string;                   // SessionClaims.sub — thirdweb wallet, "dev-user", or stdio principal
  auth_strategy:                  // SessionClaims.auth_strategy
    | "siwe" | "inapp_email" | "inapp_oauth"
    | "dev" | "__stdio__";
  verified: boolean;             // false for "dev" / "__stdio__" trust modes
}
```

- **Source of truth:** `src/gateway/session.ts::SessionPayload.sub` plus
  `auth_strategy`, surfaced via `src/gateway/auth.ts::authenticate()`.
- **Threat model:** forging requires the HMAC signing key
  (`SESSION_SIGNING_KEY` / `PASETO_SIGNING_KEY`). `dev` and `__stdio__`
  strategies are explicitly **unverified** and MUST be reported as
  `verified: false` so downstream policy can refuse cross-agent trust under
  them.

### §2.2 `model_attestation`

Which AI model / provider issued the agent's actions. This is a **forward-
looking** field — there is no provider-signature ecosystem to verify against
today. The interim path declares it self-reported.

```ts
interface ModelAttestation {
  attestation_status: "verified" | "self_declared" | "absent";
  provider?: string;             // e.g. "anthropic", "openai", "google"
  model?: string;                // e.g. "claude-sonnet-4-5", "gpt-4o"
  // Reserved for FN-061: signature, signed_at, key_id, claims envelope.
  signature?: string;
  signed_at?: string;            // ISO-8601
  key_id?: string;
}
```

- **Source of truth (eventual):** an OAuth-for-AI-agents-style attestation
  endpoint operated by the model provider, returning a JWS over a fixed
  claims envelope. See FN-061.
- **Source of truth (interim):** the calling agent self-declares `provider` /
  `model` (e.g. via an MCP client header or A2A handshake). The MCP server
  does not verify it; the field MUST carry `attestation_status:
  "self_declared"`.
- **Threat model:** until FN-061 lands, `model_attestation` is **trusted
  metadata, not a security claim**. Policy code MUST treat
  `attestation_status !== "verified"` as "unknown model" for any decision
  whose blast radius depends on the model identity.

### §2.3 `environment`

The execution surface the agent runs on, anchored cryptographically.

```ts
interface Environment {
  mcp_server: string;            // stable identifier for this MCP instance
  network: "mainnet" | "testnet" | "devnet";
  wallet_anchor: {
    wallet_id: string;           // SessionClaims.wallet_id / active wallet
    svm: string | null;          // base58 Ed25519 pubkey
    evm: string | null;          // 0x-prefixed hex
  };
  last_restart_iso: string;      // session_info.last_restart_iso
}
```

- **Source of truth:** `session_info` (`wallets`, `active_wallet_id`,
  `last_restart_iso`) plus the local-signer-derived SVM/EVM addresses
  (`src/signing/local-signer.ts`). The wallet's keypair is the **cryptographic
  anchor** — two MCP instances with the same `wallet_id` but different
  derived addresses are different `environment`s.
- **Threat model:** the wallet anchor is non-forgeable up to the strength of
  the local-signer key store. `mcp_server` and `last_restart_iso` are
  advisory and MUST NOT be relied on for trust decisions on their own.

### §2.4 `session_scope`

Bounds the identity to a single MCP session.

```ts
interface SessionScope {
  scope: string;                 // currentScope() — sub / "__stdio__" / "__dev__"
  token_expires_at: string | null;  // ISO-8601 from SessionPayload.exp
  token_expires_in_seconds: number | null;
  jti?: string;                  // SessionPayload.jti — for revocation correlation
}
```

- **Source of truth:** `src/signing/session-context.ts::currentScope()` plus
  `SessionPayload.exp` / `jti`.
- **Threat model:** an `AgentIdentity` whose `token_expires_at` is in the
  past MUST be rejected. Revocation goes through the existing JTI denylist
  in `src/gateway/session.ts`.

## §3 — Authority inheritance rule

> Two agents that present `AgentIdentity`s with the **same verified
> `human_authority.sub`** are mutually trusted for actions that human has
> authorized, *up to the intersection of their `session_scope` capabilities
> and within their respective `environment`s*.

Concretely:

- Agent A holds session `Sₐ` with `sub = 0xAlice`, `auth_strategy = "siwe"`,
  `caps = ["transfer:write", "a2a:write"]`.
- Agent B holds session `S_b` with `sub = 0xAlice`, `auth_strategy =
  "inapp_oauth"`, `caps = ["transfer:write"]`.
- A initiates an A2A message to B. B's identity check matches
  `human_authority.sub` and `human_authority.verified === true` on both
  sides → A is treated as acting under Alice's authority.
- The trusted-action set is the **intersection** of `caps`:
  `{transfer:write}`. B MUST NOT honor A's `a2a:write`-only requests just
  because they share a human.

Inheritance is **not** transitive across humans, **not** valid when either
side reports `human_authority.verified === false`, and **not** a substitute
for capability checks (`requireCapability`). It is a *gating condition* that
permits cross-agent capability checks to succeed at all; the capability
check itself still runs.

The enforcement implementation is FN-059's job. This spec only fixes the
predicate.

## §4 — Verification roadmap for `model_attestation`

Tracked end-to-end in **FN-061**. The target shape:

1. Provider operates an attestation endpoint (OAuth-for-AI-agents direction
   currently being formalized in the broader ecosystem; exact RFC TBD).
2. The agent obtains a short-lived JWS whose claims include at minimum:
   - `iss` — provider identifier (`https://api.anthropic.com`, etc.)
   - `model` — model identifier with version
   - `agent_session` — opaque ID binding this attestation to a model session
   - `aud` — the MCP server identifier (matches `Environment.mcp_server`)
   - `exp`, `iat`, `jti`
3. Signature algorithm: EdDSA (Ed25519) or ES256, keyed by a published JWKS.
4. The MCP server resolves `iss` → JWKS (cached), verifies the signature,
   verifies `aud` against its own identifier, and only then sets
   `attestation_status: "verified"`.

Until that ecosystem exists, the field is `"self_declared"` or `"absent"`.

## §5 — Interim implementation (works today)

`buildInterimAgentIdentity(input)` in `src/models/agent-identity.ts` accepts a
`session_info`-shaped payload and produces a structurally valid
`AgentIdentity` with:

- `human_authority.verified` derived from `auth_strategy` —
  `siwe`/`inapp_email`/`inapp_oauth` → `true`; `dev`/`__stdio__`/missing →
  `false`.
- `model_attestation = { attestation_status: "self_declared" }` if the caller
  supplies `provider`/`model`; otherwise `{ attestation_status: "absent" }`.
- `environment.wallet_anchor` populated from the active wallet entry in
  `wallets[]`.
- `session_scope` from `scope` / `token_expires_at` /
  `token_expires_in_seconds`.

The function performs **no I/O** and does **not** import from
`src/tools/session.ts` — it is a pure mapper so FN-059 can wire it from any
context (request handler, A2A bridge, test fixture) without coupling.

**Trust degradation under the interim path:**

- `model_attestation` is meaningless for security; treat as advisory log
  metadata only.
- Any `human_authority` whose `auth_strategy` is `dev` or `__stdio__` carries
  `verified: false` and MUST NOT participate in authority inheritance
  (§3).

## §6 — Non-goals

- **Revocation transport** — JTI denylist already exists in
  `src/gateway/session.ts`; this spec does not extend it.
- **Attestation transport** — how the provider's JWS reaches the MCP server
  (header? A2A frame? out-of-band?) is FN-061's design space.
- **Cross-tenant delegation** — granting Bob's agent authority under Alice's
  `sub`. Out of scope; would require an explicit delegation credential.
- **On-chain identity binding** — linking `AgentIdentity` to an on-chain
  agent record (cf. `agent:write`/`agent:read` capabilities). Tracked
  separately.

## §7 — Open questions

| # | Question | Resolves in |
|---|---|---|
| Q1 | Should `human_authority.verified` distinguish "verified weak" (e.g. `inapp_email` without 2FA) from "verified strong" (`siwe`)? | FN-059 |
| Q2 | What is the canonical `mcp_server` identifier — env var, derived from a server-instance keypair, or fly app name? | FN-059 |
| Q3 | Where does the self-declared `provider`/`model` enter the system — MCP client capability negotiation, custom header, or A2A handshake field? | FN-060 |
| Q4 | Which JWS algorithm and JWKS resolution rules do we mandate? | FN-061 |
| Q5 | Do we expose `AgentIdentity` over an MCP tool (e.g. `agent_identity`) or only as an internal struct? | FN-059 |

## §8 — References

- Issue [#11](https://github.com/etofdn/eto-mcp/issues/11) — upstream framing.
- FN-054 — A2A coordination milestone.
- FN-059 — authority inheritance enforcement (consumes this spec).
- FN-060 — A2A coordination implementation.
- FN-061 — `model_attestation` verification research.
- `src/tools/session.ts` — `session_info` MCP tool.
- `src/gateway/session.ts` — `SessionPayload` / HMAC token format.
- `src/gateway/auth.ts` — `authenticate()` and auth strategies.
- `src/signing/session-context.ts` — `currentScope()`.
- `src/signing/local-signer.ts` — wallet keypair anchor.
