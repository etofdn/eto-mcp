# `data:analyze` reference BPP (FN-079)

The fifth and final reference Beckn Provider Platform (BPP) composed
against `@eto/mcp/keeper/templates/bpp` (FN-073). It advertises
capability `data:analyze` v1.0.0, accepts a CSV / TSV input (URL,
inline `text`, or base64 blob), profiles the columns, calls an LLM
(Anthropic in production, a fake in tests) over the **profile + a
bounded sample**, and returns a Markdown `Artifact` whose sha256 is
bound over its content.

This BPP is **dev-time tooling**: it is excluded from the published
`@eto/mcp` package (the `tsconfig.build.json` only includes `src/`)
and is run directly by the keeper process. It mirrors the FN-075
(`text:summarize`) layout 1:1 — file names, dependency-injection
seams, signing-chain shape, and test harness — so FN-080 / FN-082 /
FN-085 can iterate over the five reference BPPs uniformly.

## Capability tags

```jsonc
{
  "domain": "data",
  "action": "analyze",
  "version": "1.0.0",
  "price": { "amount": "0.25", "currency": "ETO" },
  "requiredCredentials": [],          // FN-081 will add verified-human
  "description": "Analyse a CSV/TSV dataset (URL, inline text, or base64 blob): infer column types, compute summary statistics, surface anomalies, and synthesise a Markdown report with findings and suggested follow-up questions."
}
```

## Input

`AnalyzeInput` is a discriminated union over the source plus optional
shaping knobs:

```ts
{
  source:
    | { kind: "csv"; text: string }                          // ≤ 8 MB utf-8
    | { kind: "url"; url: string; maxBytes?: number }        // ≤ 2048 chars; ≤ 16 MB by default
    | { kind: "csvBase64"; data: string; filename?: string }, // ≤ 32 MB decoded
  delimiter?: "," | ";" | "\t" | "auto",   // default "auto"
  hasHeader?: boolean,                     // default true
  maxRows?: number,                        // default 100_000, hard cap 500_000
  question?: string                        // ≤ 1024 chars; populates report.answer
}
```

### Sample input

```json
{
  "source": { "kind": "csv", "text": "name,age,score\nAlice,30,95.5\nBob,42,80.0\n" },
  "question": "Who has the highest score?"
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
  profile: DatasetProfile,      // rowCount, columnCount, per-column stats, delimiter
  report: AnalysisReport,       // summary, findings[], anomalies[], suggestedQuestions[], answer?
  sourceBytes: number,
  modelId: string,
}
```

The Markdown artifact has the canonical layout:

```
# Data Analysis Report

## Summary
…2–4 sentence overview…

## Findings
- …

## Anomalies
- …

## Suggested Questions
- …

## Answer        ← only when `input.question` is set
…≤200 words…
```

## Failure reasons

The handler never throws; every failure becomes
`{ status: "failure", reason }` with one of the stable codes:

| Reason                            | Meaning                                |
| --------------------------------- | -------------------------------------- |
| `input_invalid: <issues>`         | Schema validation rejected the input   |
| `input_too_large: <…>`            | base64 decoding rejected (invalid b64) |
| `source_too_large`                | URL response exceeded `maxBytes`       |
| `fetch_failed: <status\|message>` | Network or non-2xx HTTP status         |
| `unsupported_content_type: <ct>`  | URL returned a non-CSV/text type       |
| `encoding_unsupported`            | Source bytes are not valid UTF-8       |
| `empty_dataset`                   | CSV parsed to 0 rows or 0 columns      |
| `llm_invalid_response`            | LLM returned malformed JSON / fields   |
| `handler_internal_error: <msg>`   | Anything else (logged, fail-safe)      |

## Profiling heuristics

Per-column statistics computed locally (no LLM cost):
- **Type inference** (most → least specific): `boolean` (`true|false|0|1`),
  `integer`, `number`, `date` (ISO 8601), `string`. A column with
  partial numeric coverage is marked `mixed`.
- **Numeric stats**: `min`, `max`, `mean`, `stddev` (Welford).
- **Categorical stats**: `topValues` (top 5 by count) only when
  `distinctCount ≤ 50` to bound output size.
- **Distinct enumeration**: capped at 10 000 values per column.

Anomaly flags surfaced into `report.anomalies`:
- **highNullRate** — null rate > 30 %.
- **constant** — single distinct value across ≥ 2 rows.
- **allDistinct** — every non-null value distinct (likely an id).
- **monotonic** — sorted ascending or descending (likely a row index).
- **outlierHeavy** — > 5 % of values lie outside `[Q1−1.5·IQR, Q3+1.5·IQR]`.

