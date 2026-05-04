# ETO Memo Schema Registry

> Tracking issue: [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11) (item 4/10).
> Companion to [`docs/schema-registry.md`](./schema-registry.md). This registry
> covers **memo schemas** — typed JSON envelopes anchored in SPL Memo Program v2
> instruction data — and is intentionally separate from the **credential schema
> registry**, which catalogs W3C Verifiable Credential payloads gated on-chain
> by `schema_hash`.

## §1 — Why a typed memo layer

Today `transfer_native` and the `batch` transfer tool accept a free-form
`memo: string` (see `src/tools/transfer.ts`), which is wired straight into a
single SPL Memo v2 instruction in the transfer transaction. The same memo is
recoverable later via `query_memos` and `get_account_transactions`. This is
sufficient for human-readable annotations but breaks down once agents start
exchanging structured records on-chain:

- **No type discrimination.** A consumer cannot tell an evaluation score from a
  payment receipt from a coordination-log entry without ad-hoc string sniffing
  ("does it start with `score:`?").
- **No versioning.** Producers cannot evolve their record shape without
  silently breaking older readers.
- **No validation contract.** Each consumer re-implements its own parser, and
  malformed entries surface as opaque errors instead of being skipped cleanly.

This registry defines a small typed-envelope convention so that three concrete
record kinds — and any future ones — can be produced and consumed safely:

| Kind                | Purpose                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `eval_score`        | One agent scoring another against a named metric (LLM-judge, oracle)   |
| `payment`           | Structured payment metadata (purpose, invoice id, optional task ref)   |
| `coordination_log`  | A2A coordination event (`task_offered`, `task_accepted`, …)            |

The runtime implementation (validators, helper functions, tool wiring) is
explicitly out of scope for this document; see the follow-up implementation
task referenced from issue #11.

## §2 — Envelope shape

Every typed memo is a single UTF-8 JSON object with **no leading whitespace**
and no trailing newline. The wire format is:

```json
{
  "type": "eval_score",
  "schema": "eto.memo.eval_score.v1",
  "v": 1,
  "ts": "2026-05-02T17:00:00Z",
  "payload": { "...": "..." }
}
```

Required top-level fields:

| Field      | Type    | Notes                                                                   |
|------------|---------|-------------------------------------------------------------------------|
| `type`     | string  | Short kind discriminator. Must equal the `<type>` segment of `schema`. |
| `schema`   | string  | Full registry label (see §3). Identifies the payload schema.            |
| `v`        | integer | Major schema version, ≥ 1. Equals the `vN` suffix of `schema`.          |
| `ts`       | string  | RFC 3339 / ISO 8601 UTC timestamp (e.g. `2026-05-02T17:00:00Z`).        |
| `payload`  | object  | The typed body, validated by the schema named in `schema`.              |

`additionalProperties` on the envelope is **false**; producers MUST NOT add
extra top-level fields. Extensibility happens inside `payload` (per its own
schema, additive within a major version).

### Size budget

A single SPL Memo v2 instruction in a typical SVM transfer transaction has
roughly **566 bytes** of usable instruction data after accounting for the
transfer instruction, signature, blockhash, and program ids. This budget
shrinks further if multiple instructions are packed in the same tx.

Guidance for producers:

- Keep the full encoded envelope ≤ **400 bytes** to leave headroom for SDK
  variations and future cosigner accounts.
- For records that exceed the budget (e.g. eval evidence with logs attached),
  store the bulk content off-chain (S3, IPFS, R2) and put a content digest +
  pointer URI inside the payload. The on-chain memo then anchors integrity
  without paying transaction-size for the whole record. v1 schemas already
  reserve `evidence_uri` on `eval_score` for exactly this pattern.
- Producers SHOULD reject oversize envelopes client-side rather than rely on
  the validator to truncate.

## §3 — Naming convention

```
eto.memo.<type>[.<sub>].v<N>
```

