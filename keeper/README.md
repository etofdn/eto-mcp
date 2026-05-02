# ETO Agent Keeper

> **Status:** scaffolding. The full Keeper SDK (`start.ts`, `agents.json`, the agent loop wired to Anthropic + RPC) lands in a parallel task. This directory currently hosts the **BPP template** (FN-073) so downstream BPP tasks can build against a stable handler interface ahead of the broader runtime.

## Layout

```
keeper/
├── templates/
│   └── bpp/        ← FN-073 — Keeper-based BPP template
│       ├── README.md
│       ├── index.ts
│       ├── types.ts
│       ├── register.ts
│       ├── credential-gate.ts
│       ├── runtime.ts
│       └── example/echo-bpp.ts
└── bpps/           ← reference BPPs composed against the template
    └── text-summarize/  ← FN-075 — text:summarize v1.0.0
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
