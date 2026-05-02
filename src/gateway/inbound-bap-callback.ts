/**
 * `on_search` callback — outbound HTTP POST from the inbound BAP role.
 *
 * After the bridge collects `CatalogResponse` records from BPPs on-chain, it
 * POSTs a Beckn `on_search` envelope back to the caller's `bap_uri`. This
 * module handles that egress path.
 *
 * ## SSRF guard
 *
 * `bap_uri` is caller-controlled. Without a guard, a malicious BAP could
 * direct the bridge to POST arbitrary JSON to any internal service. The guard
 * rejects URIs whose hostname resolves to loopback (127.0.0.0/8, ::1),
 * link-local (169.254.0.0/16, fe80::/10), RFC-1918 private ranges
 * (10/8, 172.16/12, 192.168/16), or `.local` mDNS names.
 *
 * Set `ETO_BECKN_ALLOW_PRIVATE_CALLBACKS=1` to bypass this guard in test
 * environments (e.g. when spinning up an ephemeral callback server on
 * 127.0.0.1).
 *
 * ## Retry semantics
 *
 * Default: `timeout_ms = 5000`, `retries = 2` (up to 3 attempts total).
 * Backoff: 200 ms then 400 ms between attempts. Each attempt has its own
 * `AbortController`-based timeout. Returns on the first 2xx; on exhaustion
 * returns with `ok: false`.
 *
 * This module is kept separate from `inbound-bap.ts` so:
 *   - the callback path is unit-testable in isolation via a fake `fetchImpl`,
 *   - FN-090 (Inbound BPP) can reuse it for its own callbacks.
 */
import type { CatalogResponseView } from "./inbound-bap.js";
import type { BecknContext } from "./beckn.js";

// ---------- Envelope type ----------

/**
 * Beckn `on_search` response envelope.
 *
 * We cannot use `BecknContext` directly because `BecknAction` does not include
 * `"on_search"` (FN-086's beckn.ts is out-of-scope to modify). We use `Omit`
 * to override the `action` discriminant without widening or conflicting with
 * the base union type.
 */
export type BecknOnSearchEnvelope = {
  context: Omit<BecknContext, "action"> & { action: "on_search" };
  message: { catalog: { providers: CatalogResponseView[] } };
};

// ---------- Typed errors ----------

/** Thrown when `bap_uri` fails the SSRF guard. */
export class CallbackTargetForbidden extends Error {
  readonly code = "CALLBACK_TARGET_FORBIDDEN" as const;
  constructor(reason: string) {
    super(`Callback target forbidden: ${reason}`);
    this.name = "CallbackTargetForbidden";
  }
}

/** Returned (not thrown) when every attempt times out. `ok` will be false. */
export class CallbackTimeout extends Error {
  readonly code = "CALLBACK_TIMEOUT" as const;
  constructor(attempts: number) {
    super(`Callback timed out after ${attempts} attempt(s)`);
    this.name = "CallbackTimeout";
  }
}

/** Returned (not thrown) when all retries are exhausted with non-2xx status. */
export class CallbackHttpError extends Error {
  readonly code = "CALLBACK_HTTP_ERROR" as const;
  readonly status: number;
  constructor(status: number, attempts: number) {
    super(
      `Callback returned HTTP ${status} after ${attempts} attempt(s)`,
    );
    this.name = "CallbackHttpError";
    this.status = status;
  }
}

// ---------- SSRF guard ----------

/** RFC-1918 / loopback / link-local IPv4 prefix patterns. */
const PRIVATE_IPV4_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/;

/** IPv6 loopback / link-local prefix. */
const PRIVATE_IPV6_RE = /^(::1$|fe80:)/i;

/**
 * Returns true if the hostname is in a private/loopback/link-local address
 * range or is a `.local` mDNS name.
 */
function isPrivateHost(hostname: string): boolean {
  // Strip IPv6 brackets.
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (h === "localhost") return true;
  if (PRIVATE_IPV4_RE.test(h)) return true;
  if (PRIVATE_IPV6_RE.test(h)) return true;
  if (h.endsWith(".local")) return true;
  return false;
}

/**
 * Validate `bap_uri` against the SSRF guard.
 *
 * Throws `CallbackTargetForbidden` if:
 *   - The URI is not a syntactically valid `http:` or `https:` URL, OR
 *   - The hostname resolves to a loopback/link-local/RFC-1918/`.local`
 *     address AND `ETO_BECKN_ALLOW_PRIVATE_CALLBACKS !== "1"`.
 */
export function validateCallbackUri(uri: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new CallbackTargetForbidden(`'${uri}' is not a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CallbackTargetForbidden(
      `protocol '${parsed.protocol}' is not http or https`,
    );
  }

  const allowPrivate = process.env["ETO_BECKN_ALLOW_PRIVATE_CALLBACKS"] === "1";
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new CallbackTargetForbidden(
      `hostname '${parsed.hostname}' is in a private/loopback/link-local range`,
    );
  }

  return parsed;
}

// ---------- Main export ----------

/**
 * POST a Beckn `on_search` envelope to the caller's `bap_uri`.
 *
 * @param opts.bap_uri       — target URL; validated by SSRF guard before first attempt.
 * @param opts.envelope      — the full `on_search` envelope to POST as JSON.
 * @param opts.timeout_ms    — per-attempt timeout (default 5000 ms).
 * @param opts.retries       — number of retries after the first attempt (default 2).
 * @param opts.fetchImpl     — injectable fetch for tests; falls back to global `fetch`.
 *
 * @returns `{ status, ok, attempts }` — never throws after the SSRF guard passes.
 *   The caller should check `ok` to determine success.
 *
 * @throws `CallbackTargetForbidden` — immediately, if the SSRF guard rejects the URI.
 */
export async function postOnSearch(opts: {
  bap_uri: string;
  envelope: BecknOnSearchEnvelope;
  timeout_ms?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; ok: boolean; attempts: number }> {
  const { bap_uri, envelope } = opts;
  const timeoutMs = opts.timeout_ms ?? 5_000;
  const maxAttempts = (opts.retries ?? 2) + 1; // retries=2 → 3 total
  const fetchFn = opts.fetchImpl ?? fetch;

  // SSRF guard — throws if the URI is forbidden.
  validateCallbackUri(bap_uri);

  // BigInt fields (price_quote, created_slot) must be serialised as strings
  // since JSON.stringify throws on BigInt values by default.
  const body = JSON.stringify(envelope, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const backoffs = [200, 400]; // ms between attempt 1→2 and 2→3

  let lastStatus = 0;
  let lastOk = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetchFn(bap_uri, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = resp.status;
      lastOk = resp.ok;

      if (resp.ok) {
        return { status: lastStatus, ok: true, attempts: attempt };
      }
      // Non-2xx — retry unless exhausted.
    } catch (err: unknown) {
      clearTimeout(timer);
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"))
      ) {
        lastStatus = 0;
        lastOk = false;
        // Timeout — retry unless exhausted.
      } else {
        // Network error — treat like a timeout.
        lastStatus = 0;
        lastOk = false;
      }
    }

    // Wait before next attempt.
    if (attempt < maxAttempts) {
      const delay = backoffs[attempt - 1] ?? 400;
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }

  return { status: lastStatus, ok: false, attempts: maxAttempts };
}
