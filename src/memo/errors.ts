/**
 * Decode failure reasons emitted by {@link decodeMemo}. Every failure path
 * surfaces one of these strings in the `{ ok: false, reason }` shape; the
 * decoder MUST NOT throw out of the entire `query_memos` call.
 *
 * - `not_json`              — `JSON.parse` failed on the raw memo string.
 * - `envelope_invalid`      — envelope schema validation failed (missing
 *                             field, additionalProperties, bad `ts` format).
 * - `type_schema_mismatch`  — `envelope.type` does not match the `<type>`
 *                             segment of `envelope.schema`, or `envelope.v`
 *                             does not match the `vN` suffix.
 * - `unknown_schema`        — no validator registered for the given
 *                             `(schema, v)` AND no other version of the
 *                             same `<type>` is known.
 * - `unknown_future_version`— a known `<type>` exists but `envelope.v`
 *                             exceeds the highest known version (per §6,
 *                             treat as opaque rather than crash).
 * - `payload_invalid`       — payload failed validation against the
 *                             registered per-schema validator.
 * - `oversize`              — never returned by `decodeMemo` (consumers
 *                             accept whatever size lands), but reserved
 *                             for {@link encodeMemo} rejections.
 */
export type DecodeFailureReason =
  | "not_json"
  | "envelope_invalid"
  | "type_schema_mismatch"
  | "unknown_schema"
  | "unknown_future_version"
  | "payload_invalid"
  | "oversize";
