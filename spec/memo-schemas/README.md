# Memo schema examples

Example JSON Schema (Draft 2020-12) files for the v1 memo schemas registered
in [`docs/memo-schema-registry.md`](../../docs/memo-schema-registry.md).

Each file validates the **payload** portion of a memo envelope; the envelope
shape itself (`type`, `schema`, `v`, `ts`, `payload`) is described in §2 of the
registry document and will be implemented as a separate shared schema by the
runtime follow-up task.

| File                          | Label                            | Description                                                          |
|-------------------------------|----------------------------------|----------------------------------------------------------------------|
| `eval_score.v1.json`          | `eto.memo.eval_score.v1`         | Score one agent against a named metric (LLM-judge, oracle).          |
| `payment.v1.json`             | `eto.memo.payment.v1`            | Structured payment metadata (purpose, invoice id, optional task ref).|
| `coordination_log.v1.json`    | `eto.memo.coordination_log.v1`   | A2A coordination lifecycle event (offered/accepted/completed/…).     |

See [`docs/memo-schema-registry.md`](../../docs/memo-schema-registry.md) for
naming conventions, validation rules, versioning policy, and the procedure for
adding new schemas.
