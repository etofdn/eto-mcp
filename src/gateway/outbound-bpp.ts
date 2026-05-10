/**
 * Outbound BPP role — T-2.8.2.4 (FN-091).
 *
 * When an external Beckn Application Platform (BAP) POSTs `/search` to our
 * bridge (inbound-bap.ts, FN-088), the bridge submits an on-chain `Search`
 * instruction and `CatalogResponse` PDAs eventually appear on chain. This
 * module completes the loop: it
 *
 *   (a) discovers `CatalogResponse` accounts for a given `intent_hash` via an
 *       injectable `getCatalogResponses` stub/implementation,
 *   (b) builds a Beckn v2.0 LTS `/on_search` envelope, and
 *   (c) POSTs it back to the originating BAP at its `bap_uri`.
 *
 * Design notes:
 *  - Pure dispatcher — no chain code, no scheduler, no global server
 *    side-effects. All dependencies are injected via `OutboundBppDeps`.
 *  - SSRF guard: `bap_uri` is operator-supplied and must be screened before
 *    any outbound HTTP call. Private/loopback hosts are blocked by default;
 *    set `ETO_BECKN_ALLOW_PRIVATE_CALLBACKS=1` or `deps.allowPrivateCallbacks`
 *    to bypass in test environments.
 *  - `exactOptionalPropertyTypes` compliance: all optional `BecknContext`
 *    fields are copied with conditional spreads.
 *  - `bigint` fields (`price_quote`, `created_slot`) in `BppCatalogRow` must
 *    be serialised via the bigint replacer before calling `JSON.stringify`.
 *  - Wiring `dispatchOnSearch` into `inbound-bap.ts`'s `/search` pipeline is
 *    intentionally out of scope — see the follow-up task filed in FN-091.
 *
 * ## Environment variables
 *  - `BRIDGE_BPP_ID`   — identity of this BPP bridge (default "bridge.eto.network")
 *  - `BRIDGE_BPP_URI`  — callback root of this BPP bridge (default "https://bridge.eto.network")
 *  - `ETO_BECKN_ALLOW_PRIVATE_CALLBACKS=1` — bypass SSRF guard (test/dev only)
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { z } from "zod";
import type { BecknContext } from "./beckn.js";

/**
 * FN-079: DNS-aware SSRF guard. The string-only `isPrivateOrLoopbackHost`
 * is bypassable via DNS rebinding (`attacker.com` resolving to 127.0.0.1
 * at request time passes the string check). This async helper resolves the
 * hostname and checks the resolved IP against the same private/reserved
 * ranges, closing the rebinding hole.
 *
 * `lookup` is injectable for tests so they don't hit real DNS.
 */
export type DnsLookupFn = (hostname: string) => Promise<{ address: string; family: number }>;

export async function isPrivateOrLoopbackHostResolved(
  hostname: string,
  lookup: DnsLookupFn = (h) => dnsLookup(h),
): Promise<boolean> {
  // First, the synchronous IP-literal / localhost / .local check still applies
  // — these never need DNS resolution.
  if (isPrivateOrLoopbackHost(hostname)) return true;
  // If hostname is already a literal IP that the sync check ruled "public",
  // we're done — no DNS resolution needed.
  const stripped = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(stripped) !== 0) return false;
  // Otherwise the hostname is a DNS name; resolve it and re-check.
  let resolved: { address: string; family: number };
  try {
    resolved = await lookup(hostname);
  } catch {
    // Refuse to ship to a host we cannot resolve — fail closed.
    return true;
  }
  return isPrivateOrLoopbackHost(resolved.address);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * BPP-centric view of an on-chain `CatalogResponse` account, formatted for
 * use in the outbound `/on_search` callback.
 *
 * This type is distinct from `CatalogResponseView` in `inbound-bap.ts`, which
 * is the raw chain-account projection. `BppCatalogRow` is the provider-level
 * view used to assemble the human-readable Beckn catalog returned to BAPs.
 *
 * bigint fields (`price_quote`, `created_slot`) must be serialised with the
 * bigint replacer `(_, v) => typeof v === "bigint" ? v.toString() : v` before
 * calling `JSON.stringify` — see `stringifyBppEnvelope()`.
 */
