/**
 * Page fetcher for the `web:research` BPP (FN-077).
 *
 * `fetchPage(url, deps)` performs a `fetch(url)` (with a 20s
 * `AbortController` timeout and a per-page byte cap, default 1 MB),
 * strips HTML to plaintext when applicable, and returns
 * `{ text, contentType, fetchedAtSec, sourceBytes }`. On a non-2xx
 * response we surface `{ fetchError: "fetch_failed:<status>" }` and
 * empty text — so the synthesiser can mark a source as "unavailable"
 * rather than abort the whole report.
 *
 * Includes a basic SSRF guard: refuses non-`http(s):` schemes,
 * `localhost`, `127.0.0.1`, IPv6 link-local (`::1`, `fe80::/10`), and
 * RFC1918 IPv4 ranges (`10/8`, `172.16/12`, `192.168/16`,
 * `169.254/16`).  Tests cover this — do not relax the guard without
 * adding new tests.
 */

import { stripHtml } from "../text-summarize/fetcher.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_PAGE_MAX_BYTES = 1 * 1024 * 1024;
export const DEFAULT_PAGE_TIMEOUT_MS = 20_000;

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

export interface FetchPageDeps {
  readonly fetch: FetchLike;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Wall-clock seconds. Default `Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
}

export interface FetchedPage {
  readonly text: string;
  readonly contentType: string;
  readonly fetchedAtSec: number;
  readonly sourceBytes: number;
  /** Set when the response was non-2xx; `text` will be empty. */
  readonly fetchError?: string;
}

/* -------------------------------------------------------------------------- */
/* SSRF guard                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reject URLs that would let the BPP probe internal infrastructure.
 * Throws an `Error` whose message is one of the stable codes used by
 * the handler (`unsupported_scheme`, `forbidden_host`).
 *
 * Exported for testing — handler doesn't call this directly; it's
 * applied inside `fetchPage`.
 */
export function assertPublicHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("unsupported_scheme: malformed url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported_scheme: ${parsed.protocol}`);
  }
  let host = parsed.hostname.toLowerCase();
  // IPv6 literal hosts are wrapped in `[...]` by URL.hostname.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "" || host === "localhost") {
    throw new Error("forbidden_host: localhost");
  }
  if (host.includes(":")) {
    // IPv6 literal — block loopback, link-local (fe80::/10), and ULA (fc00::/7).
    if (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fe80:") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    ) {
      throw new Error("forbidden_host: ipv6_local");
    }
  }
  if (isPrivateIpv4(host)) {
    throw new Error("forbidden_host: private_ipv4");
  }
  return parsed;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
    nums.push(n);
  }
  const [a, b] = nums as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* fetchPage                                                                  */
/* -------------------------------------------------------------------------- */

export async function fetchPage(
  url: string,
  deps: FetchPageDeps,
): Promise<FetchedPage> {
  assertPublicHttpUrl(url);
  const maxBytes = deps.maxBytes ?? DEFAULT_PAGE_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();

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

  const ctRaw = resp.headers.get("content-type") ?? "application/octet-stream";
  const contentType = ctRaw.split(";")[0]!.trim().toLowerCase();

  if (!resp.ok) {
    return {
      text: "",
      contentType,
      fetchedAtSec: now,
      sourceBytes: 0,
      fetchError: `fetch_failed:${resp.status}`,
    };
  }

  // Pre-flight content-length check (cheap reject before consuming body).
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

  let text: string;
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    text = stripHtml(buf.toString("utf8"));
  } else if (contentType.startsWith("text/")) {
    text = buf.toString("utf8");
  } else {
    // For research, an unknown content-type isn't fatal — return empty
    // text with an explanatory `fetchError`. The synthesiser will mark
    // the source unavailable rather than aborting the whole report.
    return {
      text: "",
      contentType,
      fetchedAtSec: now,
      sourceBytes: buf.length,
      fetchError: `unsupported_content_type:${contentType}`,
    };
  }

  return { text, contentType, fetchedAtSec: now, sourceBytes: buf.length };
}
