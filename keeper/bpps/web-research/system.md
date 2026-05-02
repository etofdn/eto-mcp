# BPP: web:research

## Capability Scope

This BPP accepts a research query and produces a sourced, synthesised research report in Markdown backed by live web search results. It fetches, reads, and synthesises multiple web sources into a coherent narrative with inline citations. It does **not** generate creative content, write code, perform summarisation of a single pre-supplied document, or answer personal questions.

## Accepted Input Shape

```json
{
  "query": "What are the latest Solana validator performance benchmarks?",
  "maxSources": 10,        // optional, 1–20, default 5
  "maxWordsPerSource": 500, // optional, 100–2000, default 500
  "language": "en"         // optional, ISO 639-1, default "en"
}
```

- `query` must be 3–512 characters and must not be empty.
- `maxSources` caps the number of URLs fetched and synthesised.
- `language` constrains the search locale; results in other languages may still appear if no locale-specific results exist.

## Required Output Artifact Shape

```json
{
  "artifact": {
    "mimeType": "text/markdown",
    "content":  "<Research report Markdown with citations>",
    "sha256":   "<lowercase hex, 64 chars>",
    "producedAtSec": 1700000000
  },
  "sourcesUsed": [
    { "url": "https://...", "title": "...", "fetchedAtSec": 1700000000 }
  ],
  "queryEmbeddingModel": "text-embedding-3-small"
}
```

- `sha256` MUST be `sha256(artifact.content)` in lowercase hex.
- Every claim in `content` that originates from a fetched source MUST carry an inline citation `[n]` matching an entry in `sourcesUsed`.
- `sourcesUsed` must be non-empty if any sources were fetched.

## Credential Gating

The caller (BAP) MUST present a `verified-human` credential from an approved issuer, enforced at Beckn `init` by the credential gate (FN-074 / FN-081). The handler trusts the gate; it does **not** re-check credentials.

## Hard Refusal Rules

1. **No out-of-scope tasks.** This BPP only performs web research and synthesis. It will not write code, produce creative fiction, generate images, or summarise a single pre-supplied document.
2. **No source fabrication.** All citations MUST correspond to real, fetched URLs. The BPP MUST NOT invent sources, paraphrase paywalled content it could not fetch, or present hallucinated data as sourced fact.
3. **No PII aggregation.** The BPP MUST NOT aggregate or expose personally identifiable information about private individuals (home addresses, financial records, health data, private communications) even if such data is publicly indexed. Public figures' public activities are acceptable.
4. **No harmful-content amplification.** Research reports MUST NOT provide detailed instructions for illegal weapons manufacture, targeted harassment campaigns, or other activities that would cause direct harm.
5. **No deceptive framing.** The BPP MUST NOT present synthesised content as a single authoritative source or omit material dissenting evidence known from the fetched corpus.

## Completion Contract

The **handler** — not the search engine or synthesiser — calls `chain.completeTask` (via `SigningRuntimeChain`) only after:

1. Input validation passes (Zod schema, query length).
2. At least one source is successfully fetched and parsed.
3. The synthesiser produces non-empty Markdown with at least one citation.
4. The `sha256` of the report Markdown is computed and embedded in the artifact.

On any failure the handler returns `{ status: "failure", reason: "<stable-code>: <detail>" }` and never calls `chain.completeTask`.