export interface BppCatalogRow {
  /** Beckn provider ID (string, e.g. "bpp.example.com"). */
  bpp_id: string;
  /** Provider identifier scoped to the BPP. */
  provider_id: string;
  /** Optional human-readable descriptor for the provider. */
  descriptor?: { name?: string; code?: string };
  /** Optional list of catalog items offered by this provider. */
  items?: unknown[];
  /** Quoted price (u64 on-chain, bigint in TS). May be null/absent. */
  price_quote?: bigint | null;
  /** Slot at which this catalog response was created (u64, bigint). */
  created_slot: bigint;
  /** Optional URI of the off-chain catalog payload. */
  catalog_uri?: string | null;
  /** Optional hex hash of the catalog payload for integrity verification. */
  catalog_hash?: string | null;
}

/**
 * Beckn `on_search` response envelope produced by the outbound BPP dispatcher.
 *
 * Uses `Omit<BecknContext, "action"> & { action: "on_search" }` to override
 * the narrow `BecknAction` union type without hitting the `BecknContext &
 * { action: "on_search" }` reduction to `never`.
 *
 * Providers in `message.catalog.providers` are grouped by `provider_id`
 * (aggregated from multiple `BppCatalogRow` entries with the same ID), so
 * each entry represents a unique BPP provider with its merged item list.
 */
export type BppOnSearchEnvelope = {
  context: Omit<BecknContext, "action"> & { action: "on_search" };
  message: {
    catalog: {
      providers: Array<{
        id: string;
        descriptor?: object;
        items?: unknown[];
      }>;
    };
  };
};

/**
 * Injectable dependency bag for the outbound BPP dispatcher.
 *
 * All outbound HTTP and chain-read operations are injected so the module is
 * fully unit-testable without a live chain or network.
 */
export interface OutboundBppDeps {
  /**
   * Fetches `CatalogResponse` records from the on-chain program for the given
   * `intent_hash`. Returns an empty array when no responses exist yet.
   *
   * The real implementation (a follow-up task) will scan the Solana account
   * index for `CatalogResponse` PDAs derived from the SearchIntent PDA.
   * Use `stubGetCatalogResponses` until it lands.
   */
  getCatalogResponses: (intent_hash: string) => Promise<BppCatalogRow[]>;

  /**
   * Performs the outbound HTTP POST. Called with the fully-constructed
   * `/on_search` URL and the serialisable envelope body.
   *
   * Per-attempt timeout is the responsibility of this function; `postBppOnSearch`
   * supplies only the URL and body. In production, wrap with retry/backoff logic.
   * Returns `attempts` for observability (callers can log slow retries).
   *
   * Signature matches the injectable HTTP client pattern used across the Beckn
   * bridge gateway modules.
   */
  postBecknRequest: (
    url: string,
    body: object,
  ) => Promise<{ status: number; body: unknown; attempts: number }>;

  /**
   * Clock injection for deterministic tests.
   * @default () => new Date()
   */
  now?: () => Date;

  /**
   * UUID v4 generator for `message_id`.
   * @default crypto.randomUUID
   */
  randomUUID?: () => string;

  /**
   * Override for `ETO_BECKN_ALLOW_PRIVATE_CALLBACKS`. When `true`, the SSRF
   * guard allows loopback/RFC-1918/`.local` hosts. Primarily for tests.
   * @default false
   */
  allowPrivateCallbacks?: boolean;

  /**
   * FN-079: injectable DNS lookup for the SSRF guard. Defaults to
   * `node:dns/promises.lookup`. Tests pass a stub so they don't hit
   * real DNS.
   */
  dnsLookup?: DnsLookupFn;
}

