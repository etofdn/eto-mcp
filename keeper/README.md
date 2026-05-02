# ETO Agent Keeper

> **Status:** scaffolding. The full Keeper SDK (`start.ts`, `agents.json`, the agent loop wired to Anthropic + RPC) lands in a parallel task. This directory currently hosts the **BPP template** (FN-073) so downstream BPP tasks can build against a stable handler interface ahead of the broader runtime.

## Layout

```
keeper/
├── templates/
│   └── bpp/              ← FN-073 — Keeper-based BPP template
│       ├── README.md
│       ├── index.ts
│       ├── types.ts
│       ├── register.ts
│       ├── credential-gate.ts
│       ├── runtime.ts
│       └── example/echo-bpp.ts
└── bpps/                 ← reference BPPs (FN-075..079)
    ├── text-summarize/   ← FN-075 — text:summarize v1.0.0
    ├── code-audit-solidity/ ← FN-076 — code:audit:solidity v1.0.0
    ├── web-research/     ← FN-077 — web:research v1.0.0
    ├── image-generate/   ← FN-078 — image:generate v1.0.0
    ├── data-analyze/     ← FN-079 — data:analyze v1.0.0
    └── __tests__/        ← FN-080 — cross-BPP handler + signing tests
```

## BPP Template

A reusable TypeScript library for authoring **Beckn Provider Platforms** on top of the ETO Agent Keeper. Provides:

- `BppHandler` — single-callback abstraction over the Beckn `select → init → confirm → status` lifecycle.
- `registerBppAgentCard` — idempotent on-chain `RegisterAgent` submission with capability tags pinned into `metadata_uri`.
- `defaultCredentialGate` — asserts the BAP carries every `RequiredCredential` before the handler runs.
- `runBpp` — keeper-style loop with pluggable event source and chain adapter; testable end-to-end without RPC.

See [`templates/bpp/README.md`](./templates/bpp/README.md) for the author's guide and [`templates/bpp/example/echo-bpp.ts`](./templates/bpp/example/echo-bpp.ts) for a runnable end-to-end demo.

## Reference BPPs

Concrete BPPs that compose the template; each is dev-time tooling and is
excluded from the published `dist/`.

- [`bpps/text-summarize/`](./bpps/text-summarize/README.md) — FN-075,
  capability `text:summarize` v1.0.0. Canonical pattern for the four
  sibling reference BPPs (FN-076 `code:audit:solidity`, FN-077
  `web:research`, FN-078 `image:generate`, FN-079 `data:analyze`).
- [`bpps/code-audit-solidity/`](./bpps/code-audit-solidity/README.md) — FN-076,
  capability `code:audit:solidity` v1.0.0. Wraps `slither`/`mythril`
  when available + LLM auditor; runs a self-asserted
  `skill.solidity-audit/v1` credential preflight.
- [`bpps/web-research/`](./bpps/web-research/README.md) — FN-077,
  capability `web:research` v1.0.0. Plans sub-queries, fans out across
  an injected `SearchProvider`, fetches and extracts top sources, and
  synthesises a sourced Markdown report with a typed `Citation[]`.
- [`bpps/image-generate/`](./bpps/image-generate/README.md) — FN-078,
  capability `image:generate` v1.0.0. Wraps Replicate / Together /
  Stability behind a single `ImageProvider` seam, pins the resulting
  image bytes to IPFS (web3.storage / Pinata), and returns the
  `ipfs://CID` URI as a signed `Artifact`.
- [`bpps/data-analyze/`](./bpps/data-analyze/README.md) — FN-079,
  capability `data:analyze` v1.0.0. Ingests CSV/TSV (URL, inline
  text, or base64 blob), profiles columns + computes summary
  statistics + flags anomalies locally, then asks an LLM to narrate
  findings + suggested questions over the profile + a bounded
  sample (full rows never leave the keeper).

## Bank BPP (FN-096)

The **bank BPP** extends the reference-BPP pattern with a **multi-capability catalogue**
(five Beckn capabilities in one AgentCard) and a two-tier registration design.

- [`bpps/bank/`](./bpps/bank/README.md) — FN-096, bank BPP scaffold with five capability
  stubs (`bank.checking`, `bank.savings`, `bank.fiat-ramp`, `bank.card`, `bank.wire`),
  a signed `BankCatalog` + `CatalogCommitPayload` publisher, required-credential policy
  (FN-099), and a mock USD ledger (FN-110).

