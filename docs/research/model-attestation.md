# Model Attestation Research — "OAuth for AI Agents"

> **Task:** FN-061 (research-only).
> **Upstream:** [FN-058](../agent-identity-model.md) — defines the
> `AgentIdentity` shape and the `model_attestation` field this research
> closes the loop on.
> **Downstream:** **FN-059** (authority-inheritance enforcement) will be
> able to consume a `attestation_status: "verified"` value once the
> recommended interim approach below ships.
> **Tracking issue:** [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11).
>
> Status at time of writing: FN-058's spec
> (`docs/agent-identity-model.md`) and reference type
> (`src/models/agent-identity.ts`) have landed. This research is consistent
> with their `ModelAttestation` discriminator —
> `"verified" | "self_declared" | "absent"` — and the recommendation in
> [§5](#5--recommendation) slots in as the first concrete producer of
> `attestation_status: "verified"`.

---

## §1 — Problem statement

The `model_attestation` axis of `AgentIdentity` (FN-058 §2.2) answers the
question *"which AI model produced this action?"*. Today the field is at
best `attestation_status: "self_declared"`: the caller advertises a
`{provider, model_id}` pair and the server records it as untrusted
telemetry. Nothing today prevents a caller from claiming to be
`claude-opus-4` while the prompts are actually flowing through
`gpt-3.5-turbo` — or, worse, through a fine-tuned uncensored local model.

A2A coordination ([FN-054](../agent-identity-model.md#9--cross-references))
will eventually want to **branch capability decisions on model identity**
(rate limits, autonomous-action gating, audit-log attribution). For that
branch to be safe, `model_attestation.attestation_status` MUST reach
`"verified"` for at least one provider, signed against a trust root that
is independent of the calling agent.

This document surveys the standards landscape, articulates a threat model,
evaluates concrete options, and recommends a single interim approach
implementable inside the eto-mcp server in **under four weeks**.

---

## §2 — Standards landscape

### §2.1 — OAuth 2.0 / OIDC id_tokens with a `model` claim

The cleanest answer would be: *the model provider issues a short-lived JWT
that names the model that produced a given completion, and the agent
forwards that JWT to the MCP server.* This is exactly the FN-058 §4
roadmap.

**Maturity / provider support today (May 2026):**

| Provider | Issues a per-completion signed token naming the model? |
|---|---|
| **Anthropic** (Messages API) | **No.** The API surfaces `model` as an unsigned response field in the JSON body. There is no OIDC issuer, no JWKS, and no documented attestation header. The only authenticated artifact returned is the HTTPS TLS certificate of `api.anthropic.com`, which only attests *Anthropic served this byte stream* — not *which weights produced it*. |
| **OpenAI** (Chat Completions / Responses API) | **No.** Same posture: `model` is an unsigned JSON field. The closest construct is the API-key-scoped HMAC of webhook deliveries (Webhook Signatures), which signs *delivery* not *inference*. |
| **Google Vertex AI / Gemini** | **No public model-attestation token.** Google does sign Vertex AI service-to-service calls with workload-identity OIDC tokens, but those identify the *caller* (the workload calling Vertex), not the model that responded. |
| **AWS Bedrock** | **No.** Same posture as Vertex; SigV4 attests the caller, not the model. |

Source links and verification trail for the table above are deferred to
the follow-up implementation task (it should re-check provider docs at
implementation time, since this is a moving target). The position taken
by this document is: **as of 2026-05, no major commercial AI provider
ships a per-response signed token naming the model.**

**What it does not solve, even when it ships:** a compromised provider
KMS forges the model name; the agent runtime substitutes a different
model after receiving the token (replay onto a different conversation);
self-hosted / fine-tuned models that have no provider issuer at all.

**Maturity:** RFC 7519 (JWT) / OIDC Core are mature and ubiquitous. The
gap is the *content* — no provider signs the `model` claim. Integration
cost on the MCP server side once a provider does ship is low (JWKS fetch
+ caching + JWS verify, all standard). Integration cost today is
**infinite** — there is nothing to integrate against.

### §2.2 — OIDC federation / workload identity (SPIFFE, GitHub OIDC)

[SPIFFE/SPIRE](https://spiffe.io) and [GitHub Actions
OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
are the canonical analogues for *"the runtime proves what it is"*.
GitHub's OIDC issuer signs claims like
`repo:owner/repo:ref:refs/heads/main`, and downstream verifiers trust
that the GitHub control plane will not mint that claim for a workflow
not running on `main`.

**Relevance to model attestation:** the analogue is *the AI provider's
control plane signs `model:claude-opus-4`*. Architecturally identical to
§2.1 — same JWS + JWKS shape, different issuer story. The blocker is the
same: no AI provider runs such an issuer today.

**What SPIFFE/SPIRE adds beyond plain OIDC:** automatic key rotation, an
attestation policy language, and SVID (X.509 + JWT) co-issuance. None of
this is reachable for "model attestation" until a provider deploys a
SPIRE server (or equivalent) keyed to inference fleets. Out of reach in
the four-week window.

**Maturity:** SPIFFE is widely deployed (Istio, Tetragon, AWS Roles
Anywhere). Provider support for AI-model attestation: zero.

### §2.3 — W3C DID + Verifiable Credentials

A model provider could be a [DID](https://www.w3.org/TR/did-core/) issuer
(e.g. `did:web:anthropic.com`) and mint a
[Verifiable Credential](https://www.w3.org/TR/vc-data-model-2.0/) per
inference session:

```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  "type": ["VerifiableCredential", "ModelInferenceCredential"],
  "issuer": "did:web:anthropic.com",
  "validFrom": "2026-05-03T12:00:00Z",
  "validUntil": "2026-05-03T12:01:00Z",
  "credentialSubject": {
    "id": "did:key:z6Mki...agent",
    "model_id": "claude-opus-4",
    "model_version": "20260101",
    "inference_session_id": "sess_abc"
  }
}
```

**Maturity:** VC Data Model 2.0 is a W3C Recommendation; verifier
libraries exist in TS (`@digitalbazaar/vc`). The eto-mcp codebase already
issues / consumes VCs in the Beckn schema registry
(`docs/schema-registry.md`), so the *plumbing* is familiar.

**Provider support today:** none. No major AI provider operates a DID or
publishes inference credentials. The format is right; the issuers are
absent.

**What it does not solve:** the same trust-substitution gap as §2.1 —
once the credential is in the agent's hands, nothing prevents the agent
runtime from serving a *different* model's outputs alongside the
credential.

**Integration cost:** higher than plain JWT (DID resolution, VC proof
suites, JSON-LD canonicalization). Justified only if eto-mcp's broader
architecture standardises on VCs across axes — which it already partly
does for the Beckn axis but **not** for session/agent identity.

### §2.4 — DPoP / PoP tokens (RFC 9449)

[RFC 9449 (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449) binds an
OAuth access token to a key the **client** controls: every request
carries a JWS over `{ htm, htu, iat, jti }` signed by the client's
private key, and the access token's `cnf.jkt` is the SHA-256 thumbprint
of that key.

**Relevance to model attestation:** DPoP is a *binding* mechanism, not an
*identity* mechanism. It tells the server "the same key that proved
possession at session start is presenting this request" — it does **not**
tell the server "an AI model produced this request." That said, DPoP is
the right primitive for **freshness and replay-resistance** of whatever
model attestation does end up being used: a per-session keypair held by
the agent runtime, signing each tool call's nonce, defeats replay of a
captured attestation across sessions.

**Maturity:** RFC published 2023; supported by major OAuth servers
(Curity, Keycloak ≥ 24, Auth0 in preview).

**What it does not solve:** the substitution attack — DPoP proves
possession of a key, not the identity of whatever software is steering
that key.

### §2.5 — Remote attestation (TEE / AWS Nitro / TPM / Confidential VMs)

The "real" answer in the long horizon: the inference runtime executes
inside a TEE (Intel TDX, AMD SEV-SNP, AWS Nitro Enclaves, Apple Secure
Enclave) and the attestation document signed by the hardware root of
trust includes a hash of the model weights and the runtime image. A
verifier can then assert "these specific weights produced this output"
with hardware-grade confidence.

**Maturity:** Nitro Enclaves and TDX are production-ready; the open
question is the **signing pipeline that incorporates model weights into
the measurement**. Some providers (e.g. Apple's Private Cloud Compute,
Anthropic's stated direction in
[their March 2025 trust posture post](https://www.anthropic.com/news))
are moving here, but no provider exposes a verifier-friendly
remote-attestation endpoint as of writing.

**Out of scope for this v1.** TEE attestation is the long-horizon goal
and should be tracked as a separate research note when the first provider
ships an endpoint. It cannot be delivered in four weeks.

### §2.6 — Summary table

| Standard | Maturity | Provider support today | Integration cost | What it does NOT solve |
|---|---|---|---|---|
| OIDC id_token w/ `model` claim (§2.1) | Mature | **None** | Low (when shipped) | Substitution; self-hosted models |
| OIDC federation / SPIFFE (§2.2) | Mature in cloud | **None for AI** | Medium | Same as §2.1 |
| W3C DID + VC (§2.3) | W3C Rec | **None** | Medium-High | Substitution; verifier ecosystem |
| DPoP / PoP (§2.4) | RFC 9449 | Mature in OAuth servers | Low | Identity (it's a binding, not a name) |
| TEE remote attestation (§2.5) | Production hardware; nascent in AI | **None for AI inference** | High | n/a — strongest long-term answer |

---

## §3 — Threat model

The attestation surface must defend against the following attacks. Each
is the *attacker's* goal; the defending property the chosen mechanism
must enforce is in italics.

| # | Attack | Property to enforce |
|---|---|---|
| **T1** | Caller lies about `model_id` (claims `claude-opus-4` while calling from `gpt-3.5-turbo`) | *Model name is signed by an authority other than the caller.* In the interim approach this is weakened: see §4 caveat. |
| **T2** | Replay of a captured attestation across sessions | *Attestation is bound to the MCP `session.sub` and `session.jti` and expires with the session token.* |
| **T3** | Caller swaps models mid-session (declares Claude at session start, switches to a local model for the dangerous call) | *Attestation is presented per-tool-call with a freshness nonce, not once at session start.* |
| **T4** | Compromised MCP server forges attestations for other callers | *Server-signed attestations are scoped to the signing server's `server_instance` and verifiable against a per-deployment public key the A2A counterparty can pin.* |
| **T5** | Replay across MCP deployments (steal an attestation from staging, present at prod) | *`aud` claim binds the attestation to a single canonical origin.* |
| **T6** | Self-declared value silently elevated to "verified" by a buggy verifier | *`attestation_status` discriminator is set only on a verified-signature code path; FN-058 already encodes this as a TS union, the implementation must mirror it.* |

### §3.1 — Requirements

The chosen mechanism MUST satisfy all of:

- **R1.** Bind the model claim to a specific MCP `session.sub` and
  `session.jti` (defeats T2).
- **R2.** Be verifiable per-tool-call, not just at session establishment
  (defeats T3) — i.e. it is presented in a way that includes a freshness
  nonce or signs the request payload.
- **R3.** Carry an `aud` (or equivalent) tied to a single canonical MCP
  origin (defeats T5).
- **R4.** Expire no later than the session token's `exp` (defeats T2).
- **R5.** Be representable as `attestation_status: "verified"` (or a new,
  clearly-justified discriminant) inside the FN-058
  `ModelAttestation` union — i.e. it does not require widening the union
  beyond what FN-058 §6 permits.
- **R6.** Be verifiable **offline** by a downstream A2A counterparty
  (defeats T4) — the public key needed to verify must be discoverable
  without an online callback to the issuing MCP server, e.g. via JWKS
  served from a stable URL or pinned in the counterparty's config.

The interim mechanism MAY relax T1 (see §4 option-2 caveat); the
roadmap mechanism (§2.1) MUST satisfy T1 fully.

---

## §4 — Options evaluated

Each option is scored against R1–R6 in §4.5.

### §4.1 — Option A: Provider-issued OIDC id_token with `model` claim

**Mechanism.** AI provider runs an OIDC issuer publishing JWKS; for each
inference (or session), the provider signs `{ iss, aud, sub: model_id,
iat, exp, model_id, provider }` as a JWS. Agent forwards the JWS to MCP
in an `X-Model-Attestation` header. MCP verifies against cached JWKS,
checks `aud` equals MCP origin, checks `exp`, emits
`attestation_status: "verified"`.

**Trust root.** AI provider's KMS.

**Who signs.** AI provider (Anthropic / OpenAI / etc.).

**Payload.** `{ iss, aud, sub: model_id, iat, exp, model_id, provider, kid }`.

**Integration with `src/gateway/auth.ts` and `session_info`.**
`authenticate()` reads `X-Model-Attestation`, dispatches to a new
`verifyModelAttestation()` helper that mirrors the JWKS-cache pattern
already used by `src/gateway/thirdweb.ts`. `session_info` returns the
verified `ModelAttestation` (no JWS — the verified record only, since
the JWS itself is provider-bound and not useful to A2A counterparties
without provider trust).

**Effort.** ~2 person-weeks **once a provider ships** an issuer.
Effectively **infinite** today, because no provider does.

| Pros | Cons |
|---|---|
| Strongest trust root: independent of caller AND of MCP server | **Blocked: zero provider support today** |
| Drop-in fit with OIDC tooling already in repo (thirdweb pattern) | Substitution attack (T1) survives if agent runtime caches one provider's JWS and serves another model's outputs |
| Forward-compatible — when shipped, becomes the canonical answer | Self-hosted / fine-tuned models have no issuer |

### §4.2 — Option B: MCP-server-signed session attestation

**Mechanism.** At session establishment (or first tool call carrying a
`declared_model`), the MCP server signs a JWS with payload
`{ iss: server_instance, sub: session.sub, jti: session.jti, aud:
server_origin, model_id_declared, provider_declared, iat, exp:
session.exp, declaration_source: "self_declared" }` using the server's
existing Ed25519 key from `src/signing/local-signer.ts`. The JWS is
returned in the `session_info` response. Downstream A2A counterparties
verify the JWS against the server's published JWKS (a new endpoint —
`GET /.well-known/jwks.json`).

The crucial observation: this **does not solve T1** (the caller can
still lie about `model_id`), but it **does** cryptographically bind the
declaration to a specific session in a way the A2A counterparty can
verify offline. The attestation is "the MCP server confirms that THIS
session, identified by this `sub` and `jti`, declared this model at
this time" — not "the model itself is proven."

**Trust root.** The MCP server's Ed25519 key (already in production via
`local-signer.ts`).

**Who signs.** The MCP server.

**Payload.** Concrete TS shape in §5.2.

**Integration.**
- `src/signing/local-signer.ts` — gains a `signJws(payload)` helper (or
  a sibling module `src/signing/jws-signer.ts` that wraps it; decision
  in implementation task).
- `src/gateway/auth.ts` — at the end of a successful `authenticate()`,
  call into a new `mintSessionAttestation()` that returns the JWS
  string.
- `src/tools/session.ts` — `session_info` extends its response with
  `model_attestation_jws: string | null` (null in `__stdio__` and `dev`
  scopes that don't mint one).
- New route: `GET /.well-known/jwks.json` exposing the server's Ed25519
  public key with a stable `kid` derived from `server_instance` +
  rotation epoch.
- `src/models/agent-identity.ts` — extend the `ModelAttestation` union
  with a fourth variant `attestation_status: "session_signed"` (or
  treat it as `"self_declared"` carrying an extra `session_jws` field;
  picked in §5).

**Effort.** ~2.5 person-weeks. Breakdown:
- 0.5w: JWS signer wrapping `local-signer.ts`
- 0.5w: JWKS endpoint + key-rotation skeleton
- 0.5w: `auth.ts` minting + session_info plumbing
- 0.5w: `agent-identity.ts` union extension + builder update
- 0.5w: tests (unit + integration including A2A counterparty
  round-trip)

| Pros | Cons |
|---|---|
| **Ships in <4 weeks** — uses keys we already hold | Does NOT defeat T1 (model substitution by caller) — declaration is still self-asserted at the data layer |
| Cryptographically binds the declaration to `sub` + `jti` (R1) | Trust root is the MCP server itself; A2A counterparty must trust this server's JWKS |
| Verifiable **offline** by A2A counterparties via JWKS (R6) | Requires MCP server to publish a JWKS — small new attack surface |
| `aud` binding defeats cross-deployment replay (R5, T5) | Adds a key-rotation operational concern |
| Layers cleanly under Option A: when a provider ships an OIDC issuer, the server-signed attestation can carry a *nested* provider JWS, upgrading T1 coverage without re-architecting the wire format | Extends FN-058's `ModelAttestation` union by one variant |

### §4.3 — Option C: DPoP-style proof from a per-session agent keypair

**Mechanism.** At session start, the agent runtime generates an
ephemeral Ed25519 keypair and presents the public key to MCP via a new
`session_register_attestation_key` tool (or as a `cnf.jkt` claim in
the session token). On each tool call, the agent attaches a JWS over
`{ htm, htu, iat, jti, model_id, nonce }` signed by that key. MCP
verifies the JWS using the registered public key.

**Trust root.** Whatever proves the agent runtime was the one that
registered the public key — which today is *just* the session bearer
token, i.e. circular: an attacker who has the session token has the
ability to register their own attestation key.

**Who signs.** The agent runtime (per session).

**Payload.** `{ htm, htu, iat, jti, model_id, nonce }`.

**Integration.** New MCP tool to register the public key; new header
parsing in `auth.ts`; per-call JWS verification in every tool dispatch
path. This is the most invasive option in terms of request-path changes.

**Effort.** ~3 person-weeks. Borderline of the four-week window, and
the value-add is unclear because the trust root collapses to the
session token.

| Pros | Cons |
|---|---|
| Per-call freshness (R2, defeats T3) | Trust root is circular — session token compromise defeats it |
| RFC 9449 alignment — well-understood pattern | Most invasive integration: every tool dispatch path |
| Composes well with Option B (B can carry the DPoP `jkt`) | Does NOT identify the model — caller can still lie |
| | Effort estimate is the largest of the three |

### §4.4 — Option D (longer-horizon): DID/VC issued by provider

**Mechanism.** As §2.3. Out-of-band research direction — not a serious
candidate for the four-week window because no provider ships a DID.
Listed here for completeness so the comparison table in §4.5 covers
all four options the prompt asked for.

**Effort.** Indeterminate; gated on provider rollout. Today: **not
shippable.**

### §4.5 — Comparison table

| Requirement | A: Provider OIDC | **B: Server-signed session JWS** | C: DPoP-style | D: DID/VC |
|---|---|---|---|---|
| **R1** Binds to `sub`, `jti` | ✓ via `aud`+server lookup | **✓ directly in payload** | ✓ via session token | ✓ via subject DID |
| **R2** Per-call freshness | ✗ (per-token, not per-call) | △ (per-session JWS; per-call freshness comes from session_token DPoP if added) | ✓ | △ |
| **R3** `aud` binds origin | ✓ | **✓** | ✓ via `htu` | ✓ |
| **R4** Expires ≤ session.exp | ✓ | **✓ (set exp = session.exp)** | ✓ | ✓ |
| **R5** Fits FN-058 union | ✓ as `"verified"` | **✓ as `"verified"` w/ new `source: "session_signed"` sub-discriminator, OR as new `"session_signed"` variant** | ✗ (DPoP is a binding, not an attestation) | ✓ as `"verified"` |
| **R6** Offline verifiable by A2A | ✓ via provider JWKS | **✓ via MCP-server JWKS** | ✗ (verifier must trust the registering MCP) | ✓ via DID Doc |
| **Defeats T1 (caller lies)** | ✓ | **✗ (interim caveat)** | ✗ | ✓ |
| **Shippable in 4 weeks?** | **✗ — no provider** | **✓** | △ borderline | ✗ |

---

## §5 — Recommendation

**Pick Option B (MCP-server-signed session attestation).**

It is the only option that simultaneously (a) ships in under four weeks,
(b) reuses cryptographic material already in the repo, (c) satisfies R1,
R3, R4, R5, R6 outright, and (d) lays compatible groundwork for Option A
to slot in *later* as a nested provider JWS without re-architecting the
wire format.

The honest tradeoff is **T1**: Option B does not stop the caller from
lying about `model_id`. The recommendation is to ship B, surface this
caveat **explicitly** in the FN-058 spec (follow-up §5.4), and treat
T1-coverage as a separate roadmap item that comes for free once any
major provider ships Option A. Until then, capability gating that
**requires** model identity (e.g. "only Claude Opus 4 may execute
`transfer:write` autonomously") MUST NOT be built — only telemetry,
audit, and rate-limiting use cases that tolerate a self-asserted model
field with cryptographic session binding are appropriate consumers.

### §5.1 — Wire flow (text diagram)

```
                                 ┌──────────────────────────────┐
                                 │   eto-mcp server             │
                                 │   (keys: local-signer.ts)    │
                                 └──────────────┬───────────────┘
                                                │
  agent runtime                                 │
  (Claude / GPT / etc.)                         │
        │                                       │
        │ 1. POST /mcp/session  (thirdweb auth) │
        │    + X-Declared-Model: anthropic/...  │
        ├──────────────────────────────────────►│
        │                                       │
        │                                       │ 2. authenticate()
        │                                       │    → mintSessionAttestation({
        │                                       │        sub, jti,
        │                                       │        model_id_declared,
        │                                       │        provider_declared,
        │                                       │        exp = session.exp,
        │                                       │        aud = MCP_ORIGIN,
        │                                       │      })
        │                                       │    → JWS signed by Ed25519
        │                                       │      key from local-signer
        │                                       │
        │ 3. SessionPayload + jws ──────────────┤
        │◄──────────────────────────────────────┤
        │                                       │
        │ 4. session_info() ────────────────────►│
        │    returns { ..., model_attestation_jws } │
        │◄──────────────────────────────────────┤
        │                                       │
        │ 5. tool call  X-Session-Attestation: <jws>
        ├──────────────────────────────────────►│ 6. (optional re-verify or pass-through)
        │                                       │
        │ 7. A2A outbound to counterparty       │
        │    envelope carries the JWS           │
        ├──────────────────────────────────────►┌─────────────────────────────┐
                                                │  A2A counterparty            │
                                                │  • fetches MCP_ORIGIN/.well-known/jwks.json
                                                │    (cached, with rotation)   │
                                                │  • verifies JWS              │
                                                │  • checks aud == its peer URL│
                                                │  • emits ModelAttestation    │
                                                │    with attestation_status   │
                                                │    = "verified"              │
                                                └─────────────────────────────┘
```

### §5.2 — Concrete payload schema

Extension to `src/models/agent-identity.ts` (illustrative, not applied
in this task):

```ts
// New JWS payload type — what the server signs.
export interface ModelAttestationJwsPayload {
  /** Issuer: the MCP server's stable instance identifier. */
  iss: string;            // e.g. "https://mcp.eto.example#i-2026-05-03T12:00:00Z"
  /** Audience: canonical MCP origin (defeats T5 cross-deployment replay). */
  aud: string;            // MCP_CANONICAL_ORIGIN
  /** Subject: SessionPayload.sub. */
  sub: string;
  /** Session token id. */
  jti: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Must equal session.exp. */
  exp: number;
  /** Caller-declared provider (e.g. "anthropic"). */
  provider_declared: string;
  /** Caller-declared model id (e.g. "claude-opus-4"). */
  model_id_declared: string;
  /** Always "self_declared" in v1 — reserved for nesting a provider JWS later. */
  declaration_source: "self_declared" | "provider_jws";
  /** Optional: nested provider JWS (Option A) when one is presented. */
  provider_jws?: string;
}

// Extension to the discriminated union in FN-058.
// Recommended encoding: a new sub-shape under attestation_status === "verified",
// which keeps R5 satisfied without widening the discriminator.
export type ModelAttestation =
  | {
      attestation_status: "verified";
      source: "session_signed";       // NEW
      provider: string;                // = provider_declared
      model_id: string;                // = model_id_declared
      kid: string;                     // server JWKS kid
      issued_at: number;
      jws: string;                     // raw JWS for A2A propagation
      /** When true, a nested provider_jws was also verified (full T1 coverage). */
      provider_verified: boolean;      // false in v1 always
    }
  | { attestation_status: "verified"; source: "provider_oidc"; /* Option A */ … }
  | { attestation_status: "self_declared"; provider: string; model_id: string }
  | { attestation_status: "absent" };
```

The `source` sub-discriminator is the cleanest fit for FN-058's existing
union: `attestation_status: "verified"` keeps its semantic ("a signature
was verified") while `source` discloses **which authority** signed —
critical because A2A counterparties may trust `provider_oidc` for
capability gating but only `session_signed` for telemetry. Builders that
construct `attestation_status: "verified"` MUST set `source` and MUST
NOT branch capability decisions on `source: "session_signed"` until a
provider option is layered in.

### §5.3 — Module ownership

| Concern | Module | Status |
|---|---|---|
| Ed25519 key custody | `src/signing/local-signer.ts` | Existing — reuse `getPublicKey()`; add `signJws(payloadBytes)` helper |
| JWS construction | new `src/signing/jws-signer.ts` | New — wraps `local-signer` with header `{alg:"EdDSA", kid, typ:"JWT"}` |
| Mint at auth time | `src/gateway/auth.ts` | Extend — call `mintSessionAttestation()` after session payload is built |
| Verify (server-side, optional sanity) | `src/gateway/auth.ts` | Optional — receiving server may re-verify on per-call header |
| JWKS publication | new `src/gateway/jwks-route.ts` + register in `src/gateway/index.ts` | New |
| Surface to caller | `src/tools/session.ts` (`session_info`) | Extend response with `model_attestation_jws` |
| Type | `src/models/agent-identity.ts` | Extend `ModelAttestation` union per §5.2 |
| Construction | `buildInterimAgentIdentity` in `src/models/agent-identity.ts` | Extend to accept a verified-jws input and emit `attestation_status: "verified"` with `source: "session_signed"` |

### §5.4 — Migration path: `self_declared` → `verified`

1. **Today (post-FN-058).** Builder emits
   `attestation_status: "self_declared"` when caller passes
   `declared_model`, otherwise `"absent"`. No JWS.
2. **After Option B ships.** Builder emits
   `attestation_status: "verified", source: "session_signed",
   provider_verified: false` whenever a session JWS is mintable. The
   `self_declared` variant becomes reserved for legacy / unauthenticated
   surfaces (e.g. `__stdio__`).
3. **After Option A ships per provider.** Builder emits
   `attestation_status: "verified", source: "provider_oidc",
   provider_verified: true` when a provider JWS is presented and
   verified. Capability-gating policies can finally branch on
   `source === "provider_oidc"`.

This staircase satisfies R5 at every step and never requires breaking
changes to the FN-058 union — only additive variants.

### §5.5 — What this does NOT solve (explicit caveats)

- **T1: caller lies about model_id.** Option B cannot detect this. The
  field `model_id_declared` is exactly what the caller claimed; the
  server's signature only attests to the *binding*, not the *fact*.
  A2A counterparties MUST treat `source: "session_signed"` as
  "telemetry-grade" model identity until `source: "provider_oidc"`
  ships.
- **Compromised MCP server.** If the server's Ed25519 key is exfiltrated,
  arbitrary attestations can be forged for any historical `sub`/`jti`.
  Mitigated by short `exp` (≤ session lifetime, default 1h) + standard
  key-rotation hygiene; not eliminated. A counterparty pinning the JWKS
  detects key change but not in-window forgery.
- **Self-hosted / fine-tuned models.** Even when Option A ships, models
  without a provider issuer remain `source: "session_signed"` only.
  This is acceptable; eto-mcp does not need to gate on those.
- **Per-call freshness (T3).** Option B alone does not defeat
  mid-session model swap. Layering Option C (DPoP-style per-call signing
  by the agent's session keypair) on top is a follow-up — not in the v1
  scope.
- **Inference-substitution after provider JWS issuance.** Even Option A
  doesn't prove the response bytes came from the named model — only that
  the provider issued a token naming it. TEE attestation (§2.5) is the
  only path that closes this. Out of scope.

### §5.6 — Follow-up tasks (created in step 5)

The implementation of the recommendation above should fan out into the
following tasks. They are listed here for the reviewer; the actual
`fn_task_create` calls happen in this task's Step 5.

1. **Implement `src/signing/jws-signer.ts`** — Ed25519 JWS signer
   wrapping `local-signer.ts`. Unit tests for round-trip and
   tampered-payload rejection.
2. **Implement JWKS publication endpoint** — new Fastify route
   `GET /.well-known/jwks.json` exposing the server's Ed25519 public
   key with a stable `kid`. Includes key-rotation contract.
3. **Mint session attestation at auth time** — extend
   `src/gateway/auth.ts` to produce the JWS during `authenticate()` for
   non-stdio, non-dev sessions. Threads it through `SessionPayload` or
   a sibling structure consumed by `session_info`.
4. **Surface JWS in `session_info`** — extend `src/tools/session.ts`
   response with `model_attestation_jws`. Update the schema-registry
   docs cross-link.
5. **Extend `ModelAttestation` union and `buildInterimAgentIdentity`**
   per §5.2 — add `source: "session_signed" | "provider_oidc"` under the
   `"verified"` variant; wire a `verified_session_jws` input to the
   builder.
6. **A2A counterparty verifier sample** — small reference implementation
   showing JWKS fetch + JWS verify + `aud` check for downstream
   integrators (FN-060 will consume this).
7. **Clarify FN-058 spec around the new sub-discriminator** — file an
   amendment to `docs/agent-identity-model.md` §2.2 noting the
   `source` field added in this design. (Amendment-only; no breaking
   change.)

---

## §6 — Cross-references

- FN-058 spec — [`docs/agent-identity-model.md`](../agent-identity-model.md)
- FN-058 reference type — [`src/models/agent-identity.ts`](../../src/models/agent-identity.ts)
- FN-059 — authority-inheritance enforcement (will consume the
  `attestation_status: "verified"` from §5)
- Issue [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11)
  — upstream "OAuth for AI agents" framing
- Existing key custody — [`src/signing/local-signer.ts`](../../src/signing/local-signer.ts)
- Auth strategies the JWS minting must compose with —
  [`src/gateway/auth.ts`](../../src/gateway/auth.ts),
  [`src/gateway/session.ts`](../../src/gateway/session.ts)
- MCP tool surface that exposes the JWS to callers —
  [`src/tools/session.ts`](../../src/tools/session.ts)