// ---------------------------------------------------------------------------
// on_search envelope validation schema (zod)
//
// beckn-schemas.ts (FN-087) is not present in this branch, so we define the
// on_search schema locally. The schema validates the minimum required fields
// per Beckn v2.0 LTS before shipping the envelope to the BAP.
// ---------------------------------------------------------------------------

const bppOnSearchContextSchema = z
  .object({
    domain: z.string().min(1),
    action: z.literal("on_search"),
    version: z.string().min(1),
    bap_id: z.string().min(1),
    bap_uri: z.string().url(),
    transaction_id: z.string().uuid(),
    message_id: z.string().uuid(),
    timestamp: z.string().datetime(),
  })
  .passthrough();

const bppOnSearchProviderSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

const bppOnSearchEnvelopeSchema = z.object({
  context: bppOnSearchContextSchema,
  message: z.object({
    catalog: z.object({
      providers: z.array(bppOnSearchProviderSchema).min(1),
    }),
  }),
});

/**
 * Validate an outbound `on_search` envelope against the Beckn v2.0 LTS
 * minimum schema. Returns `{ ok: true }` on success or `{ ok: false, error }`
 * on failure.
 *
 * Called by `postBppOnSearch` before each outbound POST to prevent shipping
 * malformed callbacks and to keep the conformance suite honest.
 */
export function validateOnSearchEnvelope(env: unknown): {
  ok: boolean;
  error?: string;
} {
  const result = bppOnSearchEnvelopeSchema.safeParse(env);
  if (result.success) return { ok: true };
  const msg = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { ok: false, error: msg };
}

// ---------------------------------------------------------------------------
// Envelope builder
// ---------------------------------------------------------------------------

/**
 * Build a Beckn v2.0 LTS `on_search` envelope from the inbound `/search`
 * context and a list of `BppCatalogRow` records retrieved from chain.
 *
 * Key behaviours:
 *  - Reuses `transaction_id` from the original BAP request so the BAP can
 *    correlate this callback with its outgoing `/search`.
 *  - Generates a fresh `message_id` (the callback is a new message).
 *  - Groups multiple `BppCatalogRow` entries with the same `provider_id` into
 *    a single `providers[]` entry, merging their `items` arrays.
 *  - Uses conditional spreads for optional `BecknContext` fields to satisfy
 *    `exactOptionalPropertyTypes` (`bpp_id`, `bpp_uri`, `ttl`, `location`).
 */
export function buildBppOnSearchEnvelope(
  originalRequestContext: BecknContext,
  rows: BppCatalogRow[],
  opts: {
    now?: () => Date;
    randomUUID?: () => string;
  } = {},
): BppOnSearchEnvelope {
  const now = opts.now ?? (() => new Date());
  const uuid = opts.randomUUID ?? nodeRandomUUID;

  const bppId = process.env["BRIDGE_BPP_ID"] ?? "bridge.eto.network";
  const bppUri = process.env["BRIDGE_BPP_URI"] ?? "https://bridge.eto.network";

  // Group rows by provider_id, merging items from each row.
  const providerMap = new Map<
    string,
    { id: string; descriptor?: object; items: unknown[] }
  >();

  for (const row of rows) {
    const existing = providerMap.get(row.provider_id);
    if (existing) {
      // Merge items from this row into the existing provider entry.
      if (row.items && row.items.length > 0) {
        existing.items.push(...row.items);
      }
    } else {
      const entry: { id: string; descriptor?: object; items: unknown[] } = {
        id: row.provider_id,
        items: row.items ? [...row.items] : [],
      };
      if (row.descriptor !== undefined) {
        entry.descriptor = row.descriptor;
      }
      providerMap.set(row.provider_id, entry);
    }
  }

  const providers = Array.from(providerMap.values()).map((p) => {
    const out: { id: string; descriptor?: object; items?: unknown[] } = {
      id: p.id,
    };
    if (p.descriptor !== undefined) {
      out.descriptor = p.descriptor;
    }
    if (p.items.length > 0) {
      out.items = p.items;
    }
    return out;
  });

  // Build context with conditional spreads for exactOptionalPropertyTypes.
  const context: BppOnSearchEnvelope["context"] = {
    domain: originalRequestContext.domain,
    action: "on_search",
    version: "2.0.0",
    bap_id: originalRequestContext.bap_id,
    bap_uri: originalRequestContext.bap_uri,
    transaction_id: originalRequestContext.transaction_id,
    message_id: uuid(),
    timestamp: now().toISOString(),
    bpp_id: bppId,
    bpp_uri: bppUri,
    ...(originalRequestContext.ttl !== undefined
      ? { ttl: originalRequestContext.ttl }
      : {}),
    ...(originalRequestContext.location !== undefined
      ? { location: originalRequestContext.location }
      : {}),
  };

  return {
    context,
    message: { catalog: { providers } },
  };
}

