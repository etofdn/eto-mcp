# ETO Agent Identity Model — `human × model × environment`

> Tracking issue: [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11)
> Upstream task: **FN-058** (this spec).
> Downstream: **FN-059** (authority-inheritance enforcement), **FN-060** (A2A coordination), **FN-061** (model-attestation research). Part of the **FN-054** A2A milestone.
>
> Status: **normative spec, no runtime wiring yet.** A reference TypeScript shape lives at [`src/models/agent-identity.ts`](../src/models/agent-identity.ts); no MCP tool currently emits or consumes it. FN-059 is the first task that will wire it into a request handler.

---

## §1 — Why a multi-axis identity

Today's session model in `src/gateway/session.ts` answers a single question:
*"Is this caller's bearer token validly signed for some `sub`?"* That binds a
request to a **human authority** (the user behind `sub`) and to a bounded
**session scope** (`exp`, `caps`, `wallet_id`). It is silent on two questions
that A2A coordination ([FN-054](#)) forces us to answer:

1. **Which AI model produced this action?** Two MCP sessions can share the same
   `sub` while running on completely different model providers (Claude, GPT,
   self-hosted Llama). Trust decisions about *autonomous-agent* behavior — rate
   limits, capability gating, audit logs — need to attribute actions to a
   model, not just a person.
2. **Where is the agent executing?** "The same human" running ETO from the
   stdio CLI on their laptop, from a hosted SSE deployment, and from a CI
   runner is three different *execution surfaces*. The cryptographic anchor
   (the wallet keys actually doing the signing) and the network-reachable
   endpoint are surface-specific.

The agent identity model therefore tuples four orthogonal axes:

```
AgentIdentity = {
  human_authority,    // who authorized this agent
  model_attestation,  // what AI is steering it
  environment,        // where it's running + crypto anchor
  session_scope,      // bounded MCP session window
}
```

Each axis has its own source-of-truth, its own threat model, and its own
verification roadmap. They compose: an A2A counterpart that wants to trust an
incoming message MUST evaluate all four, and MAY make different trust
decisions on each.

---

## §2 — The four fields

### §2.1 — `human_authority`

| | |
|---|---|
| **Definition** | The human (or human-controlled service account) that consented to this agent acting on their behalf. |
| **Type (TS)** | `HumanAuthority` |
| **Source-of-truth (today)** | `SessionPayload.sub` + `SessionPayload.auth_strategy` from `src/gateway/session.ts`, surfaced via `authenticate()` in `src/gateway/auth.ts`. |
| **Concrete values today** | `sub` = thirdweb-issued wallet address (SIWE / inapp_email / inapp_oauth strategies), the literal `"dev-user"` (dev-bypass), or the synthetic `"__stdio__"` scope when running over stdio without auth. |
| **Trust assumption** | The session token's HMAC signature attests that *some* trusted auth backend issued this `sub`. The strength of that attestation is a function of `auth_strategy`: `siwe` ≥ `inapp_oauth` ≥ `inapp_email` ≫ `dev`. `__stdio__` carries no human attestation at all and MUST be treated as local-only. |
| **Threat model** | Compromise of `SESSION_SIGNING_KEY` lets an attacker forge any `sub`. Compromise of an upstream IdP (thirdweb) lets an attacker take over a single user's `sub`. Cross-tenant impersonation is out of scope for this spec (see [§7 Non-goals](#7-non-goals)). |

### §2.2 — `model_attestation`

| | |
|---|---|
| **Definition** | A claim about which AI model/provider produced the agent's tool calls, and whether that claim is cryptographically verified. |
| **Type (TS)** | `ModelAttestation` with discriminator `attestation_status: "verified" \| "self_declared" \| "absent"`. |
| **Source-of-truth (forward)** | A provider-signed JWT/JWS attesting `{ model_id, provider, issued_at, audience }`, verified against the provider's published JWKS. Tracked by **FN-061**. |
| **Source-of-truth (today)** | None. The MCP server cannot today verify what model is on the other end of the protocol; the field is `attestation_status: "self_declared"` carrying whatever the agent advertises in a `User-Agent`-style header, or `attestation_status: "absent"` if nothing was sent. |
| **Trust assumption** | When `attestation_status === "verified"`: trust the provider's JWKS. When `"self_declared"`: treat the model claim as a **hint for telemetry only**, never for capability gating. When `"absent"`: do not branch on model identity at all. |
| **Threat model** | Self-declared values can be spoofed trivially. Verified values inherit the provider's KMS posture; signature replay across audiences is mitigated by `aud` binding to the MCP server's origin. |

This is the axis that explicitly *does not work today*. The interim path
(see [§5](#5-interim-implementation-works-today)) is to record the
self-declared claim and propagate `attestation_status: "self_declared"` so
downstream code can refuse to trust it.

### §2.3 — `environment`

| | |
|---|---|
| **Definition** | The execution surface the agent is running on, plus the cryptographic wallet anchor it controls. |
| **Type (TS)** | `Environment` |
| **Source-of-truth** | `currentScope()` from `src/signing/session-context.ts` (`__stdio__` / `__dev__` / thirdweb sub) for the surface; `localSignerFactory` (`src/signing/local-signer.ts`) for the SVM (Ed25519 base58) and EVM (secp256k1 0x-hex) addresses derived from the active wallet. |
| **Concrete values** | `surface ∈ { "stdio", "sse", "dev" }`, `server_instance` = `last_restart_iso` from `session_info`, `wallet_anchor = { id, svm, evm }` from the active wallet. |
| **Trust assumption** | The wallet anchor is the **strongest** signal in this entire model: anyone presenting a signature over a fresh challenge from `wallet_anchor.svm` or `wallet_anchor.evm` proves possession of the corresponding private key. A2A trust SHOULD prefer wallet-anchor proofs over `human_authority` claims when they disagree. |
| **Threat model** | A surface label (`"sse"`) is unauthenticated metadata. A wallet address is authenticated metadata only after a fresh signature challenge — never trust a wallet address presented in a payload alone. |

### §2.4 — `session_scope`

| | |
|---|---|
| **Definition** | The bounded MCP session window inside which this identity is valid. |
| **Type (TS)** | `SessionScope` |
| **Source-of-truth** | `SessionPayload.{ jti, exp, caps }` plus the persistence-key `scope` string from `currentScope()`. |
| **Concrete values** | `{ scope, jti, expires_at_iso, capabilities[] }`. |
| **Trust assumption** | A token with `exp < now` is invalid regardless of how strong every other axis is. Capabilities (`caps[]`) are the authoritative authorization list; identity in this spec does NOT confer capability — it only attributes. |
| **Threat model** | Token replay before `exp` is mitigated by HMAC binding + the `revoked_jtis` denylist in `src/gateway/session.ts`. Capability escalation is gated by `requireCapability()`, not by anything in this spec. |

---

## §3 — Authority inheritance rule

> **Rule.** Two `AgentIdentity` values `A` and `B` MAY transitively trust each
> other for the *intersection* of `A.session_scope.capabilities` and
> `B.session_scope.capabilities`, **iff** all of the following hold:
>
> 1. `A.human_authority.sub === B.human_authority.sub`, AND
> 2. Both `A.human_authority` and `B.human_authority` carry an
>    `auth_strategy` other than `"dev"` and a scope other than `"__stdio__"`
>    (i.e. both are anchored to a real human-authenticated backend), AND
> 3. Neither `session_scope` is expired.
>
> The rule is **silent on `model_attestation`**: two agents inherit authority
> across model providers, because the human is the same human. The rule is
> **silent on `environment`**: a user can fan out work from their laptop to a
> hosted runner under the same `sub`, and inheritance still holds.

### §3.1 — Worked example

Alice signs in with thirdweb SIWE on her laptop. The MCP server issues
session token `T_laptop` with `sub = 0xAlice`, `auth_strategy = "siwe"`,
`caps = [a2a:write, transfer:write, …]`. Her IDE runs Claude.

Alice also has a hosted runner that authenticated as `0xAlice` through the
same thirdweb provider; it holds session token `T_runner` with the same `sub`
but `caps = [a2a:write, a2a:read]` only (narrowed by capability scoping at
issuance). It runs GPT.

A2A message flow: the runner agent (GPT) sends an A2A message to a counterpart
that holds `T_laptop` (Claude). The receiver evaluates inheritance:

- `sub` matches (`0xAlice` ↔ `0xAlice`) ✓
- both `auth_strategy = "siwe"` ✓
- both unexpired ✓

→ The receiver MAY treat the message as Alice-authorized. The action it can
ultimately *perform* is gated by **its own** `capabilities[]`, not the
sender's: inheritance attributes intent, it does not lend caps. If the
receiver only has `a2a:read`, it cannot turn an inherited request into a
`transfer:write`.

### §3.2 — When inheritance does NOT apply

- `__stdio__` ↔ anything: stdio carries no human attestation, so it cannot
  inherit from or to an authenticated session. Stdio agents are local trust
  only.
- `__dev__` / `auth_strategy = "dev"`: dev-bypass MUST NOT inherit into
  production-strategy sessions even on a `sub` collision.
- `model_attestation`-based gating: a counterpart MAY *additionally* require
  `model_attestation.attestation_status === "verified"` for a specific
  capability. That check is layered ON TOP of the rule above; it does not
  weaken it.

---

## §4 — Verification roadmap for `model_attestation`

The eventual flow ([FN-061](#) tracks the research):

1. The agent runtime obtains a short-lived JWT from its model provider with
   payload approximately:
   ```json
   {
     "iss": "https://provider.example/v1",
     "sub": "model:claude-3-7-sonnet-20250219",
     "aud": "https://mcp.eto.example",
     "iat": 1735689600,
     "exp": 1735690200,
     "model_id": "claude-3-7-sonnet-20250219",
     "provider": "anthropic"
   }
   ```
2. The agent attaches the JWT in an `X-Model-Attestation` header (or MCP
   transport equivalent) on each outbound MCP request.
3. The MCP server verifies the JWT against the provider's published JWKS
   (cached, with rotation). `aud` MUST equal the server's canonical origin.
4. On success: emit `ModelAttestation` with `attestation_status: "verified"`,
   carrying `provider`, `model_id`, and the signature's `kid`.
5. On any failure (signature, `aud`, `exp`, unknown provider): emit
   `attestation_status: "absent"`. Do NOT downgrade to `"self_declared"` —
   self-declared is for the case where there was *no* attestation attempted.

**Open design questions** flagged for FN-061:

- Signature algorithm — RFC 9458/9461 / JWS `EdDSA` vs. `ES256`.
- Key discovery — direct JWKS URL vs. a registry like
  [`oauth-for-ai-agents`](https://github.com/etofdn/eto-mcp/issues/11)-style
  IdP federation.
- Revocation — short `exp` (≤ 60 s) is the working assumption; explicit
  revocation lists are deferred.
- Tenant binding — whether `aud` alone is enough, or a per-deployment nonce
  is required to defeat replay across ETO instances.

---

## §5 — Interim implementation (works today)

Until FN-061 lands, every `AgentIdentity` we can construct has
`model_attestation.attestation_status` of `"self_declared"` or `"absent"`.
Construction reuses the existing `session_info` MCP tool's response shape
*as data input only* — no new tool, no change to `session_info` itself
(that's FN-059's job).

A pure builder is exported as
[`buildInterimAgentIdentity`](../src/models/agent-identity.ts) with this
contract:

```ts
buildInterimAgentIdentity({
  // session_info-shaped payload:
  scope,                       // currentScope()
  active_wallet_id,            // wallet.ts
  wallets: [{ id, label, svm, evm }, ...],
  auth_strategy,               // SessionPayload.auth_strategy | null
  token_expires_at,            // ISO string | null
  last_restart_iso,            // server boot ISO
  // optional caller-provided hints:
  declared_model?: { provider, model_id }, // becomes self_declared attestation
  capabilities?: string[],     // SessionPayload.caps | undefined
  jti?: string,                // SessionPayload.jti | undefined
}): AgentIdentity
```

The builder:

1. Maps `scope` + `auth_strategy` into `human_authority`, computing
   `human_authority.kind` as `"thirdweb"` (real `sub`),
   `"stdio"` (`scope === "__stdio__"`), `"dev"` (`auth_strategy === "dev"`
   or `scope === "__dev__"`), or `"unknown"`.
2. Maps the active wallet's `{svm, evm}` into `environment.wallet_anchor`,
   and `last_restart_iso` into `environment.server_instance`. Surface is
   inferred from `scope` (`"__stdio__"` → `"stdio"`, `"__dev__"` → `"dev"`,
   anything else → `"sse"`).
3. If `declared_model` is provided, emits
   `attestation_status: "self_declared"` carrying it. Otherwise emits
   `attestation_status: "absent"`.
4. Maps `token_expires_at`, `capabilities`, `jti`, and `scope` into
   `session_scope`.

**The builder MUST throw** if `scope` is missing — there is no meaningful
identity without a session-scope persistence key.

**Trust degradation.** Any consumer of an interim `AgentIdentity` MUST
treat `model_attestation` as untrusted telemetry. Specifically:

- Authority inheritance ([§3](#3--authority-inheritance-rule)) is permitted
  on `human_authority` alone, since that field is HMAC-attested today.
- Capability gating MUST NOT branch on `model_attestation` until `verified`
  is reachable.

---

## §6 — Type reference

The canonical TS surface is in [`src/models/agent-identity.ts`](../src/models/agent-identity.ts).
Field-level JSDoc cites the section numbers in this document.

```ts
interface AgentIdentity {
  human_authority: HumanAuthority;     // §2.1
  model_attestation: ModelAttestation; // §2.2
  environment: Environment;            // §2.3
  session_scope: SessionScope;         // §2.4
}
```

---

## §7 — Non-goals

This spec deliberately does NOT cover:

- **Revocation transport.** Token revocation lives in
  `src/gateway/session.ts`'s `revokeJti` denylist and is independent of
  this identity shape.
- **Attestation transport.** How `X-Model-Attestation` arrives at the server
  (HTTP header vs. MCP-protocol extension) is FN-061's call.
- **Cross-tenant delegation.** "Alice's agent acts on behalf of Bob" is not a
  case of authority inheritance; it requires a delegation credential and is
  out of scope.
- **A2A wire format.** How an `AgentIdentity` is serialized into an A2A
  envelope is FN-060's call.
- **MCP tool changes.** `session_info` and `SessionPayload` are unchanged.
  FN-059 is the first task that will wire `AgentIdentity` into a handler.

---

## §8 — Open questions

| # | Question | Resolved by |
|---|---|---|
| Q1 | Should `human_authority.kind === "stdio"` ever participate in inheritance with another stdio session on the same host? | FN-059 |
| Q2 | What is the exact JWS algorithm and JWKS discovery story for `model_attestation`? | FN-061 |
| Q3 | Does `environment.surface` need a fourth value (`"http-bridge"`) for the SSE-bridge variant? | FN-060 |
| Q4 | Should `session_scope.capabilities` be re-projected into a coarser A2A capability vocabulary, or carried verbatim? | FN-060 |
| Q5 | Is `wallet_anchor` allowed to carry multiple wallets (the user's full set), or must it be the single active wallet at issuance? | FN-059 |

---

## §9 — Cross-references

- Upstream tracking issue: [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11)
- A2A milestone: **FN-054**
- Authority-inheritance enforcement: **FN-059** (consumes this spec)
- A2A coordination wire format: **FN-060**
- Model-attestation research: **FN-061**
- Session and capability primitives: [`src/gateway/session.ts`](../src/gateway/session.ts), [`src/gateway/auth.ts`](../src/gateway/auth.ts)
- Scope context: [`src/signing/session-context.ts`](../src/signing/session-context.ts)
- Wallet anchor: [`src/signing/local-signer.ts`](../src/signing/local-signer.ts)
- Today's identity-adjacent tool: [`src/tools/session.ts`](../src/tools/session.ts) (`session_info`)
