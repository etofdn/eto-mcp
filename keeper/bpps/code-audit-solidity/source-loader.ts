/**
 * Source loader for the `code:audit:solidity` BPP (FN-076).
 *
 * Resolves a parsed `AuditInput` to a `{ files: { path; content }[] }`
 * collection. Three input kinds are supported:
 *
 *  - `inline`  → returned directly.
 *  - `url`     → `fetch(url)` with a 30s `AbortController` timeout,
 *                content-type asserted to be text-ish, byte-cap enforced.
 *                Always resolves to exactly ONE file (no archive expansion).
 *  - `base64`  → decoded once, returned as exactly one file under
 *                `input.filename`.
 *
 * All side-effecting seams are injected so tests drive the path with
 * deterministic stubs.
 */

import type { AuditInputSource, AuditInputFile } from "./types.js";
import { PER_FILE_MAX_BYTES, URL_MAX_BYTES } from "./types.js";

/* -------------------------------------------------------------------------- */
/* fetch seam                                                                 */
/* -------------------------------------------------------------------------- */

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_URL_MAX_BYTES = URL_MAX_BYTES;

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

export interface LoadSourcesDeps {
  readonly fetch: FetchLike;
  readonly fetchTimeoutMs?: number;
}

export interface LoadedSources {
  readonly files: readonly AuditInputFile[];
  readonly sourceBytes: number;
}

/* -------------------------------------------------------------------------- */
/* loadSources                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve an `AuditInputSource` to a `{ files, sourceBytes }` bundle.
 *
 * Throws stable error codes (`source_too_large`, `fetch_failed: <…>`,
 * `unsupported_content_type: <ct>`) so the handler maps them straight
 * onto failure reasons.
 */
export async function loadSources(
  input: AuditInputSource,
  deps: LoadSourcesDeps,
): Promise<LoadedSources> {
  switch (input.kind) {
    case "inline": {
      let total = 0;
      for (const f of input.files) total += Buffer.byteLength(f.content, "utf8");
      return { files: input.files, sourceBytes: total };
    }
    case "base64": {
      const buf = Buffer.from(input.data, "base64");
      if (buf.length > PER_FILE_MAX_BYTES) {
        throw new Error("source_too_large");
      }
      const file: AuditInputFile = {
        path: sanitisePath(input.filename),
        content: buf.toString("utf8"),
      };
      return { files: [file], sourceBytes: buf.length };
    }
    case "url": {
      const file = await fetchUrl(input.url, input.maxBytes, deps);
      return { files: [file.file], sourceBytes: file.sourceBytes };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* URL fetch                                                                  */
/* -------------------------------------------------------------------------- */

const ALLOWED_CONTENT_TYPES = new Set([
  "text/plain",
  "text/x-solidity",
  "application/octet-stream",
]);

async function fetchUrl(
  url: string,
  maxBytesOpt: number | undefined,
  deps: LoadSourcesDeps,
): Promise<{ file: AuditInputFile; sourceBytes: number }> {
  const maxBytes = maxBytesOpt ?? DEFAULT_URL_MAX_BYTES;
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
  if (!ALLOWED_CONTENT_TYPES.has(ct)) {
    throw new Error(`unsupported_content_type: ${ct}`);
  }

  const path = sanitisePath(filenameFromUrl(url));
  return {
    file: { path, content: buf.toString("utf8") },
    sourceBytes: buf.length,
  };
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last && last.length > 0 ? last : "source.sol";
  } catch {
    return "source.sol";
  }
}

/**
 * Reject path-traversal sequences and absolute paths. Zod already
 * rejects these for inline inputs; URL/base64 inputs route through
 * here for defence-in-depth.
 */
function sanitisePath(p: string): string {
  if (p.includes("..") || p.startsWith("/")) {
    throw new Error(`fetch_failed: unsafe path ${p}`);
  }
  return p;
}
