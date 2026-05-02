# BPP Keeper Template

> **Status:** scaffolding — FN-073 (T-2.7.1.1).
> **Consumers:** FN-074 (credential-gate refinement), FN-075–079 (reference BPPs), FN-085, FN-096 (bank BPP), FN-179.

A reusable TypeScript library for authoring **Beckn Provider Platforms (BPPs)** on top of the ETO Agent Keeper. A BPP is the supply-side participant in a Beckn `search → select → init → confirm → status` round-trip — it advertises a capability via its on-chain AgentCard, accepts task requests from a Beckn Application Platform (BAP), gates them on credentials, executes the work, and commits the result.

This template ships:

1. A strongly-typed `BppHandler` interface that maps the full Beckn lifecycle onto a single async callback.
2. An idempotent `registerBppAgentCard` helper that submits the on-chain `RegisterAgent` instruction with the BPP's capability tags pinned into `metadata_uri`.
3. A `defaultCredentialGate` that asserts the BAP's AgentCard carries every `RequiredCredential` before the handler is invoked.
4. A `runBpp` runtime loop with a pluggable event source and chain adapter — testable end-to-end without any RPC connection.
5. A worked **echo-bpp** example demonstrating all four extension points.

The template is dev-time tooling. It is NOT published in `dist/` and NOT exported from the `@eto/mcp` package entry; downstream BPPs import it via the relative path `../../keeper/templates/bpp`.

---

## Lifecycle

```
                ┌─────────────────────────────────┐
  Beckn Init ─▶│ runBpp.eventSource (per BPP)   │
                └────────────────┬────────────────┘
                                 ▼
                         ┌──────────────┐
                         │  gate(bap)   │  ← defaultCredentialGate
                         └──┬─────────┬─┘
                  ok=true   │         │  ok=false
                            ▼         ▼
                ┌─────────────────┐  ┌──────────────────────────┐
                │ handler.handle  │  │ chain.failTask(reason)   │
                │ Task(req, ctx)  │  └──────────────────────────┘
                └────────┬────────┘
              success    │   failure / throw / timeout
                         ▼
                ┌─────────────────────────┐
                │ chain.completeTask /    │
                │ chain.failTask(reason)  │
                └─────────────────────────┘
```

`runBpp` swallows per-event errors so a single malformed event cannot tear the loop down — handler throws become `failTask("handler_error: …")`, gate exceptions become `failTask("credential_gate_error: …")`, and a stalled handler is killed by the `handlerTimeoutSec` budget.

---

## Authoring a BPP — four extension points

### 1. `BppConfig`

```ts
const config: BppConfig = {
  name: "code-audit-solidity",        // ≤64 bytes; written into AgentCard.name
  modelId: "claude-sonnet-4",
  authority: "...base58 pubkey...",
  capabilityTags: { /* see below */ },
  requiredBapCredentials: [/* see below */],
  handlerTimeoutSec: 120,             // optional, default 60s
};
```

### 2. `CapabilityTags`

The capability tag JSON is pinned into the AgentCard's `metadata_uri`. When the JSON fits under 256 bytes it is encoded as a `data:application/json;base64,…` URL inline; otherwise `registerBppAgentCard` falls back to an injected `MetadataPinner` (FN-074 will plug in IPFS).

```ts
const tags: CapabilityTags = {
  domain: "code",
  action: "audit:solidity",
  version: "1.0.0",
  price: { amount: "0.05", currency: "ETO" },
  requiredCredentials: [
    { schema: "<sha256 hex>", issuerSet: [], mustBeActive: true },
  ],
  description: "Audits Solidity contracts for OWASP-top-10 issues.",
};
```

### 3. `BppHandler`

```ts
const handler: BppHandler<AuditIn, AuditOut> = {
  async handleTask(req, ctx) {
    ctx.logger.info("audit started", { taskId: req.taskId });
    const findings = await audit(req.input.contract);
    if (findings === null) {
      return { status: "failure", reason: "static_analyzer_unavailable" };
    }
    return { status: "success", output: { findings } };
  },
};
```

The handler is the only piece a BPP author writes from scratch. It must:

- Return within `handlerTimeoutSec` (default 60s) or the runtime cancels with `failTask("handler_timeout: …")`.
- Throw only on truly unexpected errors — all expected failure modes belong in `{ status: "failure", reason }` so the BAP gets a structured reason code.
- Treat `req.input` as untrusted — the runtime does not validate it against any schema beyond `BeckonInitEvent` shape.

### 4. Credential gate

The default gate covers schema/issuer/active-window checks:

```ts
const gate = defaultCredentialGate(config.requiredBapCredentials, {
  loadAgentCard,            // async (bap) => AgentCardSnapshot
  now: () => Math.floor(Date.now() / 1000),
});
```

**FN-074** will swap in a stricter gate that also consults the on-chain revocation oracle and the ZK predicate hash. The contract is unchanged: a `CredentialGate` is `(bapPubkey) => Promise<GateResult>`, so existing BPPs need no source edits.

---

## BAP credential gating with `requireCred`

For anything richer than "schema + issuer set + active window", use the
composable middleware helpers in [`keeper/lib/cred-gate.ts`](../../lib/cred-gate.ts)
(FN-074). `requireCred(schema, predicate?, opts?)` returns a `GateMiddleware`,
and `composeGates(...)` turns a list of middlewares into a `CredentialGate`
ready to plug into `runBpp`'s `deps.gate`.

```ts
import { composeGates, requireCred } from "../../lib/index.js";
import { VERIFIED_HUMAN_SCHEMA_ID } from "../../../src/issuers/worldcoin.js";

const gate = composeGates(
  [requireCred(VERIFIED_HUMAN_SCHEMA_ID)],
  { loadAgentCard, now: () => Math.floor(Date.now() / 1000) },
);
await runBpp(config, handler, { eventSource, chain, gate, logger });
```

Reach for `requireCred` instead of `defaultCredentialGate` when the predicate
is more interesting than schema/issuer (e.g. "verified-human cred whose
nullifier is non-zero", "skill-cert whose attributes include
`code:audit:solidity`"). Mix raw `GateMiddleware` callbacks freely; the
`meta` carried by `requireCred` is what populates `GateResult.missing` for
downstream diagnostics. FN-081 wires this into all five reference BPPs to
require a `verified-human` credential at task pickup.

---

## Wire it together

```ts
import { runBpp, InMemoryEventSource, InMemoryChain, ... } from "../index.js";

const events = new InMemoryEventSource<AuditIn>();
const chain  = new InMemoryChain();           // → real SVM chain in prod (FN-053)

await registerBppAgentCard(config, { chain: registrationChain });
await runBpp(config, handler, { eventSource: events, chain, gate, logger });
```

See [`example/echo-bpp.ts`](./example/echo-bpp.ts) for an end-to-end runnable demo:

```bash
npx tsx eto-mcp/keeper/templates/bpp/example/echo-bpp.ts
```

---

## Downstream wiring TODOs

The following stubs are intentionally provided here and will be replaced by downstream tasks:

| Stub                                  | Replaced by | Notes                                                                 |
|---------------------------------------|-------------|-----------------------------------------------------------------------|
| `InMemoryEventSource`                 | FN-053+     | Real Beckn-program RPC log subscription once `Confirm` event lands.   |
| `InMemoryChain`                       | FN-074      | Real SVM tx submitter for `CompleteTask` / `FailTask`.                |
| `RegistrationChain`                   | FN-074      | Real `RegisterAgent` submitter resolving the AgentCard PDA.           |
| `MetadataPinner`                      | FN-074      | Real IPFS pinning client (currently `InMemoryPinner` for tests).      |
| `defaultCredentialGate`               | FN-074      | Adds revocation-oracle + ZK predicate checks for full on-chain parity.|
| `REGISTER_AGENT_NAME_MAX` / `_URI_MAX`| FN-074      | Verify against the Rust `RegisterAgent` struct once it lands.         |

---

## Reference

- Spec: `spec/SINGULARITY-LAYER-1.md` §5.3–§5.6 (Beckn lifecycle).
- On-chain credential gating: `src/runtime/src/programs/beckn/instructions/init.rs::satisfies_requirement`.
- AgentCard / HeldCredential layout: `src/runtime/src/credential.rs`.
