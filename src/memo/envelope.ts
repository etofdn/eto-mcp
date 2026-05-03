/**
 * Memo envelope schema (Draft 2020-12).
 *
 * The envelope wraps a typed payload validated separately by a per-schema
 * payload validator looked up via {@link getPayloadValidator}. See
 * `docs/memo-schema-registry.md` §2 for the wire-format contract.
 */

export interface MemoEnvelope<T = unknown> {
  type: string;
  schema: string;
  v: number;
  /** RFC 3339 UTC timestamp (e.g. `2026-05-02T17:00:00Z`). */
  ts: string;
  payload: T;
}

export const ENVELOPE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://eto.fdn/spec/memo-schemas/envelope.v1.json",
  title: "eto.memo.envelope.v1",
  description:
    "Top-level envelope for typed memos. Payload is validated separately by the registered schema named in the `schema` field.",
  type: "object",
  required: ["type", "schema", "v", "ts", "payload"],
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description:
        "Short kind discriminator. Must equal the `<type>` segment of `schema`.",
    },
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description:
        "Full registry label, e.g. `eto.memo.eval_score.v1`. Identifies the payload schema.",
    },
    v: {
      type: "integer",
      minimum: 1,
      description:
        "Major schema version. Must equal the `vN` suffix of `schema`.",
    },
    ts: {
      type: "string",
      format: "date-time",
      description: "RFC 3339 / ISO 8601 UTC timestamp.",
    },
    payload: {
      type: "object",
      description:
        "Typed payload, validated against the schema named in `schema`.",
    },
  },
} as const;
