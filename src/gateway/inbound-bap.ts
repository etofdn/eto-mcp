/**
 * Inbound BAP role — receives /search and /select POSTs from external Beckn
 * Application Providers, validates them against the Beckn v2.0 LTS schema
 * (FN-087), translates to on-chain Beckn instruction args, and submits
 * (currently STUBBED — real submission lands once eto-cli exposes the
 * subcommand).
 *
 * Spec: T-2.8.2.1 (FN-088). Sibling roles: outbound-bap (FN-089),
 * inbound-bpp (FN-090).
 *
 * ## Beckn v2.0 Envelope Pre-check (FN-074)
 *
 * Before the full Ajv schema validation runs, `validateBecknEnvelope` checks
 * four strict conformance rules and returns HTTP 400 with a NACK body on
 * violation:
 *
 *   - BAD_VERSION    : context.version is not exactly "2.0.0"
 *   - BAD_TIMESTAMP  : context.timestamp is absent or not a valid ISO-8601
 *                      datetime string (RFC 3339 subset)
 *   - BAD_TTL        : context.ttl is present but not a valid ISO-8601 duration
 *                      (e.g. "30 seconds" instead of "PT30S")
 *   - EXPIRED_TTL    : context.timestamp + context.ttl is in the past
 *
 * The existing `beckn_validation_failed` path (Ajv errors) is unchanged; the
 * NACK shape is used only for the four envelope codes above.
 */

import { createHash } from "crypto";

import express, { type Express, type Request, type Response, type Router } from "express";
import { validateBecknRequest } from "./beckn-schemas.js";
import type { BecknAction } from "./beckn-schemas.js";
import { becknError } from "./beckn.js";
import type { BecknOnSearchEnvelope } from "./inbound-bap-callback.js";

/** Injectable async function that POSTs an on_search callback to the BAP. */
export type PostOnSearchFn = (opts: { bap_uri: string; envelope: BecknOnSearchEnvelope }) => Promise<{ status: number; ok: boolean; attempts: number }>;

// ---------- Envelope pre-check types ----------

/** NACK response body shape for Beckn v2.0 envelope errors. */
export interface NackBody {
  message: { ack: { status: "NACK" } };
  error: {
    code: "BAD_VERSION" | "BAD_TIMESTAMP" | "BAD_TTL" | "EXPIRED_TTL";
    message: string;
  };
  context?: unknown;
}

// ---------- ISO-8601 duration parser ----------

/**
 * ISO-8601 / RFC 3339 duration regex.
 * Mirrors the ajv-formats "duration" pattern; fractional seconds are allowed.
 * Year (Y) and month (M) designators are deliberately rejected (they are
 * calendar-relative and cannot be safely converted to a fixed millisecond
 * offset for expiry math — see FN-074).
 */
