# BPP: code:audit:solidity

## Capability Scope

This BPP accepts Solidity smart-contract source code and produces a structured security audit report. It identifies known vulnerability classes (re-entrancy, integer overflow/underflow, access-control flaws, gas-griefing vectors, unchecked external calls, etc.) and outputs severity-ranked findings in Markdown. It does **not** fix code, write new contracts, perform economic modelling, or audit non-Solidity languages.

## Accepted Input Shape

```json
{
  "source": {
    "kind": "inline" | "url",
    "code":  "// SPDX-License-Identifier: MIT\n...",  // when kind = "inline"
    "url":   "https://...",                            // when kind = "url"
    "maxBytes": 131072                                 // optional, default 131 072
  },
  "compilerVersion": "0.8.20",   // optional; used to filter version-specific checks
  "checkers": ["slither", "mythril", "llm"]  // optional; default all available
}
```

- Maximum source bytes: 131 072.
- URL must return a `text/plain` or `application/octet-stream` response.
- `compilerVersion` must be a valid semver if provided (e.g., `"0.8.20"`).

## Required Output Artifact Shape

```json
{
  "artifact": {
    "mimeType": "text/markdown",
    "content":  "<Audit report Markdown>",
    "sha256":   "<lowercase hex, 64 chars>",
    "producedAtSec": 1700000000
  },
  "findingsCount": {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
    "informational": 5
  },
  "checkersUsed": ["slither", "llm"]
}
```

- `sha256` MUST be `sha256(artifact.content)` in lowercase hex.
- `findingsCount` MUST reflect the actual counts of severity-labelled findings in `content`.

## Credential Gating

The caller (BAP) MUST present a `verified-human` credential from an approved issuer. This is enforced by the credential gate at Beckn `init` (FN-074 / FN-081). Additionally, for production deployments the BPP itself holds a `skill.solidity-audit/v1` self-asserted credential that the Beckn network can verify against the allowed issuer set. The handler trusts the credential gate and does **not** re-validate credentials internally.

## Hard Refusal Rules

1. **No out-of-scope languages.** Only Solidity source is accepted. Requests containing Rust, Vyper, Move, C++, or other languages are rejected with `unsupported_language`.
2. **No exploit weaponisation.** The audit report MUST describe vulnerabilities in defensive terms (how to fix, severity, CWE reference). It MUST NOT include ready-to-use exploit scripts, private-key extraction sequences, or attack payloads that can be directly deployed against a live contract.
3. **No proprietary-code exfiltration.** If the source URL refers to a private repository or the code contains proprietary markers, the BPP processes the audit but does NOT echo the full source back in the report. Only relevant code snippets (≤ 20 lines) may appear in findings.
4. **No fabricated findings.** All findings MUST be traceable to a specific line range in the submitted source. The BPP MUST NOT invent vulnerabilities.
5. **No execution of submitted code.** The BPP performs static analysis only; it never deploys or executes the submitted contract.

## Completion Contract

The **handler** — not the audit engine — calls `chain.completeTask` (via `SigningRuntimeChain`) only after:

1. Input validation passes (Zod schema, compiler-version check).
2. Source fetch/decode succeeds.
3. At least one checker completes and returns a findings list (empty findings list is valid).
4. The report Markdown is assembled and its `sha256` computed.

On any failure the handler returns `{ status: "failure", reason: "<stable-code>: <detail>" }` and never calls `chain.completeTask`.
