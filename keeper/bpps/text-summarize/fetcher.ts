/**
 * Source fetcher for the `text:summarize` BPP (FN-075).
 *
 * Resolves a `SummarizeSource` to plain text:
 *  - `kind: "text"` returns the input directly.
 *  - `kind: "url"` performs a `fetch(url)` (with a 30s `AbortController`
 *    timeout and a streaming-cap of `maxBytes`, default 4 MB) and
 *    dispatches by content-type:
 *       text/html              → strip tags via a small regex extractor
 *       text/plain | markdown  → pass-through
 *       application/pdf        → invoke `pdfExtractor(buffer)`
 *  - `kind: "pdfBase64"` decodes and calls `pdfExtractor`.
 *
 * All side-effecting seams (`fetch`, `pdfExtractor`) are injected so
 * the test suite drives the path with deterministic stubs.
 *
 * **PDF extractor:** by default we ship the `noopPdfExtractor` (throws
 * `pdf_extraction_unavailable`); deploys that need PDF support inject
 * a real extractor backed by `pdf-parse` or similar. We deliberately
 * do NOT take a runtime dependency on `pdf-parse` — it pulls native
 * modules on some platforms and would inflate `keeper/`'s install
 * surface. This decision is documented in
 * `keeper/bpps/text-summarize/README.md`.
 */

import type { SummarizeSource } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export const DEFAULT_FETCH_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Structural subset of `globalThis.fetch` we depend on. */
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

export type PdfExtractor = (buf: Uint8Array) => Promise<string>;

export interface FetchSourceDeps {
  readonly fetch: FetchLike;
  readonly pdfExtractor: PdfExtractor;
  /** Override fetch timeout for tests. Defaults to 30s. */
  readonly fetchTimeoutMs?: number;
}

export interface FetchedSource {
  readonly text: string;
  readonly sourceBytes: number;
  readonly contentType: string;
}

/** Stub PDF extractor: throws unless an explicit one is injected. */
export const noopPdfExtractor: PdfExtractor = async () => {
  throw new Error("pdf_extraction_unavailable");
};

/* -------------------------------------------------------------------------- */
/* fetchSource                                                                */
/* -------------------------------------------------------------------------- */

export async function fetchSource(
  source: SummarizeSource,
  deps: FetchSourceDeps,
): Promise<FetchedSource> {
  switch (source.kind) {
    case "text":
      return {
        text: source.text,
        sourceBytes: Buffer.byteLength(source.text, "utf8"),
        contentType: "text/plain",
      };
    case "pdfBase64": {
      const buf = Buffer.from(source.data, "base64");
      const text = await deps.pdfExtractor(new Uint8Array(buf));
      return {
        text,
        sourceBytes: buf.length,
        contentType: "application/pdf",
      };
    }
    case "url":
      return await fetchUrl(source.url, source.maxBytes, deps);
  }
}

async function fetchUrl(
  url: string,
  maxBytesOpt: number | undefined,
  deps: FetchSourceDeps,
): Promise<FetchedSource> {
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
  let text: string;
  switch (ct) {
    case "application/pdf":
      text = await deps.pdfExtractor(new Uint8Array(buf));
      break;
    case "text/html":
    case "application/xhtml+xml":
      text = stripHtml(buf.toString("utf8"));
      break;
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      text = buf.toString("utf8");
      break;
    default:
      // Best-effort: treat unknown text/* as plain text, otherwise reject.
      if (ct.startsWith("text/")) {
        text = buf.toString("utf8");
      } else {
        throw new Error(`unsupported_content_type: ${ct}`);
      }
  }
  return { text, sourceBytes: buf.length, contentType: ct };
}

/* -------------------------------------------------------------------------- */
/* HTML → text (regex-only, no deps)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Strip HTML tags and condense whitespace. Removes `<script>` and
 * `<style>` blocks (including their content), then drops remaining
 * tags, decodes a small set of common entities, and collapses runs of
 * whitespace into single spaces / line breaks.
 *
 * This is intentionally lightweight — full HTML normalisation would
 * require a parser; for summarisation we just need readable prose.
 */
export function stripHtml(html: string): string {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:\s+[^>]*)?>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style(?:\s+[^>]*)?>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Convert block-level closers to newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|br|tr)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  // Decode a minimal set of named/numeric entities.
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/gi, "&");
  // Collapse whitespace.
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\s*\n\s*/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
