# ETO Singularity Record Schema Registry

> Tracking issue: SDK API spec follow-up (FN-055) — closes the open-question
> item on Singularity record schemas (referenced as item #6 of the SDK API
> spec §7 once that doc lands; that document does not yet exist in this
> repo).
>
> **Companion to** [`docs/schema-registry.md`](./schema-registry.md) and
> [`docs/memo-schema-registry.md`](./memo-schema-registry.md). Together these
> three documents form the normative schema-naming surface for the project.
>
> This registry catalogs **Layer 3 Singularity SDK record schemas** — typed
> JSON envelopes produced by `agent.log()` and consumed by
> `agent.queryRecords()` in the Singularity SDK. It is intentionally distinct
> from the **credential schema registry** (W3C VC payloads gated on-chain by
> `schema_hash`) and the **memo schema registry** (typed JSON envelopes
> anchored in SPL Memo Program v2 instruction data). The three namespaces —
> `eto.beckn.schema.*`, `eto.memo.*`, and `eto.singularity.record.*` — are
> deliberately disjoint; a single label MUST NOT appear in more than one
> registry.

## §1 — Why a registry

The Singularity SDK gives every agent a single durable channel for writing
and querying its own structured activity. `agent.log()` accepts a typed
record; `agent.queryRecords()` returns matching records back to the same (or
a peer) agent for reflection, evaluation, or downstream automation. Without a
single source of truth for record shapes:

- **No type discrimination.** A consumer cannot tell a tool-call trace from
  an evaluation outcome from a free-form activity entry without ad-hoc
  string sniffing on the payload.
- **No version evolution.** Producers cannot evolve a record's shape without
  silently breaking older readers or query filters.
- **No validation contract.** Each consumer of `agent.queryRecords()`
  re-implements its own parser, and malformed entries surface as opaque
  errors instead of being skipped cleanly.
- **No filter contract.** `agent.queryRecords({ schema, ... })` cannot offer
  a typed filter surface unless the set of legal `schema` values is
  enumerable.

This registry defines the envelope, the naming convention, and the addition
procedure so that record kinds can be proposed, registered, and evolved
safely once the Singularity SDK lands.

## §2 — Record envelope shape

Every Singularity record is a single JSON object with the following
canonical envelope:

```json
{
  "type": "activity_log",
  "schema": "eto.singularity.record.activity_log.v1",
  "v": 1,
  "ts": "2026-05-03T12:00:00Z",
  "agent_id": "<opaque-agent-id>",
  "payload": { "...": "..." }
}
```

Required top-level fields:

| Field      | Type    | Notes                                                                                |
|------------|---------|--------------------------------------------------------------------------------------|
| `type`     | string  | Short kind discriminator. Must equal the `<name>` segment of `schema`.               |
| `schema`   | string  | Full registry label (see §3). Identifies the payload schema.                         |
| `v`        | integer | Major schema version, ≥ 1. Equals the `vN` suffix of `schema`.                       |
| `ts`       | string  | RFC 3339 / ISO 8601 UTC timestamp (e.g. `2026-05-03T12:00:00Z`).                     |
| `agent_id` | string  | Opaque agent identifier as produced by the SDK (see identity model — link below).    |
| `payload`  | object  | The typed body, validated by the schema named in `schema`.                           |

`additionalProperties` on the envelope is **false**; producers MUST NOT add
extra top-level fields. Extensibility happens inside `payload` per its own
schema (additive within a major version — see §6).

The internal shape of `agent_id` is not prescribed here. See
[`docs/agent-identity-model.md`](./agent-identity-model.md) for the canonical
agent identity model (`human × model × environment × session_scope`); this
registry treats the value as an opaque string.

### Size guidance (no hard budget)

Unlike the memo registry, Singularity records are **not** bounded by SPL
Memo's ~566-byte single-instruction budget — records flow through the SDK's
own persistence layer (transport and storage are out of scope for this
document; see §9 and the SDK API spec FN-055 follow-up). Producers SHOULD
nevertheless keep payloads modest:

- Inline only the structured fields the consumer needs to filter or display.
- For bulk content (logs, transcripts, model outputs), store the bulk
  off-line and put a content digest + pointer URI inside the payload —
  analogous to the `evidence_uri` pattern used by `eto.memo.eval_score.v1`.