## Per-BPP System Prompts and Handler Finaliser (FN-080)

Each reference BPP has a capability-specific **system prompt** (`system.md`) and a
handler that finalises the on-chain task via the shared `SigningRuntimeChain` template
helper. The handler calls `chain.completeTask` only after the artifact is produced and
validated; failures are routed to `chain.failTask` without ever touching `completeTask`.

| Capability | system.md | Handler finaliser |
|---|---|---|
| `text:summarize` | [`bpps/text-summarize/system.md`](./bpps/text-summarize/system.md) | `SigningRuntimeChain` via `createTextSummarizeHandler` |
| `code:audit:solidity` | [`bpps/code-audit-solidity/system.md`](./bpps/code-audit-solidity/system.md) | `SigningRuntimeChain` via `createSolidityAuditHandler` |
| `web:research` | [`bpps/web-research/system.md`](./bpps/web-research/system.md) | `SigningRuntimeChain` via `createWebResearchHandler` |
| `image:generate` | [`bpps/image-generate/system.md`](./bpps/image-generate/system.md) | `SigningRuntimeChain` via `createImageGenerateHandler` |
| `data:analyze` | [`bpps/data-analyze/system.md`](./bpps/data-analyze/system.md) | `SigningRuntimeChain` via `createDataAnalyzeHandler` |

All handlers route through the **template helper** (`SigningRuntimeChain` from
`eto-mcp/keeper/bpps/<name>/chain-adapter.ts`, re-exporting the canonical implementation
from `text-summarize/chain-adapter.ts`). This keeps the canonical-JSON signing payload
schema — `{ taskId, status, output|reason, producedAtSec }` — in one place.

Cross-BPP correctness (system.md headers, success/failure chain-call invariants,
signing determinism) is validated in
[`bpps/__tests__/handler.complete-task.test.ts`](./bpps/__tests__/handler.complete-task.test.ts).

## BPP end-to-end tests

> **Suite:** [`tests/bpps/e2e.test.ts`](../tests/bpps/e2e.test.ts) (FN-082, T-2.7.3.3)

Exercises **each of the five reference BPPs** through one complete Beckn round-trip:
`credential gate → handler.handleTask → chain.completeTask`

### How to run

**In-memory mode (CI default — no network, no testnet)**
```bash
cd eto-mcp
npm test
# or run just the e2e suite:
npm test -- tests/bpps/e2e.test.ts
```

This mode always runs and is hermetic: BPP handlers are instantiated with
stub dependencies (no LLM calls, no IPFS pinning), and `InMemoryChain` /
`InMemoryEventSource` replace on-chain calls.

**Testnet mode — requires `mesh/start.sh` already running**
```bash
# In one terminal:
cd eto-mcp/mesh && bash start.sh   # starts validator at http://localhost:8899

# In another terminal:
ETO_E2E=1 npm test -- tests/bpps/e2e.test.ts
```

Set `ETO_RPC_URL` to override the default `http://localhost:8899`.
When `ETO_E2E=1` and the RPC is unreachable the suite skips gracefully.

> **Note:** full on-chain `CompleteTask` tx assertion (5-account ordering
> `auth, task, escrow, receiver_wallet, receiver_card`) is pending
> FN-073's real-RPC chain adapter. See `TODO(FN-073)` in `harness.ts`.

### Test matrix

| BPP | Capability | Positive (gate pass → complete) | Negative (no cred → fail) |
|---|---|---|---|
| `text-summarize` | `text:summarize` | ✅ | ✅ |
| `code-audit-solidity` | `code:audit:solidity` | ✅ | (shared negative case) |
| `web-research` | `web:research` | ✅ | |
| `image-generate` | `image:generate` | ✅ | |
| `data-analyze` | `data:analyze` | ✅ | |

The negative case (`bapCardWithoutVerifiedHuman`) is a shared test applied
to `text-summarize`; it verifies `chain.failed[0].reason` matches
`/^credential_gate_denied: missing 1 /` and contains the schema hash
prefix — proving FN-081 gating is wired correctly.

A de-duplication idempotency test is marked `.todo` pending FN-073
de-dup support.