## Privacy guardrail

The LLM only ever sees the structured `DatasetProfile` plus a bounded
`sample` (first 20 rows + up to 20 uniform-random rows from the
remainder, each cell capped at 256 chars). The full CSV body never
crosses the network — callers can submit datasets that exceed the
model's context window and the BPP will still produce a meaningful
narrative.

## Signed payload

`SigningRuntimeChain` is **re-exported verbatim from
`bpps/text-summarize/chain-adapter.js`** (per the FN-079 "import-don't-
fork" rule). The signed-byte schema is:

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
DATA_ANALYZE_FAKE=1 bun run keeper/bpps/data-analyze/main.ts
```

`DATA_ANALYZE_FAKE=1` is the only path supported today (no production
LLM/RPC wiring exists yet — FN-082 / FN-085 will add it). The example
registers the AgentCard, pumps a synthetic `csv` event, a synthetic
`url` event, and an oversized failure event through `runBpp`, and
prints the signed envelopes recorded on `InMemoryChain`.

Override the BPP authority:

```bash
DATA_ANALYZE_AUTHORITY=MyAuthorityPubkey... bun run keeper/bpps/data-analyze/main.ts
```

Override the model id (must match an Anthropic model when a real
`AnthropicLlmClient` is wired in):

```bash
KEEPER_MODEL=claude-sonnet-4-6 bun run keeper/bpps/data-analyze/main.ts
```

## Wiring a real Anthropic client

`AnthropicLlmClient` accepts any object structurally matching
`AnthropicLike` (`{ messages: { create(...) } }`). Production code
constructs an `Anthropic` instance from `@anthropic-ai/sdk` reading
`ANTHROPIC_API_KEY` from env and passes it in:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmClient } from "@eto/mcp/keeper/bpps/data-analyze";

const llm = new AnthropicLlmClient(new Anthropic());
```

We do **not** static-import `@anthropic-ai/sdk` from this BPP so the
keeper tree compiles and tests run without the SDK installed. The SDK
becomes a real dependency when `keeper/start.ts` lands.

## CSV parser

This BPP ships a hand-rolled RFC 4180 parser (~150 LOC, in
`profiler.ts`). It handles quoted fields with embedded commas and
newlines, escaped `""` inside quoted fields, CRLF + LF line endings,
and a configurable single-character delimiter. **No new runtime
dependency was added** — the parser is unit-tested directly and the
profiler tests exercise standard CSV, TSV, and edge cases (quoted
embedded delimiters, escaped quotes, CRLF terminators). If a future
need arises (UTF-16, malformed quoting, multi-char delimiters),
swap in `papaparse` or `csv-parse` and update this section.

## TODOs (intentional, tracked separately)

- `TODO(real signer via eto-signing-service)` — `makeStubSigner`
  is a sha256-based deterministic mock; replace with a FROST
  threshold-ed25519 client (FN-082 / FN-085).
- `TODO(real RuntimeChain)` — replace `InMemoryChain` with an RPC-
  backed submitter once on-chain `CompleteTask` / `FailTask`
  instructions land (FN-053 / FN-085).
- `TODO(FN-081)` — add the verified-human `RequiredCredential` to
  `tags.requiredCredentials` once the FN-081 schema is published.
- `TODO(richer formats)` — Excel / Parquet / JSON-tabular ingestion
  is explicitly out of scope. CSV/TSV only.

## Test layout

`eto-mcp/tests/unit/data-analyze-bpp.test.ts` covers, in order of
the authoring steps:

1. config + tags + schema parsing edge cases
2. fetcher (csv/csvBase64/url paths, size guards, status errors,
   utf-8 validation, content-type filtering)
3. RFC 4180 parser (quoted fields, escaped quotes, embedded
   newlines, CRLF) + delimiter auto-detect
4. profiler (type inference across boolean/int/number/date/string;
   numeric stats; null counting; truncation; anomaly flags;
   deterministic sampling)
5. analyzer (model-id + question forwarding; markdown rendering;
   empty-dataset rejection; LLM-malformed-response handling;
   profiler-flag merging)
6. signing chain re-export (round-trip, deterministic stub signer,
   canonical JSON)
7. handler (success, schema-failure, fetcher-throw, empty dataset)
8. end-to-end via `runBpp` (two successes + one oversized failure;
   signed envelopes present; sha256 binding holds)
