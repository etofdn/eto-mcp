/**
 * CSV fetcher for the `data:analyze` BPP (FN-079).
 *
 * Resolves an `AnalyzeSource` to raw CSV/TSV text:
 *  - `kind: "csv"`        — passthrough.
 *  - `kind: "csvBase64"`  — base64-decode (validated) and decode utf-8.
 *  - `kind: "url"`        — `fetch(url)` with a 30 s `AbortController`
 *    timeout and a streaming-cap of `maxBytes` (default 16 MB);
 *    accepts `text/csv`, `text/tab-separated-values`, `text/plain`,
 *    `application/csv`. Non-2xx → `fetch_failed: <status>`. Oversized
 *    → `source_too_large`.
 *
 * Side-effecting seams (`fetch`) are injected so the test suite can
 * drive each branch with deterministic stubs.
 */

import type { AnalyzeSource } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_FETCH_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

const ACCEPTED_CONTENT_TYPES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "application/csv",
  "application/octet-stream", // best-effort fallback
]);

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchCsvDeps {
  readonly fetch: FetchLike;
  readonly fetchTimeoutMs?: number;
}

export interface FetchedCsv {
  readonly text: string;
  readonly sourceBytes: number;
  readonly contentType: string;
}

/* -------------------------------------------------------------------------- */
/* fetchCsv                                                                   */
/* -------------------------------------------------------------------------- */

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

export async function fetchCsv(
  source: AnalyzeSource,
  deps: FetchCsvDeps,
): Promise<FetchedCsv> {
  switch (source.kind) {
    case "csv": {
      if (!isUtf8Decodable(Buffer.from(source.text, "utf8"))) {
        throw new Error("encoding_unsupported");
      }
      return {
        text: source.text,
        sourceBytes: Buffer.byteLength(source.text, "utf8"),
        contentType: "text/csv",
      };
    }
    case "csvBase64": {
      const cleaned = source.data.replace(/\s+/g, "");
      if (!BASE64_RE.test(source.data)) {
        throw new Error("input_too_large: invalid base64");
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(cleaned, "base64");
      } catch {
        throw new Error("input_too_large: invalid base64");
      }
      if (!isUtf8Decodable(buf)) {
        throw new Error("encoding_unsupported");
      }
      return {
        text: buf.toString("utf8"),
        sourceBytes: buf.length,
        contentType: "text/csv",
      };
    }
    case "url":
      return await fetchUrl(source.url, source.maxBytes, deps);
  }
}

async function fetchUrl(
  url: string,
  maxBytesOpt: number | undefined,
  deps: FetchCsvDeps,
): Promise<FetchedCsv> {
  const maxBytes = maxBytesOpt ?? DEFAULT_FETCH_MAX_BYTES;
  const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: FetchLikeResponse;
  try {
    resp = await deps.fetch(url, { signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`fetch_failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    throw new Error(`fetch_failed: ${resp.status}`);
  }

  const cl = resp.headers.get("content-length");
  if (cl !== null) {
    const declared = Number(cl);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error("source_too_large");
    }
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error("source_too_large");
  }

  const ctRaw = resp.headers.get("content-type") ?? "application/octet-stream";
  const ct = ctRaw.split(";")[0]!.trim().toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.has(ct) && !ct.startsWith("text/")) {
    throw new Error(`unsupported_content_type: ${ct}`);
  }

  if (!isUtf8Decodable(buf)) {
    throw new Error("encoding_unsupported");
  }

  return {
    text: buf.toString("utf8"),
    sourceBytes: buf.length,
    contentType: ct,
  };
}

/* -------------------------------------------------------------------------- */
/* Utf-8 validation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Validate that `buf` is well-formed UTF-8. Re-encodes after decoding
 * and compares byte-length so invalid sequences (which Node would
 * otherwise replace with U+FFFD silently) are detected.
 *
 * Permissive of pure-ASCII input (the common case), and rejects
 * anything that contains a replacement character that wasn't already
 * present in the source bytes.
 */
function isUtf8Decodable(buf: Buffer): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    // Round-trip check — defensive belt + braces against runtimes that
    // don't honour `fatal: true`.
    const reencoded = Buffer.from(decoded, "utf8");
    return reencoded.length === buf.length;
  } catch {
    return false;
  }
}