/**
 * JSON serialiser for `BppOnSearchEnvelope` that handles `bigint` fields
 * safely. `JSON.stringify` throws on `bigint` by default; any `BppCatalogRow`
 * data embedded in the envelope (e.g. during debug logging) must pass through
 * this replacer.
 *
 * Round-trip note: bigint values become JSON strings (e.g. `12345n` → `"12345"`).
 * Callers that need numeric precision on the receiving end must parse these strings
 * as `BigInt` or use a codec-aware deserialiser.
 */
export function stringifyBppEnvelope(env: BppOnSearchEnvelope): string {
  return JSON.stringify(env, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/** RFC-1918, loopback, and link-local IPv4 prefix pattern. */
const PRIVATE_IPV4_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/;

/** IPv6 loopback, unique-local (fc00::/7), and link-local (fe80::/10) pattern. */
const PRIVATE_IPV6_RE = /^(::1$|fc|fd|fe80:)/i;

/**
 * Returns `true` if the hostname is a loopback, RFC-1918 private, link-local,
 * or `.local` mDNS address that should never receive outbound bridge callbacks.
 *
 * Matched ranges:
 *  - `localhost` (name)
 *  - `*.local` (mDNS / Zeroconf)
 *  - IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *           169.254.0.0/16 (link-local), 0.0.0.0
 *  - IPv6: ::1 (loopback), fc00::/7 (unique-local), fe80::/10 (link-local)
 *
 * Uses `node:net.isIP` to distinguish IPv4/IPv6 literals from DNS names,
 * then applies regex-based prefix checks. No new npm deps required.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  // Strip IPv6 brackets used in URLs: [::1] → ::1
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  if (h === "localhost") return true;
  if (h.endsWith(".local")) return true;

  const ipVersion = isIP(h);

  if (ipVersion === 4) {
    return PRIVATE_IPV4_RE.test(h);
  }

  if (ipVersion === 6) {
    return PRIVATE_IPV6_RE.test(h);
  }

  // DNS name — not an IP, not localhost, not .local: allow.
  return false;
}

// ---------------------------------------------------------------------------
// postBppOnSearch
// ---------------------------------------------------------------------------

/** Result returned by `postBppOnSearch`. */
export interface PostBppOnSearchResult {
  status: number;
  ok: boolean;
  attempts: number;
  reason?: string;
}

/**
 * POST a Beckn `on_search` envelope to the originating BAP.
 *
 * Checks (in order):
 *  1. `bap_uri` must parse as a valid `http:` or `https:` URL.
 *  2. The hostname must not be private/loopback (unless `deps.allowPrivateCallbacks`
 *     or `ETO_BECKN_ALLOW_PRIVATE_CALLBACKS=1`).
 *  3. The envelope must pass `validateOnSearchEnvelope` (prevents shipping
 *     malformed Beckn callbacks and keeps the conformance suite honest).
 *  4. The target URL is constructed: if `bap_uri` does not already end with
 *     `/on_search`, we append `/on_search` (per Beckn v2.0 LTS convention
 *     that `bap_uri` is the callback root).
 *
 * Per-attempt timeout is the responsibility of `deps.postBecknRequest`.
 * This function provides only the URL + body; retry/backoff policy lives
 * in the injected HTTP client implementation.
 *
 * @returns A result object — never throws after the SSRF guard passes.
 */
export async function postBppOnSearch(
  opts: { bap_uri: string; envelope: BppOnSearchEnvelope },
  deps: OutboundBppDeps,
): Promise<PostBppOnSearchResult> {
  const { bap_uri, envelope } = opts;

  // 1. Parse and scheme-validate the URI.
  let parsed: URL;
  try {
    parsed = new URL(bap_uri);
  } catch {
    return { status: 0, ok: false, attempts: 0, reason: "bad_bap_uri" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: 0, ok: false, attempts: 0, reason: "bad_bap_uri" };
  }

  // 2. SSRF guard.
  const allowPrivate =
    deps.allowPrivateCallbacks === true ||
    process.env["ETO_BECKN_ALLOW_PRIVATE_CALLBACKS"] === "1";

  if (!allowPrivate && (await isPrivateOrLoopbackHostResolved(parsed.hostname, deps.dnsLookup))) {
    return { status: 0, ok: false, attempts: 0, reason: "ssrf_blocked" };
  }

  // 3. Self-validate the envelope before shipping.
  const validation = validateOnSearchEnvelope(envelope);
  if (!validation.ok) {
    return { status: 0, ok: false, attempts: 0, reason: "envelope_invalid" };
  }

  // 4. Construct the target URL (append /on_search if needed).
  const targetUrl = bap_uri.endsWith("/on_search")
    ? bap_uri
    : bap_uri.replace(/\/?$/, "/on_search");

  // 5. Delegate to the injected HTTP client.
  const result = await deps.postBecknRequest(targetUrl, envelope);
  return {
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    attempts: result.attempts,
  };
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Stub `getCatalogResponses` implementation — always returns an empty array.
 *
 * Used by callers that have not yet wired the real chain reader
 * (e.g. integration tests and the initial FN-093 deploy stub).
 * Replace with a real implementation that scans `CatalogResponse` PDAs
 * from the Solana account index once the chain reader is available.
 */
export const stubGetCatalogResponses: OutboundBppDeps["getCatalogResponses"] =
  async (_intent_hash: string): Promise<BppCatalogRow[]> => [];

// ---------------------------------------------------------------------------
// dispatchOnSearch — orchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full outbound BPP callback:
 *  1. Fetch `CatalogResponse` rows for `intent_hash` via `deps.getCatalogResponses`.
 *  2. If no rows, short-circuit (Beckn spec requires at least one provider).
 *  3. Otherwise, build the `on_search` envelope and POST it to the BAP.
 *
 * @param originalRequestContext — the `BecknContext` from the inbound `/search`
 *   request, used to copy `bap_uri`, `transaction_id`, `domain`, etc.
 * @param intent_hash — sha256 hex of the canonical search intent; used as the
 *   chain-reader lookup key.
 * @param deps — injectable dependency bag.
 *
 * @returns `{ providers, result }` where `providers` is the count of unique
 *   providers assembled into the envelope (0 if none) and `result` is the
 *   POST outcome from `postBppOnSearch`.
 */
export async function dispatchOnSearch(
  originalRequestContext: BecknContext,
  intent_hash: string,
  deps: OutboundBppDeps,
): Promise<{
  providers: number;
  result: PostBppOnSearchResult;
}> {
  const rows = await deps.getCatalogResponses(intent_hash);

  if (rows.length === 0) {
    return {
      providers: 0,
      result: {
        status: 0,
        ok: false,
        attempts: 0,
        reason: "no_catalog_responses",
      },
    };
  }

  const envelope = buildBppOnSearchEnvelope(originalRequestContext, rows, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.randomUUID !== undefined ? { randomUUID: deps.randomUUID } : {}),
  });

  const result = await postBppOnSearch(
    { bap_uri: originalRequestContext.bap_uri, envelope },
    deps,
  );

  // Count unique providers in the built envelope.
  const providerCount = envelope.message.catalog.providers.length;

  return { providers: providerCount, result };
}