## §3 — Naming convention

```
eto.singularity.record.<name>[.<sub>].v<N>
```

- `<name>` — required kind discriminator. Matches the envelope `type` field.
- `<sub>` — optional refinement (e.g. `tool_call.openai.v1`). Most v1 records
  are expected to omit the sub-segment.
- `<N>` — major version, integer ≥ 1. Additive changes within a major
  version are non-breaking; breaking changes mint `v(N+1)`.

The `eto.singularity.record.*` prefix is **deliberately distinct** from
`eto.beckn.schema.*` (credential registry) and `eto.memo.*` (memo registry)
to prevent cross-registry label collision. The three namespaces are disjoint
by construction; a label registered here MUST NOT shadow a label in either
sibling registry.

Pre-image strings are case-sensitive ASCII.

## §4 — Registered schemas (v1)

> _Reserved — no v1 records are registered by this document._

Initial record kinds (candidates discussed during SDK scoping include agent
activity log entries, tool-call traces, and evaluation outcomes) will be
proposed via the addition procedure in §7 once the Singularity SDK lands.
Minting labels here ahead of an implementation would risk reserving names
whose semantics shift during SDK design; this registry intentionally defers
that until producers and consumers exist.

| Label | Producer | Consumer | Schema file |
|-------|----------|----------|-------------|
| _(none registered for v1)_ | — | — | — |

### Example (illustrative, not registered)

The following row shows the table format only. It is **not** a registered
label and MUST NOT be assumed available by any producer or consumer.

| Label | Producer | Consumer | Schema file |
|-------|----------|----------|-------------|
| `eto.singularity.record.activity_log.v1` | Singularity SDK `agent.log()` callers | `agent.queryRecords()` consumers, dashboards | `spec/singularity-records/activity_log.v1.json` |

## §5 — Validation approach

Validation uses [Ajv](https://ajv.js.org/) (already a project dependency in
`package.json`, `^8.20.0`) compiled against JSON Schema **Draft 2020-12**,
with `ajv-formats` providing `date-time` validation for the `ts` field.
This matches the toolchain used by the memo registry so the two share
validator infrastructure.

Two-stage validation:

1. **Envelope** — validate top-level shape (`type`, `schema`, `v`, `ts`,
   `agent_id`, `payload`) against a single shared envelope schema.
2. **Payload** — look up the per-schema validator by the envelope's
   `schema` label and validate `payload` against the schema file under
   `spec/singularity-records/`.

Producer/consumer contract:

- **`agent.log()` MUST validate before persistence.** A failing validation
  aborts the call; the record is not written.
- **`agent.queryRecords()` MUST tolerate unknown or future-version
  envelopes.** An unrecognised `schema`, a `v` higher than the consumer
  knows, or a malformed envelope MUST NOT throw out of the entire call —
  the offending record is returned alongside valid records as
  `{ ok: false, reason }` so the caller can decide whether to skip or
  surface it.

Suggested TypeScript helper signatures (the runtime task that implements
the SDK persistence layer will provide concrete bindings; this document
only fixes the contract):

```ts
export interface SingularityRecord<T = unknown> {
  type: string;
  schema: string;
  v: number;
  ts: string;       // RFC 3339 UTC
  agent_id: string; // opaque
  payload: T;
}

export function encodeRecord<T>(
  type: string,
  payload: T,
  opts: { agent_id: string; schema?: string; v?: number; ts?: string },
): SingularityRecord<T>;

export type DecodeResult =
  | { ok: true; record: SingularityRecord }
  | { ok: false; reason: string; raw: unknown };

export function decodeRecord(raw: unknown): DecodeResult;
```

`encodeRecord` is the single sanctioned way for SDK callers to produce
typed records; it MUST run Ajv against both envelope and payload before
returning. `decodeRecord` MUST never throw — all parse/validate failures
land in the `{ ok: false }` branch.

## §6 — Versioning rules

- **Additive within a major version.** New optional fields can be added to
  a payload schema's `properties` without bumping `vN`. Required fields,
  type changes, and removed fields are breaking and require `v(N+1)`.
- **One major version per file.** Each `vN` lives in its own
  `<name>.v<N>.json` file under `spec/singularity-records/`. Older versions
  remain in the repo so historical records remain decodable.
