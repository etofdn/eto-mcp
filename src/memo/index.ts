/**
 * Public API barrel for the memo runtime (FN-040).
 *
 * Exposes `encodeMemo` / `decodeMemo` plus the supporting types and budget
 * constants. See `docs/memo-schema-registry.md` §5 for the producer/consumer
 * contract this module implements.
 *
 * Implementation covers the full FN-040 spec:
 *  - `encodeMemo<T>(type, payload, opts?)` validates via Ajv 2020 + ajv-formats
 *    against the registered envelope + payload schemas; enforces ≤400-byte
 *    soft-warn (MEMO_SOFT_WARN_BYTES) and a hard limit (MEMO_HARD_LIMIT_BYTES).
 *  - `decodeMemo(raw)` never throws; returns `{ ok, envelope }` or
 *    `{ ok: false, reason }` for all failure modes (not_json, envelope_invalid,
 *    unknown_schema, payload_invalid, unknown_future_version, …).
 *  - `transfer_native` and `batch` accept either a free-form string or a
 *    structured `{ type, payload }` shape (wired in `src/tools/transfer.ts`).
 *  - `query_memos` returns `{ raw, decoded }` per record, never throwing on
 *    malformed entries (wired in `src/tools/query.ts`).
 *  - Three v1 payload schemas registered: eval_score, payment, coordination_log
 *    (loaded from `spec/memo-schemas/*.v1.json` via `src/memo/registry.ts`).
 */

import {
  ENVELOPE_SCHEMA,
  type MemoEnvelope,
} from "./envelope.js";
import {
  envelopeValidator,
  getPayloadValidator,
  highestKnownVersion,
} from "./registry.js";
import {
  MEMO_HARD_LIMIT_BYTES,
  MEMO_SOFT_WARN_BYTES,
  byteLengthUtf8,
} from "./budget.js";
import type { DecodeFailureReason } from "./errors.js";

export {
  ENVELOPE_SCHEMA,
  MEMO_HARD_LIMIT_BYTES,
  MEMO_SOFT_WARN_BYTES,
  byteLengthUtf8,
  highestKnownVersion,
  getPayloadValidator,
};
export type { MemoEnvelope, DecodeFailureReason };

export type DecodeResult<T = unknown> =
  | { ok: true; envelope: MemoEnvelope<T> }
  | { ok: false; reason: DecodeFailureReason; raw: string };

export interface EncodeOptions {
  /** Override the auto-derived `eto.memo.<type>.v<v>` schema label. */
  schema?: string;
  /** Override the version. Defaults to `highestKnownVersion(type) ?? 1`. */
  v?: number;
  /** Override the timestamp. Defaults to `new Date().toISOString()`. */
  ts?: string;
}

const SCHEMA_SUFFIX_RE = /\.v(\d+)$/;
const SCHEMA_TYPE_RE = /^eto\.memo\.([^.]+(?:\.[^.]+)*)\.v\d+$/;

function extractTypeSegment(schema: string): string | undefined {
  const m = SCHEMA_TYPE_RE.exec(schema);
  return m ? m[1] : undefined;
}

function extractVersionSuffix(schema: string): number | undefined {
  const m = SCHEMA_SUFFIX_RE.exec(schema);
  return m ? Number(m[1]) : undefined;
}

/**
 * Encode a typed payload into the canonical UTF-8 JSON envelope.
 *
 * - Fills `schema` and `v` from the registry when not supplied (defaulting
 *   to the highest known version of `type`, or `1` if `type` is brand new).
 * - Validates the envelope and the payload via Ajv 2020 + ajv-formats.
 * - Rejects envelopes larger than {@link MEMO_HARD_LIMIT_BYTES}; warns once
 *   when an envelope exceeds {@link MEMO_SOFT_WARN_BYTES}.
 *
 * Throws on validation failure, unknown schema, or oversize. Producers MUST
 * surface these errors back to the user (see `transfer_native`'s try/catch).
 */
