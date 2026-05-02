# `web:research` BPP (FN-077)

A reference Beckn Provider Platform that runs a **structured multi-step
web search** over a research question and returns a sourced Markdown
report. Composed against the FN-073 BPP template; mirrors the FN-075
(`text:summarize`) layout.

```
keeper/bpps/web-research/
├── config.ts          — capability tags + BppConfig
├── types.ts           — ResearchInput / Citation / ResearchOutput + Zod
├── search-provider.ts — SearchProvider seam + FakeSearchProvider + HttpSearchProvider scaffold
├── fetcher.ts         — fetchPage(url) with SSRF guard + 1 MB cap
├── planner.ts         — LlmClient seam + Anthropic adapter + planQueries
├── synthesizer.ts     — synthesize(query, evidence) → Markdown + Citations
├── handler.ts         — orchestrates planner → search → fetch → synthesize
├── chain-adapter.ts   — re-exports SigningRuntimeChain from FN-075
├── index.ts           — public barrel
├── main.ts            — runnable entrypoint (fake mode)
└── README.md          — this file
```

## Capability tags

```jsonc
{
  "domain": "web",
  "action": "research",
  "version": "1.0.0",
  "price": { "amount": "0.50", "currency": "ETO" },
  "requiredCredentials": [],     // TODO(FN-081): verified-human
  "description": "Run a structured multi-step web search for a research question…"
}
```

## Sample IO

### Input (`ResearchInput`)

```jsonc
{
  "query": "ed25519 vs secp256k1",
  "depth": "standard",            // "shallow" | "standard" | "deep"
  "maxSources": 8,                // hard cap = 20
  "recencyDays": 365,             // 0 = no bias
  "allowedDomains": ["wikipedia.org", "https://crypto.example.net"],
  "blockedDomains": ["evil.example"],
  "targetLengthWords": 600        // hard cap = 4000
}
```

### Output (`ResearchOutput`)

```jsonc
{
  "artifact": {
    "mimeType": "text/markdown",
    "content": "# Ed25519 vs secp256k1\n\n## Executive Summary\n…",
    "sha256": "ba9d10fbeacc0cc8e358d05ef4f202ebf0466d44db54468163851977669166d1",
    "producedAtSec": 1700000600
  },
  "citations": [
    {
      "url": "https://crypto.example.net/ed25519",
      "title": "Ed25519 signatures",
      "publisher": "crypto.example.net",
      "publishedAtSec": 1685000000,
      "accessedAtSec": 1700000400,
      "snippetSha256": "…64-hex…"
    }
  ],
  "query": "ed25519 vs secp256k1",
  "subQueries": ["ed25519 vs secp256k1", "ed25519 overview", "secp256k1 overview"],
  "modelId": "claude-sonnet-4-6",
  "sourceCount": 5
}
```

## Pipeline

```
Init event
  → zResearchInput.safeParse
  → planQueries(query, opts)         (Anthropic JSON-mode style)
  → for each subQuery: search.search()
  → dedupe + allow/block filter + maxSources cap
  → fetchPage(url) × concurrency=4   (SSRF-guarded)
  → synthesize(query, evidence)      (Anthropic; each extract truncated to 2 KB)
  → Markdown + Citation[] → ResearchOutput
  → SigningRuntimeChain.completeTask
```

Stable failure codes (routed via `chain.failTask`):

| Code | Cause |
|------|-------|
| `empty_query` | Query was empty/whitespace |
| `input_too_large` | Query above 1024-char hard cap |
| `input_invalid: …` | Other Zod validation failures |
| `search_provider_not_configured` | Real-mode provider lacks env wiring |
| `no_sources_found` | Zero usable sources after fetch / filtering |
| `synthesis_failed: …` | Synthesizer threw |
| `handler_error: …` | Anything else |

## Run it

```sh
# Fake mode (default for the worked example) — no network, no API keys.
WEB_RESEARCH_FAKE=1 bun run keeper/bpps/web-research/main.ts

# Equivalent with tsx:
WEB_RESEARCH_FAKE=1 npx tsx keeper/bpps/web-research/main.ts
```

Expected output (abridged):

```
[info]  registered AgentCard {"pda":"WebResearchCardPda","idempotent":false}
[info]  task completed {"taskId":"t-solana"}
[info]  task completed {"taskId":"t-eddsa"}
[info]  signed envelopes {"complete":2,"fail":0}
```

## Search-provider plug-in guide

The handler talks to the `SearchProvider` interface only. Two
implementations ship today:

- **`FakeSearchProvider`** — deterministic in-memory corpus keyed by
  query substring. Used by tests and `WEB_RESEARCH_FAKE=1`.
- **`HttpSearchProvider`** — scaffold for the planned real adapters.
  Selects a provider via env and **throws
  `search_provider_not_configured`** until the adapter is wired:

  | Env | Purpose |
  |-----|---------|
  | `WEB_RESEARCH_PROVIDER` | `tavily` \| `brave` \| `serpapi` |
  | `WEB_RESEARCH_API_KEY` | provider API key |

  Implementing one is straightforward — pass `globalThis.fetch`, map
  the request shape per provider docs, and translate the response into
  `SearchHit[]`. See the `TODO(real-search-provider)` markers in
  `search-provider.ts`.

## Canonical signing payload

`SigningRuntimeChain` (re-exported from FN-075's `text-summarize`)
canonical-JSON-serialises and signs:

```jsonc
// CompleteTask
{ "producedAtSec": 1700000600, "status": "success", "taskId": "…", "output": <ResearchOutput> }

// FailTask
{ "producedAtSec": 1700000600, "status": "failure", "taskId": "…", "reason": "no_sources_found" }
```

Object keys are sorted ascending at every level so the signed bytes
verify across keeper processes.

## TODOs

- **Real RPC chain (FN-082):** `RuntimeChain` is currently
  `InMemoryChain`; FN-082 will plug in a real submitter for the
  on-chain `CompleteTask` / `FailTask` instructions.
- **Real FROST signer:** `makeStubSigner` is a deterministic stub.
  Production will inject a client over `eto-mcp/signing-service`.
- **Real search-provider adapter:** `HttpSearchProvider` is a scaffold.
  Implement Tavily / Brave / SerpAPI adapters in a follow-up task.
- **FN-081 verified-human credential:** `tags.requiredCredentials` is
  empty; once the verified-human credential schema lands, populate it
  so the BPP rejects anonymous BAPs at Beckn `init`.