- `<type>` — required kind discriminator. Matches the envelope `type` field.
- `<sub>` — optional refinement (reserved for future use, e.g.
  `payment.escrow.v1`). v1 schemas in this registry do not use a sub-segment.
- `<N>` — major version, integer ≥ 1. Additive changes within a major version
  are non-breaking; breaking changes mint `v(N+1)`.

The `eto.memo.*` prefix is **deliberately distinct** from `eto.beckn.schema.*`
used by the credential registry (`docs/schema-registry.md`) to prevent label
collision. Memo schemas are **not** hashed onto chain; they are identified by
label string only. If hash-binding is desired later, see §8.

Pre-image strings are case-sensitive ASCII.

## §4 — Registered schemas (v1)

| Label                            | Producer                                  | Consumer                                    | Schema file                                       |
|----------------------------------|-------------------------------------------|---------------------------------------------|---------------------------------------------------|
| `eto.memo.eval_score.v1`         | evaluator agent (LLM-judge / oracle)      | reputation aggregator, dashboards           | [`spec/memo-schemas/eval_score.v1.json`](../spec/memo-schemas/eval_score.v1.json) |
| `eto.memo.payment.v1`            | wallet UX, escrow agent, A2A SDK          | accounting, invoice reconciliation          | [`spec/memo-schemas/payment.v1.json`](../spec/memo-schemas/payment.v1.json)       |
| `eto.memo.coordination_log.v1`   | A2A SDK coordination layer                | orchestration UI, audit trail               | [`spec/memo-schemas/coordination_log.v1.json`](../spec/memo-schemas/coordination_log.v1.json) |

## §5 — Validation approach

Validation uses [Ajv](https://ajv.js.org/) (already a project dependency in
`package.json`, `^8.20.0`) compiled against JSON Schema **Draft 2020-12**, with
`ajv-formats` providing `date-time` validation for the `ts` field.

Two-stage validation:

1. **Envelope** — validate top-level shape (`type`, `schema`, `v`, `ts`,
   `payload`) against a single shared envelope schema.
2. **Payload** — look up the per-schema validator by the envelope's `schema`
   label and validate `payload` against the schema file under
   `spec/memo-schemas/`.

Producer/consumer contract:

- **Producers MUST validate before submission.** A failing validation aborts
  the transfer; it does not silently strip the memo.
- **Consumers MUST validate on read** and MUST treat invalid records as
  opaque. A malformed memo, an unknown `schema`, or a future-version memo
  must never throw out of the entire `query_memos` call — it returns alongside
  valid records with a `{ ok: false, reason }` shape.

TypeScript helper signatures (shipped — see [`src/memo/index.ts`](../src/memo/index.ts)):

```ts
export interface MemoEnvelope<T = unknown> {
  type: string;
  schema: string;
  v: number;
  ts: string; // RFC 3339 UTC
  payload: T;
}

export function encodeMemo<T>(
  type: string,
  payload: T,
  opts?: { schema?: string; v?: number; ts?: string },
): string;

export type DecodeResult =
  | { ok: true; envelope: MemoEnvelope }
  | { ok: false; reason: string; raw: string };

export function decodeMemo(raw: string): DecodeResult;
```

`encodeMemo` is the single sanctioned way for SDK callers to produce typed
memos; it runs Ajv against both envelope and payload before returning the
serialized string. `decodeMemo` never throws — all parse/validate failures
land in the `{ ok: false }` branch.

**Byte budgets enforced by the runtime** (see
[`src/memo/budget.ts`](../src/memo/budget.ts)):

- `MEMO_HARD_LIMIT_BYTES = 566` — `encodeMemo` rejects oversize envelopes
  with `Error("oversize: <n> bytes > 566")`. Decoding does not enforce this
  limit (consumers accept whatever the chain returned).
- `MEMO_SOFT_WARN_BYTES = 400` — `encodeMemo` emits a single `console.warn`
  recommending off-chain `evidence_uri` when the envelope is between the
  soft and hard limits.

