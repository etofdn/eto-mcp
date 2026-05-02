# `code:audit:solidity` reference BPP (FN-076)

Second concrete reference Beckn Provider Platform composed against
`@eto/mcp/keeper/templates/bpp` (FN-073). Mirrors the FN-075
`text:summarize` directory layout and signing-chain wrapper exactly so
sibling BPPs (FN-077–079) keep copying the pattern.

This BPP advertises capability `code:audit:solidity` v1.0.0, accepts
one or more Solidity sources (inline / url / base64), runs a static-
tool auditor (`slither` / `mythril`) when available, ALWAYS runs an
LLM auditor for narrative + severity ranking, and returns a Markdown
audit report whose `sha256` is bound over its content.

It is **dev-time tooling**: the `keeper/` tree is excluded from the
published `dist/` (see `tsconfig.build.json`).

## Capability tags

```jsonc
{
  "domain": "code",
  "action": "audit:solidity",
  "version": "1.0.0",
  "price": { "amount": "1.00", "currency": "ETO" },
  "requiredCredentials": [],          // FN-081 will add verified-human
  "description": "Audit one or more Solidity source files ..."
}
```

## Self-asserted skill credential

The BPP's startup sequence requires its OWN `AgentCard` to hold a
`skill.solidity-audit/v1` credential issued by an issuer in
`config.selfCredentialIssuerSet`. We derive the on-chain schema bytes
via `schemaIdForSkill("solidity-audit")` from
`@eto/mcp/issuers/skill-cert` (the FN-041 issuer module).

If the credential is missing, `assertSelfSkillCredential` throws
`MissingSelfCredentialError` whose `detail.remediation` field points
at the FN-041 admin endpoint:

```bash
curl -X POST http://localhost:8080/issuers/skill-cert/issue \
  -H "Authorization: Bearer $SKILL_CERT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subject":  "<BPP authority pubkey>",
    "skill":    "solidity-audit",
    "validFrom": 0,
    "validUntil": 0
  }'
```

The issuer must be present on the FN-041 whitelist for that skill, and
the BPP authority must be present on the FN-041 admin whitelist (the
"self-issued capability" pattern).

> Out of scope: this BPP does NOT auto-issue at startup. Operators
> issue the credential once during onboarding; on-card lookup uses
> the injected `AgentCardLoader`. A real RPC-backed loader is a
> TODO (see below).

## Input

`AuditInput` is a tagged union over three source kinds plus optional
shaping:

```ts
type AuditInput =
  | { kind: "inline"; files: { path: string; content: string }[]; ... }
  | { kind: "url";    url: string; maxBytes?: number;            ... }
  | { kind: "base64"; data: string; filename: string;            ... }
```

with shared knobs:

```ts
{
  solcVersion?: string,        // semver, advisory only
  severityFloor?: "info" | "low" | "medium" | "high" | "critical"
                               // default "low"
}
```

### Limits

| Source     | Per-file | Total       | Files          | URL chars |
| ---------- | -------- | ----------- | -------------- | --------- |
| `inline`   | 256 KB   | 2 MB        | ≤ 32           | —         |
| `url`      | —        | ≤ 2 MB      | exactly 1      | ≤ 2048    |
| `base64`   | 256 KB   | 256 KB      | exactly 1      | —         |

`url` content-type must be `text/plain`, `text/x-solidity`, or
`application/octet-stream`. Archive expansion (zip/tar.gz) is OUT OF
SCOPE — the loader resolves to exactly one file per `url`/`base64`
input.

## Output

```ts
{
  artifact: {
    mimeType: "text/markdown",
    content: "<markdown>",
    sha256: "<hex64>",          // sha256(content, utf-8)
    producedAtSec: number,
  },
  report: {
    summary: string,
    findings: AuditFinding[],
    toolsRun: ("slither" | "mythril" | "llm")[],
    modelId?: string,
  },
  sourceBytes: number,
}
```

Each `AuditFinding` carries
`{ id, title, severity, file, line?, description, recommendation, source }`.

## Failure reasons

The handler never throws; every failure becomes
`{ status: "failure", reason }` with one of the stable codes:

| Reason                            | Meaning                                |
| --------------------------------- | -------------------------------------- |
| `input_invalid: <issues>`         | Schema validation rejected the input   |
| `input_too_large`                 | Inline payload exceeded total cap      |
| `source_too_large`                | URL response exceeded `maxBytes`       |
| `fetch_failed: <status\|message>` | Network or non-2xx HTTP status         |
| `unsupported_content_type: <ct>`  | URL returned a non-text content type   |
| `unsupported_kind`                | Loader received an unknown source kind |
| `audit_timeout`                   | Audit exceeded its wall-clock budget   |
| `audit_internal_error: <message>` | Anything else (logged, fail-safe)      |

## Static-tool detection