- **Consumer compatibility.** A consumer that knows versions up to `vK`
  SHOULD accept any envelope with `v ≤ K` and SHOULD treat envelopes with
  `v > K` as opaque (returned via the `{ ok: false }` branch of
  `decodeRecord`). Consumers MUST NOT crash on unknown future versions.
- **Label immutability.** Once published, a label like
  `eto.singularity.record.activity_log.v1` is frozen. Never reuse the label
  for a different shape.

## §7 — Adding a new schema

1. Pick a `<name>` discriminator and full label per §3 (e.g.
   `eto.singularity.record.tool_call.v1`).
2. Add a JSON Schema Draft 2020-12 file at
   `spec/singularity-records/<name>.v<N>.json` validating the **payload
   only** (the envelope is validated separately). Set `$schema`, `$id`,
   `title`, `type: "object"`, `required`, and
   `additionalProperties: false`. The first registered schema also lands
   the `spec/singularity-records/` directory; the directory is not assumed
   to exist before that point.
3. Add a row to §4 with Producer / Consumer / Schema file columns, and
   remove the "no v1 records are registered" reservation note in the same
   PR if this is the first registered label.
4. Add a one-line description to a `spec/singularity-records/README.md`
   index (created alongside the first schema file).
5. Verify the schema compiles under Ajv 2020 in strict mode (the SDK's
   compile-check task will provide an exact one-liner; until then,
   `ajv compile -s <file> --spec=draft2020` is the canonical check).
6. If breaking an existing schema, mint `v(N+1)` rather than mutating the
   existing file.
7. Open a PR; CI re-runs the Ajv compile check.

## §8 — Hash derivation (intentionally absent)

Unlike [`docs/schema-registry.md`](./schema-registry.md), Singularity record
schemas are **not** hashed onto chain. They are identified by label string
only. There is no `schema_hash`, no on-chain commitment, and no
canonicalization step in the v1 contract. Producers and consumers compare
labels byte-for-byte.

If cryptographic schema commitments are needed in the future, see §9 — the
open-question list is kept symmetric with the memo registry's so the two
off-chain registries can adopt a shared digest scheme together.

## §9 — Open questions / out of scope for v1

- **Cryptographic schema commitments — out of scope for v1.** v1 identifies
  schemas by label string only. We do not bind a
  `sha256(canonical-JSON-of-schema)` digest into the envelope. If strong
  schema integrity is needed later, add a `schema_digest` field and define
  canonicalization rules (likely RFC 8785 JCS).
- **Cross-registry bridging — out of scope for v1.** A Singularity record
  that doubles as a memo (anchored on-chain via SPL Memo) or as a VC
  payload (gated by the credential registry) will need a defined mapping
  from `eto.singularity.record.<name>.vN` into the sibling label space.
  The three registries deliberately do not share a namespace; a runtime
  adapter could project one into the other, but no such adapter is
  specified here.
- **Compression / binary framing — out of scope for v1.** All v1 envelopes
  are uncompressed UTF-8 JSON. Candidates for size pressure (CBOR per
  RFC 8949, field aliasing, schema-aware encoders) would mint `v2` or a
  sibling envelope kind.
- **Persistence and transport layer — out of scope for v1.** How records
  are stored, replicated, queried, and access-controlled is owned by the
  Singularity SDK API spec (FN-055 follow-up). This registry only fixes
  the wire shape, not the storage substrate.
- **Discovery and indexing across agents — out of scope for v1.** v1
  assumes records are queried via the SDK methods on a single agent's
  scope. Cross-agent discovery (e.g. searching another agent's records
  with a capability grant) is left to a future spec.

## See also

- [`docs/schema-registry.md`](./schema-registry.md) — Beckn **credential**
  schema registry (`eto.beckn.schema.*`). W3C VC payload shapes gated
  on-chain by `schema_hash = SHA-256(label)`.
- [`docs/memo-schema-registry.md`](./memo-schema-registry.md) — **memo**
  schema registry (`eto.memo.*`). Typed JSON envelopes anchored in SPL
  Memo v2 instruction data, validated off-chain with Ajv.
- [`docs/agent-identity-model.md`](./agent-identity-model.md) — the agent
  identity model referenced by the envelope's `agent_id` field.