**`query_memos` integration.** Each record returned by
`query_memos` now carries both the original `raw` string and a `decoded`
field holding the full `DecodeResult` (`{ ok: true, envelope }` for valid
envelopes, `{ ok: false, reason, raw }` for malformed / unknown-schema /
future-version records). The handler never throws on bad payloads.

**`transfer_native` / `batch_transfer` integration.** Both tools accept an
optional `typed_memo: { type, payload }` argument; the runtime calls
`encodeMemo` and forwards the resulting string into `buildTransferTx`.
Providing both `memo` and `typed_memo` is rejected. The free-form `memo`
argument remains backward-compatible.

## §6 — Versioning rules

- **Additive within a major version.** New optional fields can be added to a
  payload schema's `properties` without bumping `vN`. Required fields, type
  changes, and removed fields are breaking and require `v(N+1)`.
- **One major version per file.** Each `vN` lives in its own
  `<type>.v<N>.json` file under `spec/memo-schemas/`. Older versions remain
  in the repo so historical memos remain decodable.
- **Consumer compatibility.** A consumer that knows versions up to `vK`
  SHOULD accept any envelope with `v ≤ K` and SHOULD ignore (treat as opaque)
  envelopes with `v > K`. Consumers MUST NOT crash on unknown future versions.
- **Label immutability.** Once published, a label like `eto.memo.eval_score.v1`
  is frozen. Never reuse the label for a different shape.

## §7 — Adding a new schema

1. Pick a `type` discriminator and label per §3 (e.g. `eto.memo.attestation.v1`).
2. Add a JSON Schema Draft 2020-12 file at
   `spec/memo-schemas/<type>.v<N>.json` validating the **payload only** (the
   envelope is validated separately). Set `$schema`, `$id`, `title`,
   `type: "object"`, `required`, and `additionalProperties: false`.
3. Add a row to §4 (Producer / Consumer / Schema file).
4. Add a one-line description to `spec/memo-schemas/README.md`.
5. Verify the schema compiles under Ajv 2020 in strict mode (see Step 4 of
   FN-057 for the exact one-liner).
6. If breaking an existing schema, mint `v(N+1)` rather than mutating the
   existing file.
7. Open a PR; CI re-runs the Ajv compile check.

## §8 — Open questions / out of scope for v1

- **Cryptographic schema commitments.** v1 identifies schemas by label string
  only. We do not bind a `sha256(canonical-JSON-of-schema)` digest into the
  envelope or anchor it on-chain. If a future BPP wants strong schema
  integrity (analogous to the credential registry's on-chain `schema_hash`),
  add a `schema_digest` field to the envelope and define canonicalization
  rules (likely RFC 8785 JCS).
- **Cross-program memo discovery.** Today only `query_memos` /
  `get_account_transactions` surface memos, scoped to a single SVM account.
  Cross-program indexing (e.g. tying a `coordination_log` memo on one wallet
  to a `payment` memo on another) is left to higher-level orchestration.
- **Bridging to the credential registry.** A `payment` memo that doubles as a
  receipt VC will need a defined mapping from `eto.memo.payment.v1` →
  `eto.beckn.schema.<receipt>.v1`. The two registries deliberately do not
  share a namespace, but a runtime adapter could project one into the other.
- **Compression / binary framing.** All v1 envelopes are uncompressed UTF-8
  JSON. If size pressure grows, candidates include CBOR (RFC 8949) or simple
  field aliasing; both would mint `v2` or a sibling envelope kind.
- **Multi-instruction memos.** v1 assumes one envelope per memo instruction.
  Splitting a large record across multiple memo instructions in a single tx
  is left to a future spec.

## See also

- [`docs/schema-registry.md`](./schema-registry.md) — Beckn **credential**
  schema registry. Credential schemas are W3C VC payload shapes gated on-chain
  by `schema_hash = SHA-256(label)` and consumed by the IssuerNetwork. Memo
  schemas (this document) live in SPL Memo instruction data and are validated
  off-chain only.