const DURATION_REGEX =
  /^P(?!$)(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$/;

/**
 * Parse an ISO-8601 duration string into milliseconds.
 *
 * Year (Y) and month (M) designators are rejected (return `null`) because
 * they represent calendar-relative intervals that cannot be losslessly
 * converted to a fixed millisecond count for expiry arithmetic.
 *
 * Returns `null` if the string is not a valid duration or contains Y/M
 * designators.
 */
export function parseIso8601DurationMs(s: string): number | null {
  // Reject strings containing year (Y) or month (M) designators
  if (/\d+[YM]/.test(s)) return null;
  if (!DURATION_REGEX.test(s)) return null;

  const weeks = s.match(/([\d.]+)W/)?.[1];
  const days = s.match(/([\d.]+)D/)?.[1];
  const hours = s.match(/T.*?([\d.]+)H/)?.[1];
  const minutes = s.match(/T.*?([\d.]+)M/)?.[1];
  const seconds = s.match(/T.*?([\d.]+)S/)?.[1];

  const ms =
    (parseFloat(weeks ?? "0") * 7 * 24 * 60 * 60 +
      parseFloat(days ?? "0") * 24 * 60 * 60 +
      parseFloat(hours ?? "0") * 60 * 60 +
      parseFloat(minutes ?? "0") * 60 +
      parseFloat(seconds ?? "0")) *
    1000;

  return Number.isFinite(ms) ? ms : null;
}

// Strict ISO-8601 datetime regex (RFC 3339 subset)
// Requires full date + time + timezone — Date.parse alone is too permissive.
const DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Envelope-level Beckn v2.0 conformance check (FN-074).
 *
 * Runs before the full Ajv schema validator to catch protocol-level envelope
 * violations early and return a stable NACK shape with a machine-readable
 * error code.
 *
 * @param ctx   The value of `request.body.context` (may be any type).
 * @param now   Unix epoch ms to use as "now" (defaults to `Date.now()`).
 *              Inject in tests for deterministic expiry checks.
 */
export function validateBecknEnvelope(
  ctx: unknown,
  now?: number,
): { ok: true } | { ok: false; status: 400; body: NackBody } {
  const c = ctx as Record<string, unknown> | null | undefined;

  // 1. Version must be exactly "2.0.0"
  if (!c || c["version"] !== "2.0.0") {
    return {
      ok: false,
      status: 400,
      body: {
        message: { ack: { status: "NACK" } },
        error: {
          code: "BAD_VERSION",
          message: `context.version must be "2.0.0"; got ${JSON.stringify(c?.["version"])}`,
        },
        context: ctx,
      },
    };
  }

  // 2. Timestamp must be a valid ISO-8601 datetime string
  const ts = c["timestamp"];
  if (
    typeof ts !== "string" ||
    !DATETIME_REGEX.test(ts) ||
    Number.isNaN(Date.parse(ts))
  ) {
    return {
      ok: false,
      status: 400,
      body: {
        message: { ack: { status: "NACK" } },
        error: {
          code: "BAD_TIMESTAMP",
          message: `context.timestamp must be an ISO-8601 datetime; got ${JSON.stringify(ts)}`,
        },
        context: ctx,
      },
    };
  }

  // 3. TTL, when present, must be a valid ISO-8601 duration
  const ttl = c["ttl"];
  if (ttl !== undefined && ttl !== "") {
    const ttlMs = parseIso8601DurationMs(String(ttl));
    if (ttlMs === null) {
      return {
        ok: false,
        status: 400,
        body: {
          message: { ack: { status: "NACK" } },
          error: {
            code: "BAD_TTL",
            message: `context.ttl must be an ISO-8601 duration (e.g. "PT30S"); got ${JSON.stringify(ttl)}`,
          },
          context: ctx,
        },
      };
    }

    // 4. TTL expiry check: timestamp + ttl must not be in the past
    const expiresAt = Date.parse(ts) + ttlMs;
    const effectiveNow = now ?? Date.now();
    if (expiresAt < effectiveNow) {
      return {
        ok: false,
        status: 400,
        body: {
          message: { ack: { status: "NACK" } },
          error: {
            code: "EXPIRED_TTL",
            message: `envelope expired: timestamp ${ts} + ttl ${String(ttl)} = ${new Date(expiresAt).toISOString()} which is before now (${new Date(effectiveNow).toISOString()})`,
          },
          context: ctx,
        },
      };
    }
  }

  return { ok: true };
}

export type { BecknAction };

// ---------------------------------------------------------------------------
// On-chain search client interface
// ---------------------------------------------------------------------------

export interface OnChainSearchInput {
  networkId: Uint8Array;
  bapAuthority: Uint8Array;
  intentHash: string;
  tagFilter: string[];
  maxResponses: number;
  deadlineSlot: number;
}

export interface OnChainSearchOutput {
  tx_signature: string;
  intent_hash: string;
}

export interface OnChainSearchClient {
  search(input: OnChainSearchInput): Promise<OnChainSearchOutput>;
}

// ---------------------------------------------------------------------------
// Catalog response aggregator interface
// ---------------------------------------------------------------------------

export interface CatalogResponseView {
  bpp_id: string;
  bpp_uri: string;
  catalog: unknown;
}

export interface CatalogResponseAggregator {
  getResponses(intentHash: string, maxWaitMs: number): Promise<CatalogResponseView[]>;
}

// ---------------------------------------------------------------------------
// InboundBapRouterDeps — dependency injection surface for the BAP router
// ---------------------------------------------------------------------------

export interface InboundBapRouterDeps {
  onChainClient: OnChainSearchClient;
  aggregator: CatalogResponseAggregator;
  networkId: Uint8Array;
  bapAuthority: Uint8Array;
  bppId: string;
  bppUri: string;
  defaultDeadlineMs: number;
  postOnSearch?: PostOnSearchFn;
}

// ---------------------------------------------------------------------------
// Stub implementations for tests
// ---------------------------------------------------------------------------

export class StubOnChainSearchClient implements OnChainSearchClient {
  async search(input: OnChainSearchInput): Promise<OnChainSearchOutput> {
    return {
      tx_signature: sha256_hex(JSON.stringify(input)).slice(0, 64),
      intent_hash: input.intentHash,
    };
  }
}

export class FixtureCatalogResponseAggregator implements CatalogResponseAggregator {
  private responses: CatalogResponseView[];

  constructor(responses: CatalogResponseView[] = []) {
    this.responses = responses;
  }

  async getResponses(_intentHash: string, _maxWaitMs: number): Promise<CatalogResponseView[]> {
    return this.responses;
  }
}

// ---------------------------------------------------------------------------
// Pipeline functions
// ---------------------------------------------------------------------------

export function computeIntentHash(intent: unknown): string {
  return sha256_hex(canonicalJson(intent));
}

export async function runInboundBapPipeline(
  body: unknown,
  deps: InboundBapRouterDeps,
): Promise<void> {
  const b = body as Record<string, unknown>;
  const ctx = (b.context ?? {}) as Record<string, unknown>;
  const msg = (b.message ?? {}) as Record<string, unknown>;
  const intent = (msg.intent ?? {}) as Record<string, unknown>;

  const intentHash = computeIntentHash(intent);
  const tagFilter = extractTags(intent);

  await deps.onChainClient.search({
    networkId: deps.networkId,
    bapAuthority: deps.bapAuthority,
    intentHash,
    tagFilter,
    maxResponses: 10,
    deadlineSlot: 0,
  });

  const responses = await deps.aggregator.getResponses(intentHash, deps.defaultDeadlineMs);

  if (deps.postOnSearch) {
    const bapUri = typeof ctx.bap_uri === "string" ? ctx.bap_uri : "";
    const envelope: BecknOnSearchEnvelope = {
      context: {
        ...(ctx as object),
        action: "on_search" as const,
        bpp_id: deps.bppId,
        bpp_uri: deps.bppUri,
        timestamp: new Date().toISOString(),
      } as BecknOnSearchEnvelope["context"],
      message: { catalog: { providers: responses } },
    };
    // Fire-and-forget — don't block the ACK response
    void deps.postOnSearch({ bap_uri: bapUri, envelope }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

const bodyParser = express.json({ limit: "1mb" });

export function createInboundBapRouter(deps: InboundBapRouterDeps): Router {
  const router = express.Router();

  router.post("/search", bodyParser, async (req: Request, res: Response): Promise<void> => {
    const ct = req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      const { status, body } = becknError("BECKN_415", `Expected Content-Type application/json, got '${ct || "none"}'`, 415);
      res.status(status).json(body);
      return;
    }

    const v = validateBecknRequest("search", req.body);
    if (!v.ok) {
      const { status, body } = becknError("BECKN_400", `Invalid Beckn envelope: ${(v as { ok: false; errors: unknown[] }).errors.map((e: unknown) => String(e)).join("; ")}`, 400);
      res.status(status).json(body);
      return;
    }

    // ACK synchronously per Beckn spec
    res.status(200).json({ message: { ack: { status: "ACK" } } });

    // Pipeline runs asynchronously (fire-and-forget)
    void runInboundBapPipeline(req.body, deps).catch((err: unknown) => {
      console.error("[inbound-bap] pipeline error", err);
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Legacy deps interface (kept for backward compat)
// ---------------------------------------------------------------------------

export interface InboundBapDeps {
  /** Submit an on-chain Beckn instruction. STUBBED today. */
  submitOnChain: (action: BecknAction, args: unknown) => Promise<{ tx_signature: string }>;
  /** Resolve catalog responses for a SearchIntent. STUBBED today. */
  pollCatalogResponses?: (intent_hash: string, max: number) => Promise<unknown[]>;
}

export function mountInboundBap(app: Express, deps: InboundBapDeps): void {
  app.post("/search", async (req: Request, res: Response) => {
    const envResult = validateBecknEnvelope((req.body as Record<string, unknown> | undefined)?.context);
    if (!envResult.ok) {
      res.status(envResult.status).json(envResult.body);
      return;
    }
    const v = validateBecknRequest("search", req.body);
    if (!v.ok) {
      res.status(400).json({
        error: "beckn_validation_failed",
        details: v.errors,
      });
      return;
    }
    try {
      const onchain_args = becknSearchToOnChainArgs(req.body);
      const { tx_signature } = await deps.submitOnChain("search", onchain_args);
      // ACK is async per Beckn spec — return 202 with the in-flight transaction id
      res.status(202).json({
        message: { ack: { status: "ACK" } },
        context: (req.body as Record<string, unknown>).context,
        tx_signature,
      });
    } catch (err) {
      res.status(500).json({ error: "on_chain_submission_failed", details: String(err) });
    }
  });

  app.post("/select", async (req: Request, res: Response) => {
    const envResult = validateBecknEnvelope((req.body as Record<string, unknown> | undefined)?.context);
    if (!envResult.ok) {
      res.status(envResult.status).json(envResult.body);
      return;
    }
    const v = validateBecknRequest("select", req.body);
    if (!v.ok) {
      res.status(400).json({ error: "beckn_validation_failed", details: v.errors });
      return;
    }
    try {
      const onchain_args = becknSelectToOnChainArgs(req.body);
      const { tx_signature } = await deps.submitOnChain("select", onchain_args);
      res.status(202).json({
        message: { ack: { status: "ACK" } },
        context: (req.body as Record<string, unknown>).context,
        tx_signature,
      });
    } catch (err) {
      res.status(500).json({ error: "on_chain_submission_failed", details: String(err) });
    }
  });
}

/** Translate Beckn /search payload → on-chain Search instruction args. */
export function becknSearchToOnChainArgs(body: unknown): Record<string, unknown> {
  // The on-chain `BecknProgram::Search` (FN-050) takes:
  //   { network_id, bap_id, intent_hash, tag_filter, max_responses, deadline_slot }
  // We derive intent_hash = sha256(canonical_json(message.intent)), use the
  // BAP's pubkey from context.bap_id (registry lookup left as TODO for the
  // operator runbook).
  const b = body as Record<string, unknown>;
  const ctx = (b.context ?? {}) as Record<string, unknown>;
  const msg = (b.message ?? {}) as Record<string, unknown>;
  const intent = (msg.intent ?? {}) as Record<string, unknown>;
  const intent_hash = sha256_hex(canonicalJson(intent));
  return {
    network_id: deriveNetworkId(typeof ctx.domain === "string" ? ctx.domain : undefined),
    bap_id: ctx.bap_id,
    intent_hash,
    tag_filter: extractTags(intent),
    max_responses: typeof intent.max_responses === "number" ? intent.max_responses : 10,
    deadline_slot: typeof ctx.ttl_slot === "number" ? ctx.ttl_slot : 0,
  };
}

export function becknSelectToOnChainArgs(body: unknown): Record<string, unknown> {
  const b = body as Record<string, unknown>;
  const ctx = (b.context ?? {}) as Record<string, unknown>;
  const msg = (b.message ?? {}) as Record<string, unknown>;
  const order = (msg.order ?? {}) as Record<string, unknown>;
  const provider = (order.provider ?? {}) as Record<string, unknown>;
  return {
    bap_id: ctx.bap_id,
    // bridge's responsibility to map provider.id → CatalogResponse PDA
    catalog_response_pda: provider.id,
    network: deriveNetworkId(typeof ctx.domain === "string" ? ctx.domain : undefined),
  };
}

// --- helpers (extracted so they're individually unit-testable) ---

export function sha256_hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function canonicalJson(obj: unknown): string {
  // Stable key ordering for content-addressed hashing
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(obj as object).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((obj as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

export function deriveNetworkId(domain: string | undefined): string {
  if (!domain) return "0".repeat(64);
  return sha256_hex(domain);
}

export function extractTags(intent: unknown): string[] {
  if (!intent || typeof intent !== "object") return [];
  const i = intent as Record<string, unknown>;
  const tags: string[] = [];
  const category = i.category as Record<string, unknown> | undefined;
  const descriptor = category?.descriptor as Record<string, unknown> | undefined;
  if (typeof descriptor?.code === "string") tags.push(descriptor.code);
  if (Array.isArray(i.tags)) {
    for (const t of i.tags) {
      if (typeof t === "string") {
        // Simple string tag (internal use)
        tags.push(t);
      } else if (t && typeof t === "object") {
        // Beckn v2.0 Tag object — extract descriptor.code if present
        const tag = t as Record<string, unknown>;
        const td = tag.descriptor as Record<string, unknown> | undefined;
        if (typeof td?.code === "string") tags.push(td.code);
      }
    }
  }
  return tags;
}

/** Default stub for `submitOnChain` — used by the bridge when no real chain client is wired. */
export const stubSubmit: InboundBapDeps["submitOnChain"] = async (action, args) => {
  const tx_signature = sha256_hex(action + JSON.stringify(args)).slice(0, 64);
  console.log(`[STUB] would submit ${action} on-chain — tx=${tx_signature}`);
  return { tx_signature };
};