export function encodeMemo<T>(
  type: string,
  payload: T,
  opts: EncodeOptions = {},
): string {
  const v = opts.v ?? highestKnownVersion(type) ?? 1;
  const schema = opts.schema ?? `eto.memo.${type}.v${v}`;
  const ts = opts.ts ?? new Date().toISOString();

  // Cross-check schema label segments before doing any expensive validation
  // so the error message is precise.
  const labelType = extractTypeSegment(schema);
  const labelV = extractVersionSuffix(schema);
  if (labelType !== type) {
    throw new Error(
      `encodeMemo: type "${type}" does not match <type> segment of schema "${schema}"`,
    );
  }
  if (labelV !== v) {
    throw new Error(
      `encodeMemo: v=${v} does not match vN suffix of schema "${schema}"`,
    );
  }

  const envelope: MemoEnvelope<T> = { type, schema, v, ts, payload };

  if (!envelopeValidator(envelope)) {
    throw new Error(
      `encodeMemo: envelope invalid: ${envelopeValidator.errors
        ? // ajv keeps errors on the validator instance
          ajvErrorsText(envelopeValidator.errors)
        : "unknown error"}`,
    );
  }

  const payloadValidator = getPayloadValidator(schema, v);
  if (!payloadValidator) {
    throw new Error(`encodeMemo: unknown schema ${schema} v${v}`);
  }
  if (!payloadValidator(payload)) {
    throw new Error(
      `encodeMemo: payload invalid: ${ajvErrorsText(payloadValidator.errors)}`,
    );
  }

  const out = JSON.stringify(envelope);
  const bytes = byteLengthUtf8(out);
  if (bytes > MEMO_HARD_LIMIT_BYTES) {
    throw new Error(
      `encodeMemo: envelope ${bytes} bytes exceeds hard ${MEMO_HARD_LIMIT_BYTES}-byte memo budget; consider an off-chain evidence_uri`,
    );
  }
  if (bytes > MEMO_SOFT_WARN_BYTES) {
    // Single-line warning. Producers SHOULD redesign the payload to fit
    // under the soft budget before this fires in steady state.
    // eslint-disable-next-line no-console
    console.warn(
      `[memo] envelope ${bytes} bytes exceeds soft ${MEMO_SOFT_WARN_BYTES}-byte budget; consider off-chain evidence_uri`,
    );
  }
  return out;
}

/**
 * Decode a raw memo string into a {@link MemoEnvelope}.
 *
 * Never throws. Every parse / validation / lookup failure surfaces as
 * `{ ok: false, reason }`; consumers (e.g. `query_memos`) MUST treat
 * failed decodes as opaque records rather than aborting the whole call.
 *
 * Per `docs/memo-schema-registry.md` §6, an envelope whose `<type>` is
 * known but whose `v` exceeds the highest registered version decodes as
 * `unknown_future_version` (not `unknown_schema`) so consumers can apply
 * forward-compatibility heuristics if they want to.
 */
export function decodeMemo<T = unknown>(raw: string): DecodeResult<T> {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "not_json", raw };
    }

    if (!envelopeValidator(parsed)) {
      return { ok: false, reason: "envelope_invalid", raw };
    }
    const envelope = parsed as MemoEnvelope<T>;

    const labelType = extractTypeSegment(envelope.schema);
    const labelV = extractVersionSuffix(envelope.schema);
    if (labelType !== envelope.type || labelV !== envelope.v) {
      return { ok: false, reason: "type_schema_mismatch", raw };
    }

    const validator = getPayloadValidator(envelope.schema, envelope.v);
    if (!validator) {
      const known = highestKnownVersion(envelope.type);
      if (known !== undefined && envelope.v > known) {
        return { ok: false, reason: "unknown_future_version", raw };
      }
      return { ok: false, reason: "unknown_schema", raw };
    }
    if (!validator(envelope.payload)) {
      return { ok: false, reason: "payload_invalid", raw };
    }

    return { ok: true, envelope };
  } catch {
    // Defensive — must never throw out of decodeMemo.
    return { ok: false, reason: "envelope_invalid", raw };
  }
}

function ajvErrorsText(errors: unknown): string {
  if (!Array.isArray(errors)) return "validation failed";
  return errors
    .map((e) => {
      const path = (e as { instancePath?: string })?.instancePath ?? "";
      const msg = (e as { message?: string })?.message ?? "invalid";
      return `${path || "/"} ${msg}`.trim();
    })
    .join("; ");
}
