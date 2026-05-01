# `text:summarize` reference BPP (FN-075)

The first concrete reference Beckn Provider Platform (BPP) composed against
`@eto/mcp/keeper/templates/bpp` (FN-073). It advertises capability
`text:summarize` v1.0.0, accepts a `text` / `url` / `pdfBase64` source,
calls an LLM (Anthropic in production, a fake in tests), and returns a
Markdown `Artifact` whose sha256 is bound over its content.

This BPP is **dev-time tooling**: it is excluded from the published
`@eto/mcp` package (`tsconfig.build.json`) and is run directly by the
keeper process. Sibling reference BPPs (FN-076–079) mirror the directory
layout, handler shape, and test harness defined here.

## Capability tags

```jsonc
{
  "domain": "text",
  "action": "summarize",
  "version": "1.0.0",
  "price": { "amount": "0.10", "currency": "ETO" },
  "requiredCredentials": [],          // FN-081 will add verified-human
  "description": "Summarise an HTML page, PDF, or plain-text input ..."
}
```

## Input

`SummarizeInput` is a discriminated union over the source plus optional
shaping knobs:

```ts
{
  source:
    | { kind: "text"; text: string }                    // ≤ 256 KB utf-8
    | { kind: "url"; url: string; maxBytes?: number }   // ≤ 2048 chars; ≤ 4 MB by default
    | { kind: "pdfBase64"; data: string; filename?: string }, // ≤ 8 MB decoded
  targetLengthWords?: number,   // default 200, max 2000
  style?: "bullets" | "prose"   // default "prose"
}
```

## Output

```ts
{
  artifact: {
    mimeType: "text/markdown",
    content: "<markdown>",
    sha256: "<hex64>",          // sha256(content, utf-8)
    producedAtSec: number,
  },
  sourceBytes: number,
  modelId: string,
}
```

## Failure reasons

The handler never throws; every failure becomes
`{ status: "failure", reason }` with one of the stable codes:

| Reason                            | Meaning                                |
| --------------------------------- | -------------------------------------- |
| `input_invalid: <issues>`         | Schema validation rejected the input   |
| `source_too_large`                | URL response exceeded `maxBytes`       |
| `fetch_failed: <status\|message>` | Network or non-2xx HTTP status         |
| `unsupported_content_type: <ct>`  | URL returned a non-text/non-pdf type   |
| `pdf_extraction_unavailable`      | PDF source but no extractor injected   |
| `empty_source`                    | Decoded source was whitespace-only     |
| `llm_empty_response`              | LLM returned no markdown text          |
| `internal_error: <message>`       | Anything else (logged, fail-safe)      |

## Signed payload

`SigningRuntimeChain` wraps any `RuntimeChain` and signs the canonical
JSON of:

```ts
// completeTask
{ taskId, status: "success", output, producedAtSec }
// failTask
{ taskId, status: "failure", reason, producedAtSec }
```

`canonicalJson(value)` sorts object keys ascending at every level.
Signed envelopes carry `signature` + `signerPubkey` (both hex strings)
and are exposed on `chain.signedComplete` / `chain.signedFail` for
re-derivation by downstream RPC submitters.

## Running the example

```bash
cd eto-mcp
TEXT_SUMMARIZE_FAKE=1 bun run keeper/bpps/text-summarize/main.ts
```

`TEXT_SUMMARIZE_FAKE=1` is the only path supported today (no production
LLM/RPC wiring exists yet — FN-082 / FN-085 will add it). The example
registers the AgentCard, pumps a synthetic `text` event and a synthetic
`url` event through `runBpp`, and prints the signed envelopes recorded
on `InMemoryChain`.

Override the BPP authority:

```bash
TEXT_SUMMARIZE_AUTHORITY=MyAuthorityPubkey... bun run keeper/bpps/text-summarize/main.ts
```

Override the model id (must match an Anthropic model when a real
`AnthropicLlmClient` is wired in):

```bash
KEEPER_MODEL=claude-sonnet-4-6 bun run keeper/bpps/text-summarize/main.ts
```

## Wiring a real Anthropic client

`AnthropicLlmClient` accepts any object structurally matching
`AnthropicLike` (`{ messages: { create(...) } }`). Production code
constructs an `Anthropic` instance from `@anthropic-ai/sdk` reading
`ANTHROPIC_API_KEY` from env and passes it in:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmClient } from "@eto/mcp/keeper/bpps/text-summarize";

const llm = new AnthropicLlmClient(new Anthropic());
```

We do **not** static-import `@anthropic-ai/sdk` from this BPP so the
keeper tree compiles and tests run without the SDK installed. The SDK
becomes a real dependency when `keeper/start.ts` lands.

## TODOs (intentional, tracked separately)

- `TODO(real signer via eto-signing-service)` — replace `makeStubSigner`
  with a FROST threshold-ed25519 client (FN-082 / FN-085).
- `TODO(real RuntimeChain)` — replace `InMemoryChain` with an RPC-backed
  submitter once the on-chain `CompleteTask` / `FailTask` instructions
  land (FN-053 / FN-085).
- `TODO(pdf-parse)` — currently we ship `noopPdfExtractor` which throws
  `pdf_extraction_unavailable`. Pulling `pdf-parse` (or equivalent) was
  rejected at this stage to avoid native-module surface in `keeper/`;
  the extractor is an injected interface, so deploys that need PDF
  support pass a real extractor without changing this BPP.
- `TODO(FN-081)` — add the verified-human `RequiredCredential` to
  `tags.requiredCredentials` once the FN-081 schema is published.

## Test layout

`eto-mcp/tests/unit/text-summarize-bpp.test.ts` covers, in order of the
authoring steps:

1. config + tags + schema parsing edge cases
2. fetcher (text/url/pdf paths, html stripping, size guards, status errors)
3. summariser (default knobs, empty-source rejection, LLM seam)
4. handler (success, schema-failure, oversized-input failure)
5. signing chain (round-trip, deterministic stub signer, canonical JSON)
6. end-to-end via `runBpp` (two successes + one oversized failure)
