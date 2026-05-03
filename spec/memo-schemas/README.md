# Memo Schema Templates

JSON Schema (Draft 2020-12) **payload** templates for the typed on-chain memo
records described in [`docs/memo-schema-registry.md`](../../docs/memo-schema-registry.md).

Each file validates only the `payload` sub-object of the canonical envelope
(`{ type, schema, v, ts, payload }`); envelope validation is performed by a
shared schema in the runtime layer (see follow-up implementation task linked
from FN-057).

| File                                                       | Label                            | Description                                                       |
|------------------------------------------------------------|----------------------------------|-------------------------------------------------------------------|
| [`eval_score.v1.json`](./eval_score.v1.json)               | `eto.memo.eval_score.v1`         | One agent's evaluation of another on a single named metric.       |
| [`payment.v1.json`](./payment.v1.json)                     | `eto.memo.payment.v1`            | Billing-intent annotation on a value transfer (service / escrow / refund / tip). |
| [`coordination_log.v1.json`](./coordination_log.v1.json)   | `eto.memo.coordination_log.v1`   | A2A task lifecycle event (offered / accepted / completed / cancelled). |

To add a new schema, follow the checklist in
[`docs/memo-schema-registry.md`](../../docs/memo-schema-registry.md) §7.
