/**
 * SPL Memo Program v2 log parsing helpers.
 *
 * The SPL Memo Program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) emits
 * the memo bytes as a UTF-8 string in the transaction's program logs. There
 * are two log shapes we encounter in practice from the validator runtime:
 *
 *   1. The canonical Solana validator format:
 *        Program <MEMO_PROGRAM_ID> invoke [N]
 *        Program log: Memo (len <N>): "<json-escaped payload>"
 *        Program <MEMO_PROGRAM_ID> success
 *
 *   2. A simpler fallback some runtimes use, where the memo body is logged
 *      directly on the line immediately following the invoke:
 *        Program <MEMO_PROGRAM_ID> invoke [N]
 *        Program log: <raw payload>
 *        Program <MEMO_PROGRAM_ID> success
 *
 * These helpers are pure (no I/O, no wasm imports) so they can be unit-tested
 * cheaply and reused outside of the MCP tool surface.
 */

/**
 * Base58 program ID for the SPL Memo Program v2. Re-declared locally so this
 * file remains free of any dependency on `src/wasm/index.ts` and its build
 * artifacts.
 */
export const MEMO_PROGRAM_ID_BS58 =
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const INVOKE_RE = new RegExp(
  `^Program\\s+${MEMO_PROGRAM_ID_BS58}\\s+invoke\\s+\\[\\d+\\]\\s*$`
);
const PROGRAM_LOG_PREFIX = "Program log: ";
const MEMO_LEN_RE = /^Memo \(len \d+\): "((?:\\.|[^"\\])*)"\s*$/;

/**
 * Extract memo payloads (as raw UTF-8 strings — not yet JSON-parsed) from a
 * transaction's program log array. Returns an empty array for `undefined`,
 * empty input, or logs containing no memo program invocation. Memos are
 * returned in the order they appear in the log stream.
 *
 * Recognises both the `Program log: Memo (len N): "..."` validator format
 * (JSON-unescaping the quoted payload) and the bare `Program log: <text>`
 * fallback that appears on some runtimes immediately after a memo program
 * invoke line.
 */
export function extractMemosFromLogs(logs: string[] | undefined): string[] {
  if (!logs || logs.length === 0) return [];
  const out: string[] = [];
  let armed = false; // true between a memo-program invoke and the next success/failure
  for (const line of logs) {
    if (INVOKE_RE.test(line)) {
      armed = true;
      continue;
    }
    if (line.startsWith(PROGRAM_LOG_PREFIX)) {
      const body = line.slice(PROGRAM_LOG_PREFIX.length);
      const m = MEMO_LEN_RE.exec(body);
      if (m) {
        // JSON-unescape the quoted payload by re-wrapping it as a JSON string.
        try {
          out.push(JSON.parse(`"${m[1]}"`));
        } catch {
          out.push(m[1]);
        }
        armed = false;
        continue;
      }
      if (armed) {
        out.push(body);
        armed = false;
        continue;
      }
    }
    // Any other line (e.g. `Program ... success`, `Program ... consumed N of M`)
    // closes the armed window without producing a memo.
    if (line.startsWith("Program ") && !line.startsWith(PROGRAM_LOG_PREFIX)) {
      armed = false;
    }
  }
  return out;
}

/**
 * Parse a memo payload as JSON when possible. Returns the parsed value on
 * success, or the raw input string unchanged on any parse failure. Never
 * throws — non-JSON memos must round-trip back to the caller untouched.
 */
export function parseMemoPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Top-level JSON field equality filter. Returns `true` when both `field` and
 * `value` are `undefined` (no filter applied). Otherwise `true` only when
 * `parsed` is a non-array object whose `field` property coerces to `value`
 * via `String(...)`. Strings, numbers, arrays, `null`, and missing fields all
 * return `false` when a filter is active.
 */
export function matchesFilter(
  parsed: unknown,
  field?: string,
  value?: string
): boolean {
  if (field === undefined && value === undefined) return true;
  if (field === undefined || value === undefined) return false;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const v = (parsed as Record<string, unknown>)[field];
  if (v === undefined) return false;
  return String(v) === value;
}