`runStaticAuditor` consults the injected `which("slither")` and
`which("myth")` seams. When neither is on `$PATH`, it returns
`{ available: false }` and the LLM auditor carries the audit on its
own. When a tool is found, the auditor:

1. Writes the input files to a fresh temp dir.
2. Spawns the tool with a 120s timeout via the injected `spawn` seam.
3. Parses the JSON output (slither's `--json -`, mythril's
   `analyze -o json`) into `AuditFinding[]`.
4. Logs and skips the tool on timeout, parse failure, or any other
   spawn error — the rest of the audit continues.

`slither` / `mythril` are NOT runtime dependencies. Operators install
them separately:

```bash
pip install slither-analyzer mythril
```

## Signed payload

`SigningRuntimeChain` (re-exported from
`bpps/text-summarize/chain-adapter.ts` per the keep-in-sync comment)
wraps any `RuntimeChain` and signs the canonical JSON of:

```ts
// completeTask
{ taskId, status: "success", output, producedAtSec }
// failTask
{ taskId, status: "failure", reason, producedAtSec }
```

`canonicalJson(value)` sorts object keys ascending at every level.
Signed envelopes carry `signature` + `signerPubkey` (both hex
strings) and are exposed on `chain.signedComplete` / `chain.signedFail`
for re-derivation by downstream RPC submitters.

## Running the example

```bash
cd eto-mcp
CODE_AUDIT_SOLIDITY_FAKE=1 bun run keeper/bpps/code-audit-solidity/main.ts
```

`CODE_AUDIT_SOLIDITY_FAKE=1` is the only path supported today (no
production LLM/RPC wiring exists yet — FN-082 / FN-085 will add it).
The example registers the AgentCard, runs the self-credential
preflight against an in-memory seeded `AgentCard`, pumps three
synthetic events through `runBpp`, and prints the signed envelopes
recorded on `InMemoryChain`.

### Environment variables

| Variable                                | Default                                       | Meaning                                          |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| `CODE_AUDIT_SOLIDITY_AUTHORITY`         | `CodeAuditSolidityBppAuthority11111111111111` | BPP authority pubkey (base58)                    |
| `CODE_AUDIT_SOLIDITY_SELF_ISSUERS`      | `SkillCertIssuerDevPubkey1111111111111111111` | Comma-separated FN-041 issuer pubkey(s)          |
| `CODE_AUDIT_SOLIDITY_FAKE`              | unset                                         | Force fake LLM + fake static auditor (example)   |
| `KEEPER_MODEL`                          | `claude-sonnet-4-6`                           | Anthropic model used by the LLM auditor          |
| `ANTHROPIC_API_KEY`                     | unset                                         | API key for `AnthropicLlmAuditClient`            |

## Wiring a real Anthropic client

`AnthropicLlmAuditClient` accepts any object structurally matching
`AnthropicLike` (`{ messages: { create(...) } }`). Production code
constructs an `Anthropic` instance from `@anthropic-ai/sdk` reading
`ANTHROPIC_API_KEY` from env and passes it in:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmAuditClient } from "@eto/mcp/keeper/bpps/code-audit-solidity";

const llm = new AnthropicLlmAuditClient(new Anthropic());
```

We do **not** static-import `@anthropic-ai/sdk` from this BPP so the
keeper tree compiles and tests run without the SDK installed.

## TODOs (intentional, tracked separately)

- `TODO(real signer via eto-signing-service)` — replace `makeStubSigner`
  with a FROST threshold-ed25519 client (FN-082 / FN-085).
- `TODO(real RuntimeChain)` — replace `InMemoryChain` with an RPC-backed
  submitter once `CompleteTask` / `FailTask` instructions land
  (FN-053 / FN-085).
- `TODO(real AgentCardLoader)` — `inMemoryAgentCardLoader` is the only
  loader shipped today. A real RPC-backed loader will plug into
  `assertSelfSkillCredential` post-FN-082.
- `TODO(FN-081)` — add the verified-human `RequiredCredential` to
  `tags.requiredCredentials` once the FN-081 schema is published.
- `TODO(FN-074)` — once the on-chain credential gate lands, replace
  the template-side gate with a stricter on-chain assertion.

## Test layout

`eto-mcp/tests/unit/code-audit-solidity-bpp.test.ts` covers, in order
of the authoring steps:

1. config + tags + `zAuditInput` edge cases (size limits, traversal,
   discriminator).
2. self-credential preflight — ok, wrong-schema, wrong-issuer,
   revoked, expired, not-yet-valid, open-ended, plus the remediation
   string.
3. source loader (inline / url / base64) and the static auditor
   (no-tools, slither parse, mythril parse, timeout, parse failure).
4. LLM auditor JSON parsing + the `runAudit` orchestrator
   (merge/dedupe + severity floor + sort + Markdown render).
5. handler success / schema-failure / oversized; end-to-end via
   `runBpp` + `SigningRuntimeChain` (single-file + multi-file
   successes + one oversized failure); `main()` smoke test in fake
   mode.
