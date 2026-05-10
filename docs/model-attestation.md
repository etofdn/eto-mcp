# Model Attestation — JWKS Publication & Rotation Contract

This document is the authoritative spec for how the eto-mcp server publishes
its Ed25519 signing key for downstream verifiers. Sibling tasks
**FN-049** (session-attestation minting), **FN-050** (`session_info`
surfacing), **FN-051** (verifier extension), and **FN-052** (counterparty
verifier reference) all consume the contracts in §5.1 and §5.3 below.

The agent-identity model that frames *why* this key exists lives in
[`agent-identity-model.md`](./agent-identity-model.md) §2.2 (`model_attestation`).

---

## §5.1 — JWKS publication

The eto-mcp server publishes its signing key as a JWKS document at:

```
GET /.well-known/jwks.json
```

| Property | Value |
|---|---|
| **Status** | `200 OK` on success; `500` with `{ code: "JWKS_001", message: "JWKS unavailable" }` if the signing key cannot be loaded. |
| **Content-Type** | `application/jwk-set+json` |
| **Cache-Control** | `public, max-age=300, must-revalidate` (matches the default overlap window so HTTP caches naturally re-fetch within the rotation window). |
| **Authentication** | None. The endpoint is unauthenticated; downstream verifiers MUST be able to resolve `kid` without holding a Bearer token. |
| **CORS** | Inherits the global CORS allow-all middleware mounted in `src/sse-server.ts`. |

### JWK shape (RFC 7517 + RFC 8037)

Each key in `keys[]` is an OKP / Ed25519 JWK:

```json
{
  "kty": "OKP",
  "crv": "Ed25519",
  "x": "<base64url(public-key, 32 bytes, no padding)>",
  "kid": "mcp-server-<16-char-id>",
  "use": "sig",
  "alg": "EdDSA"
}
```

### `kid` derivation

`kid` is computed as:

```
kid = "mcp-server-" + base64url(sha256(serverInstance + ":" + rotationEpoch)).slice(0, 16)
```

- `serverInstance` — the process's `last_restart_iso` (the ISO timestamp of
  process start; identical to `session_info.last_restart_iso`).
- `rotationEpoch` — a counter that starts at `0` and increments by exactly 1
  on each `rotateServerKey()` call.

### Token verification (consumer side)

Tokens issued by this server (FN-049 onwards) carry the `kid` in their JOSE
header. Consumers MUST:

1. Resolve `kid` against the JWKS document.
2. If `kid` is unknown, **refetch the JWKS** before failing verification —
   a rotation may have just happened.
3. Verify the JWS signature using `alg: "EdDSA"` over the JWK's `x` bytes.

---

## §5.3 — Rotation overlap contract

To avoid invalidating in-flight tokens at rotation time, the server serves
the **previous key alongside the new one** for a configurable overlap window.

### Guarantees

1. **Always one current key.** The first entry in `keys[]` is the active
   signing key — newly issued JWS are signed with this key.
2. **At most one previous key.** On rotation, exactly one previous key is
   appended to `keys[]` and continues to be served until
   `rotatedAt + overlapSeconds`. Older keys (rotated more than one cycle
   ago) are NOT retained.
3. **`kid` always changes on rotation.** Because `rotationEpoch` is part of
   the `kid` derivation, every rotation produces a fresh `kid` even if the
   underlying private key were (hypothetically) reused.
4. **Configurable window, bounded.** The overlap is configured via
   `MCP_JWKS_OVERLAP_SECONDS`. Default: `300` (5 minutes). Bounds:
   **`[60, 86400]`** (1 minute to 24 hours). Out-of-range values at
   rotation time are rejected; out-of-range env values fall back to the
   default at server start.

### Consumer expectations

- Clients MUST treat `kid` as opaque — never parse or trust components of
  the string.
- Clients MUST refetch the JWKS on **any** unknown `kid` before failing
  verification (a rotation may have completed between the token's issuance
  and the consumer's first sighting of `kid`).
- Clients SHOULD respect the `Cache-Control: max-age=300` header. With the
  default 300-second overlap, a single cache miss cycle is sufficient to
  pick up a freshly rotated key before the old one expires.

### Operator configuration

| Env var | Default | Required in production? |
|---|---|---|
| `MCP_SERVER_SIGNING_KEY_PATH` | *(unset → ephemeral keypair, dev only)* | **Yes.** Without it, the server fails fatally at first use. |
| `MCP_JWKS_OVERLAP_SECONDS` | `300` | No. Must be in `[60, 86400]` if set. |

---

## Cross-references

- `src/signing/server-key.ts` — process-scoped Ed25519 keypair owner.
- `src/signing/jwks.ts` — JWKS builder, `computeKid`, `rotateServerKey`.
- `src/sse-server.ts` — endpoint mount.
- `tests/signing/jwks.test.ts`, `tests/signing/jwks-route.test.ts` —
  conformance tests for the contracts above.
