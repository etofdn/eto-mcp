# BPP: data:analyze

## Capability Scope

This BPP accepts a CSV data source (URL or base64-encoded inline) and an analysis specification, runs statistical profiling and optional chart generation, and produces a structured Markdown analysis report. It does **not** train ML models, write database queries, modify data, or perform real-time streaming analytics.

## Accepted Input Shape

```json
{
  "source": {
    "kind": "url" | "base64",
    "url":    "https://example.com/data.csv",  // when kind = "url"
    "base64": "...",                            // when kind = "base64"
    "maxBytes": 10485760                        // optional, default 10 485 760 (10 MiB)
  },
  "columns": ["price", "volume", "date"],  // optional; analyse all if omitted
  "analyses": ["describe", "correlate", "trend", "outliers"],  // optional; default ["describe"]
  "outputFormat": "markdown" | "json",  // optional, default "markdown"
  "maxRows": 50000  // optional, default 50 000
}
```

- Maximum source bytes: 10 485 760 (10 MiB).
- CSV must be UTF-8 encoded with a header row.
- `analyses` entries must be from the known set: `describe`, `correlate`, `trend`, `outliers`, `histogram`. Unknown values are rejected with `unknown_analysis`.
- `maxRows` caps the rows processed; excess rows are truncated with a warning in the report.

## Required Output Artifact Shape

```json
{
  "artifact": {
    "mimeType": "text/markdown",
    "content":  "<Analysis report Markdown>",
    "sha256":   "<lowercase hex, 64 chars>",
    "producedAtSec": 1700000000
  },
  "rowsProcessed": 1234,
  "columnsAnalysed": ["price", "volume"],
  "analysesRun": ["describe", "correlate"]
}
```

- `sha256` MUST be `sha256(artifact.content)` in lowercase hex.
- `rowsProcessed` MUST reflect the actual number of data rows analysed (excluding the header and any truncated rows).
- `columnsAnalysed` MUST list the columns actually present in the CSV that were included in the analyses.

## Credential Gating

The caller (BAP) MUST present a `verified-human` credential from an approved issuer, enforced at Beckn `init` by the credential gate (FN-074 / FN-081). The handler trusts the gate and does **not** re-check credentials internally.

## Hard Refusal Rules

1. **No out-of-scope analyses.** This BPP only performs statistical profiling on tabular CSV data. It will not run ML training, execute arbitrary code embedded in the CSV, connect to external databases, or perform joins across multiple datasets.
2. **No proprietary-data exfiltration.** The BPP MUST NOT include raw data rows in the output report beyond minimal illustrative examples (≤ 5 rows). It MUST NOT log or cache the submitted data beyond the lifetime of the single request.
3. **No PII exposure.** If columns are detected to contain personal identifiers (e.g., email addresses, SSNs, phone numbers, IP addresses), those columns are excluded from descriptive statistics and a warning is appended to the report. The BPP MUST NOT echo PII values.
4. **No execution of embedded scripts.** If the CSV contains formula strings (e.g., cells starting with `=`, `+`, `-`, `@`) that could be interpreted as spreadsheet formulas, those cells are sanitised before processing.
5. **No fabricated statistics.** All reported statistics (mean, median, correlation coefficients, trend slopes) MUST be computed from the actual submitted data. Approximations are acceptable but must be labelled as such.

## Completion Contract

The **handler** — not the analyser engine — calls `chain.completeTask` (via `SigningRuntimeChain`) only after:

1. Input validation passes (Zod schema, source-size check, analysis-list validation).
2. Source fetch/decode succeeds and CSV parsing produces at least one data row.
3. All requested analyses complete (partial completion is still a success if all partial results are included in the report with warnings).
4. The report Markdown is assembled and its `sha256` computed.

On any failure the handler returns `{ status: "failure", reason: "<stable-code>: <detail>" }` and never calls `chain.completeTask`.
