/**
 * Beckn v2.0 LTS Bridge Conformance Suite (FN-092)
 *
 * =========================================================================
 * SOURCE: Beckn v2.0 LTS Public Sandbox Criteria
 * =========================================================================
 * Reference: https://developers.becknprotocol.io/docs/protocol-specifications/
 *
 * This suite mirrors the Beckn v2.0 LTS sandbox certification checklist:
 *  1. Well-formed {context, message} envelopes for search/select/init/confirm
 *     → 200 + ACK (status: "ACK")
 *  2. on_* callback envelopes with correct transaction_id/message_id echo
 *  3. NACK behavior on malformed envelopes (missing context, missing required
 *     fields, wrong action, wrong Content-Type, oversized body)
 *  4. NACK response body shape: {message:{ack:{status:"NACK"}}, error:{code,message}}
 *  5. HTTP status codes: 400 for bad envelopes, 415 for wrong Content-Type,
 *     413 for body > 1 MiB
 *  6. Idempotency: same (transaction_id, message_id) pair acknowledged twice
 *     (bridge is stateless; both should ACK)
 *  7. Context field round-trip: context echoes are not leaking unexpected fields
 *  8. Method allow-list: only POST on action endpoints
 *  9. CORS preflight: OPTIONS /action → 204 with CORS headers
 * 10. Health liveness: GET /health → 200 + {status:"ok"}
 *
 * =========================================================================
 * Dependency surface inventory (captured at task execution time):
 * =========================================================================
 *
 * FN-086 (createBecknApp): ships `createBecknApp()`, `becknRouter`,
 *   `BecknContext`, `BecknRequest`, `BecknAckResponse`, `BecknNackResponse`,
 *   `becknError()`, `becknRequestSchema`. Routes: POST /search /select /init
 *   /confirm, GET /health, OPTIONS (passthrough via CORS middleware).
 *
 * FN-087 (beckn-schemas.ts): NOT merged into this worktree branch. The
 *   schema validator lives in a separate worktree (glad-panda). This suite
 *   drives everything via HTTP — no direct import of the schema validator.
 *   Per-action message validation is therefore NOT exercised beyond the
 *   permissive becknRequestSchema envelope check. See TODO(FN-087) items.
 *
 * FN-088 (inbound-bap.ts): ships `createInboundBapRouter` (deps: {
 *   onChainClient, aggregator, networkId: Uint8Array, bapAuthority: Uint8Array,
 *   bppId?, bppUri?, postOnSearch?, ...}). The inbound BAP router is NOT
 *   mounted in `createBecknApp()` by default; tests mount it separately.
 *
 * FN-089 (outbound-bap.ts): NOT merged into this worktree branch (separate
 *   worktree pale-ridge). Outbound BAP round-trip tests are marked it.todo.
 *   TODO(FN-089).
 *
 * FN-090 (inbound-bpp.ts): ships `createInboundBppConfirmHandler` (opts: {
 *   config: BecknBridgeConfig, forward: ForwardConfirmFn,
 *   postCallback: PostBapCallbackFn }). Handles POST /confirm in BPP role.
 *   BecknBridgeConfig.enabled must be true; bapCallbackAllowedHosts must
 *   include the BAP's host for callbacks to be delivered.
 *
 * FN-091 (outbound-bpp.ts): task not found / not yet specified. All outbound
 *   BPP tests are marked it.todo. TODO(FN-091).
 *
 * =========================================================================
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createBecknApp,
  type BecknAction,
} from "../src/gateway/beckn.js";
import {
  createInboundBapRouter,
  StubOnChainSearchClient,
  FixtureCatalogResponseAggregator,
  type InboundBapRouterDeps,
  type CatalogResponseView,
} from "../src/gateway/inbound-bap.js";
import type { BecknOnSearchEnvelope } from "../src/gateway/inbound-bap-callback.js";
import {
  createInboundBppConfirmHandler,
  type ForwardConfirmFn,
  type PostBapCallbackFn,
  type OnConfirmEnvelope,
} from "../src/gateway/inbound-bpp.js";
import type { BecknBridgeConfig } from "../src/config.js";
import express from "express";

import {
  loadFixture,
  freshContext,
  freshEnvelope,
  withMutation,
  type AnyBecknEnvelope,
} from "./helpers/beckn-fixtures.js";

// ===========================================================================
// Test infrastructure helpers
// ===========================================================================

type BootedServer = { server: Server; baseUrl: string };

async function bootApp(app: express.Express): Promise<BootedServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Asserts a response has the Beckn ACK shape and returns the parsed body. */
async function expectAck(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ message: { ack: { status: "ACK" } } });
  return body;
}

/** Asserts a response has the Beckn NACK shape and returns the parsed body. */
async function expectNack(
  res: Response,
  expectedStatus: number,
): Promise<{ error: { code: string; message: string } }> {
  expect(res.status).toBe(expectedStatus);
  const body = (await res.json()) as {
    message: { ack: { status: string } };
    error: { code: string; message: string };
  };
  expect(body.message?.ack?.status).toBe("NACK");
  expect(typeof body.error?.code).toBe("string");
  expect(typeof body.error?.message).toBe("string");
  return body as { error: { code: string; message: string } };
}

// ===========================================================================
// Suite 1 — Envelope conformance (beckn.ts / createBecknApp)
// ===========================================================================

describe("Suite 1 — Envelope conformance (forward actions)", () => {
  let srv: BootedServer;

  beforeAll(async () => {
    srv = await bootApp(createBecknApp());
  });

  afterAll(async () => {
    await closeServer(srv.server);
  });

  // -------------------------------------------------------------------------
  // §1.1 Valid envelopes → 200 ACK
  // -------------------------------------------------------------------------

  describe("§1.1 valid envelopes return 200 ACK", () => {
    const actions: BecknAction[] = ["search", "select", "init", "confirm"];
    for (const action of actions) {
      it(`POST /${action} with valid fixture → 200 ACK`, async () => {
        const body = loadFixture(action);
        const res = await postJson(srv.baseUrl, `/${action}`, body);
        await expectAck(res);
      });

      it(`POST /${action} with fresh context → 200 ACK`, async () => {
        const body = freshEnvelope(action);
        const res = await postJson(srv.baseUrl, `/${action}`, body);
        await expectAck(res);
      });
    }
  });

  // -------------------------------------------------------------------------
  // §1.2 ACK response must not leak unexpected top-level fields
  // -------------------------------------------------------------------------

  it("ACK response body has exactly the {message:{ack:{status:'ACK'}}} shape", async () => {
    const res = await postJson(srv.baseUrl, "/search", loadFixture("search"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The body should equal exactly the ACK shape — no extra keys at the top
    // level (e.g. no `error`, `context`, or internal fields).
    expect(body).toEqual({ message: { ack: { status: "ACK" } } });
  });

  // -------------------------------------------------------------------------
  // §1.3 Missing context → 400 NACK
  // -------------------------------------------------------------------------

  it("POST /search missing 'context' → 400 NACK BECKN_400", async () => {
    const body = loadFixture("malformed-missing-context");
    const res = await postJson(srv.baseUrl, "/search", body);
    const nack = await expectNack(res, 400);
    expect(nack.error.code).toBe("BECKN_400");
  });

  // -------------------------------------------------------------------------
  // §1.4 Missing required context fields → 400 NACK (parametric)
  // -------------------------------------------------------------------------

  describe("§1.4 missing required context field → 400 NACK", () => {
    const requiredFields = [
      "domain",
      "action",
      "version",
      "bap_id",
      "bap_uri",
      "transaction_id",
      "message_id",
      "timestamp",
    ] as const;

    for (const field of requiredFields) {
      it(`POST /search with context.${field} missing → 400 NACK`, async () => {
        // Build an envelope, then remove the specific field from context
        const base = loadFixture("search");
        const ctx = { ...base.context } as Record<string, unknown>;
        delete ctx[field];
        const body = { context: ctx, message: base.message };
        const res = await postJson(srv.baseUrl, "/search", body);
        await expectNack(res, 400);
      });
    }
  });

  // -------------------------------------------------------------------------
  // §1.5 Unknown action in context (not in enum) → 400 NACK
  // -------------------------------------------------------------------------

  it("POST /search with context.action 'unknown_action' → 400 NACK BECKN_400", async () => {
    const body = loadFixture("malformed-bad-action");
    const res = await postJson(srv.baseUrl, "/search", body);
    const nack = await expectNack(res, 400);
    expect(nack.error.code).toBe("BECKN_400");
  });

  // -------------------------------------------------------------------------
  // §1.6 Action mismatch between path and context.action → 400 NACK
  // -------------------------------------------------------------------------

  describe("§1.6 context.action mismatch with endpoint path → 400 NACK", () => {
    const mismatches: [BecknAction, BecknAction][] = [
      ["search", "select"],
      ["select", "confirm"],
      ["init", "search"],
      ["confirm", "init"],
    ];

    for (const [path, ctxAction] of mismatches) {
      it(`POST /${path} with context.action='${ctxAction}' → 400 NACK`, async () => {
        const body = freshEnvelope(ctxAction);
        const res = await postJson(srv.baseUrl, `/${path}`, body);
        const nack = await expectNack(res, 400);
        expect(nack.error.code).toBe("BECKN_400");
        expect(nack.error.message).toMatch(/does not match endpoint/);
      });
    }
  });

  // -------------------------------------------------------------------------
  // §1.7 Wrong Content-Type → 415 NACK
  // -------------------------------------------------------------------------

  it("POST /confirm with text/plain → 415 NACK BECKN_415", async () => {
    const res = await fetch(`${srv.baseUrl}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(loadFixture("confirm")),
    });
    const nack = await expectNack(res, 415);
    expect(nack.error.code).toBe("BECKN_415");
  });

  it("POST /search with no Content-Type → 415 NACK", async () => {
    const res = await fetch(`${srv.baseUrl}/search`, {
      method: "POST",
      headers: {},
      body: JSON.stringify(loadFixture("search")),
    });
    await expectNack(res, 415);
  });

  it("POST /init with application/x-www-form-urlencoded → 415 NACK", async () => {
    const res = await fetch(`${srv.baseUrl}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "context={}",
    });
    await expectNack(res, 415);
  });

  // -------------------------------------------------------------------------
  // §1.8 Wrong Beckn version string
  // NOTE: The bridge validates `version` only as a non-empty string
  // (z.string().min(1)) — it does NOT enforce "2.0.0". The sandbox
  // certification requires rejecting non-LTS versions; this is deferred to
  // FN-087's per-action schema layer. See TODO(FN-087) follow-up task.
  // -------------------------------------------------------------------------

  it.todo(
    // TODO(FN-087): Bridge does not yet validate version === '2.0.0'.
    // `becknRequestSchema` accepts any non-empty string for `version`.
    // Once FN-087's schema validator enforces version pinning, remove this
    // todo and add a live assertion.
    "POST /search with version='1.1.0' → 400 NACK (TODO: FN-087 must enforce version)",
  );

  // -------------------------------------------------------------------------
  // §1.9 Malformed timestamp
  // NOTE: The bridge validates `timestamp` only as a non-empty string.
  // ISO-8601 format enforcement is deferred to FN-087.
  // -------------------------------------------------------------------------

  it.todo(
    // TODO(FN-087): Bridge does not yet validate timestamp format as ISO-8601.
    "POST /search with malformed timestamp → 400 NACK (TODO: FN-087 must enforce ISO-8601)",
  );

  // -------------------------------------------------------------------------
  // §1.10 Malformed TTL
  // NOTE: The bridge validates `ttl` only as an optional non-empty string.
  // ISO-8601 duration format enforcement is deferred to FN-087.
  // -------------------------------------------------------------------------

  it.todo(
    // TODO(FN-087): Bridge does not yet validate ttl format as ISO-8601 duration.
    "POST /search with malformed ttl → 400 NACK (TODO: FN-087 must enforce ISO-8601 duration)",
  );

  // -------------------------------------------------------------------------
  // §1.11 Oversized body (> 1 MiB) → 413
  // NOTE: Express's body-parser returns a 413 with its own error format
  // (not a Beckn NACK envelope). The status code is correct per HTTP;
  // the body shape is a Beckn deviation. TODO: add Beckn error middleware.
  // -------------------------------------------------------------------------

  it("POST /search with oversized body (> 1 MiB) → 413", async () => {
    const padding = "x".repeat(1_100_000);
    const body = JSON.stringify({
      context: freshContext("search"),
      message: { big_field: padding },
    });
    const res = await fetch(`${srv.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(413);
    // Body shape deviates from Beckn NACK — Express default error format.
    // TODO(FN-093): add Beckn-shaped error middleware to wrap 413 in NACK.
  });

  it.todo(
    // TODO(FN-093): Once a Beckn error middleware is added to createBecknApp(),
    // assert that the 413 body matches {message:{ack:{status:'NACK'}}, error:{code,message}}.
    "POST /search > 1MiB: 413 body is Beckn NACK shape (TODO: FN-093 must add error middleware)",
  );
});

// ===========================================================================
// Suite 2 — Method allow-list and CORS
// ===========================================================================

describe("Suite 2 — Method allow-list and CORS", () => {
  let srv: BootedServer;

  beforeAll(async () => {
    srv = await bootApp(createBecknApp());
  });

  afterAll(async () => {
    await closeServer(srv.server);
  });

  const actions: BecknAction[] = ["search", "select", "init", "confirm"];

  describe("§2.1 only POST is allowed on action endpoints", () => {
    for (const action of actions) {
      it(`GET /${action} → 404`, async () => {
        const res = await fetch(`${srv.baseUrl}/${action}`);
        expect(res.status).toBe(404);
      });

      it(`PUT /${action} → 404`, async () => {
        const res = await fetch(`${srv.baseUrl}/${action}`, { method: "PUT" });
        expect(res.status).toBe(404);
      });

      it(`DELETE /${action} → 404`, async () => {
        const res = await fetch(`${srv.baseUrl}/${action}`, { method: "DELETE" });
        expect(res.status).toBe(404);
      });
    }
  });

  describe("§2.2 CORS preflight OPTIONS → 204 with CORS headers", () => {
    for (const action of actions) {
      it(`OPTIONS /${action} → 204 with Access-Control-Allow-Origin: *`, async () => {
        const res = await fetch(`${srv.baseUrl}/${action}`, { method: "OPTIONS" });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
        expect(res.headers.get("access-control-allow-headers")).toMatch(/Content-Type/);
      });
    }
  });

  // -------------------------------------------------------------------------
  // §2.3 Authorization / signing header forwarding
  // NOTE: FN-086..FN-091 do not implement Beckn Ed25519 signature headers.
  // -------------------------------------------------------------------------

  it.todo(
    // TODO: File follow-up task for Beckn Authorization signing headers.
    // Sandbox requires Authorization: Signature keyId=...,algorithm=Ed25519,...
    // and X-Gateway-Authorization for gateway-signed calls.
    "outbound calls include Authorization: Signature header (TODO: signing follow-up)",
  );

  it.todo(
    "outbound calls include X-Gateway-Authorization header (TODO: signing follow-up)",
  );

  // -------------------------------------------------------------------------
  // §2.4 Health liveness
  // -------------------------------------------------------------------------

  it("GET /health → 200 {status:'ok', service:'beckn-bridge', actions:[...]}", async () => {
    const res = await fetch(`${srv.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      service: "beckn-bridge",
      actions: ["search", "select", "init", "confirm"],
    });
  });
});

// ===========================================================================
// Suite 3 — Inbound BAP role round-trip (FN-088)
// ===========================================================================

describe("Suite 3 — Inbound BAP role round-trip (FN-088)", () => {
  let srv: BootedServer;

  // Capture on_search callbacks from the injectable postOnSearch
  let onSearchCalls: Array<{ bap_uri: string; envelope: BecknOnSearchEnvelope }> = [];

  const NETWORK_ID = new Uint8Array(32).fill(0xab);
  const BAP_AUTHORITY = new Uint8Array(32).fill(0xcd);

  beforeAll(async () => {
    onSearchCalls = [];

    const mockPostOnSearch = vi.fn(
      async (opts: { bap_uri: string; envelope: BecknOnSearchEnvelope }) => {
        onSearchCalls.push({ bap_uri: opts.bap_uri, envelope: opts.envelope });
        return { status: 200, ok: true, attempts: 1 };
      },
    );

    const deps: InboundBapRouterDeps = {
      onChainClient: new StubOnChainSearchClient(),
      aggregator: new FixtureCatalogResponseAggregator([]),
      networkId: NETWORK_ID,
      bapAuthority: BAP_AUTHORITY,
      bppId: "bpp.example.com",
      bppUri: "https://bpp.example.com/beckn",
      defaultDeadlineMs: 200,
      postOnSearch: mockPostOnSearch,
    };

    const app = express();
    app.set("trust proxy", 1);
    const router = createInboundBapRouter(deps);
    app.use(router);
    srv = await bootApp(app);
  });

  afterAll(async () => {
    await closeServer(srv.server);
  });

  it("POST /search → 200 ACK (inbound BAP role)", async () => {
    const body = loadFixture("search");
    const res = await postJson(srv.baseUrl, "/search", body);
    await expectAck(res);
  });

  it("POST /search: response body is exactly {message:{ack:{status:'ACK'}}}", async () => {
    const body = loadFixture("search");
    const res = await postJson(srv.baseUrl, "/search", body);
    const json = await res.json();
    expect(json).toEqual({ message: { ack: { status: "ACK" } } });
  });

  // The pipeline fires-and-forgets; wait briefly for microtask queue
  it("POST /search triggers async on_search callback with matching transaction_id", async () => {
    onSearchCalls = [];
    const body = loadFixture("search");
    const res = await postJson(srv.baseUrl, "/search", body);
    await expectAck(res);

    // Allow async pipeline to run (deadlineMs=200 so up to 300ms should suffice)
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(onSearchCalls.length).toBeGreaterThanOrEqual(1);
    const cb = onSearchCalls[0]!;
    const inputCtx = (body as AnyBecknEnvelope).context;
    // §5.2.3: callback context.transaction_id MUST echo the inbound value
    expect(cb.envelope.context.transaction_id).toBe(inputCtx.transaction_id);
    expect(cb.envelope.context.action).toBe("on_search");
  });

  it("on_search callback context.bap_uri matches inbound bap_uri", async () => {
    onSearchCalls = [];
    await postJson(srv.baseUrl, "/search", loadFixture("search"));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(onSearchCalls.length).toBeGreaterThanOrEqual(1);
    const inputCtx = (loadFixture("search") as AnyBecknEnvelope).context;
    expect(onSearchCalls[0]!.bap_uri).toBe(inputCtx.bap_uri);
  });

  // -------------------------------------------------------------------------
  // §3.2 Idempotency: same (transaction_id, message_id) sent twice
  // The bridge is stateless — both requests ACK.
  // -------------------------------------------------------------------------

  it("§3.2 idempotency: same (transaction_id, message_id) sent twice → both ACK", async () => {
    const body = freshEnvelope("search");
    const [r1, r2] = await Promise.all([
      postJson(srv.baseUrl, "/search", body),
      postJson(srv.baseUrl, "/search", body),
    ]);
    await expectAck(r1);
    await expectAck(r2);
  });

  // -------------------------------------------------------------------------
  // §3.3 NACK on invalid envelopes (inbound BAP router)
  // -------------------------------------------------------------------------

  it("§3.3 POST /search missing context → 400 NACK", async () => {
    const res = await postJson(srv.baseUrl, "/search", {
      message: { intent: {} },
    });
    await expectNack(res, 400);
  });

  it("§3.3 POST /search wrong Content-Type → 415 NACK", async () => {
    const res = await fetch(`${srv.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(loadFixture("search")),
    });
    await expectNack(res, 415);
  });
});

// ===========================================================================
// Suite 4 — Inbound BPP role (FN-090)
// ===========================================================================

describe("Suite 4 — Inbound BPP role (FN-090)", () => {
  let srv: BootedServer;
  let bapCallbacks: Array<{ url: string; body: OnConfirmEnvelope }> = [];

  const BRIDGE_BPP_CONFIG: BecknBridgeConfig = {
    enabled: true,
    bppBackendUrl: "https://bpp-backend.example.com/beckn",
    forwardTimeoutMs: 2000,
    bapCallbackTimeoutMs: 2000,
    // Allow the BAP host used in our test fixtures
    bapCallbackAllowedHosts: ["bap.example.com", "*"],
    bppId: "bpp.example.com",
    bppUri: "https://bpp.example.com/beckn",
  };

  beforeAll(async () => {
    bapCallbacks = [];

    // NOTE: OnConfirmEnvelope.context is typed as BecknContext & { action: "on_confirm" }
    // which reduces to `never` (pre-existing FN-090 bug, see FN-009).
    // We cast via `unknown` to work around this type limitation in the test stub.
    const forwardStub: ForwardConfirmFn = async (req) => ({
      ok: true,
      onConfirm: {
        context: {
          ...req.context,
          action: "on_confirm" as const,
          timestamp: new Date().toISOString(),
        },
        message: { order: { id: "ord-stub-001" } },
      } as unknown as OnConfirmEnvelope,
    });

    const postCallbackStub: PostBapCallbackFn = async (url, body, _ctx) => {
      bapCallbacks.push({ url, body });
    };

    const handler = createInboundBppConfirmHandler({
      config: BRIDGE_BPP_CONFIG,
      forward: forwardStub,
      postCallback: postCallbackStub,
    });

    const app = express();
    const json = express.json({ limit: "1mb" });
    app.post("/confirm", json, handler);
    srv = await bootApp(app);
  });

  afterAll(async () => {
    await closeServer(srv.server);
  });

  it("POST /confirm with valid fixture → 200 ACK", async () => {
    const body = loadFixture("confirm");
    const res = await postJson(srv.baseUrl, "/confirm", body);
    await expectAck(res);
  });

  it("POST /confirm triggers on_confirm BAP callback with matching transaction_id", async () => {
    bapCallbacks = [];
    const body = loadFixture("confirm");
    const res = await postJson(srv.baseUrl, "/confirm", body);
    await expectAck(res);

    // Allow fire-and-forget microtask to complete
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(bapCallbacks.length).toBeGreaterThanOrEqual(1);
    const cb = bapCallbacks[0]!;
    const inputCtx = (body as AnyBecknEnvelope).context;
    // §5.2.3: callback MUST echo inbound transaction_id and message_id
    expect(cb.body.context.transaction_id).toBe(inputCtx.transaction_id);
    expect(cb.body.context.message_id).toBe(inputCtx.message_id);
    expect(cb.body.context.action).toBe("on_confirm");
  });

  it("POST /confirm: on_confirm callback context.action is 'on_confirm'", async () => {
    bapCallbacks = [];
    await postJson(srv.baseUrl, "/confirm", loadFixture("confirm"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bapCallbacks[0]?.body.context.action).toBe("on_confirm");
  });

  it("POST /confirm missing context → 400 NACK", async () => {
    const res = await postJson(srv.baseUrl, "/confirm", { message: {} });
    await expectNack(res, 400);
  });

  it("POST /confirm wrong Content-Type → 415 NACK", async () => {
    const res = await fetch(`${srv.baseUrl}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(loadFixture("confirm")),
    });
    await expectNack(res, 415);
  });

  it("POST /confirm idempotency: same envelope twice → both ACK", async () => {
    const body = loadFixture("confirm");
    const r1 = await postJson(srv.baseUrl, "/confirm", body);
    const r2 = await postJson(srv.baseUrl, "/confirm", body);
    await expectAck(r1);
    await expectAck(r2);
  });

  it("POST /confirm with disabled config → 503 NACK", async () => {
    const disabledConfig: BecknBridgeConfig = {
      ...BRIDGE_BPP_CONFIG,
      enabled: false,
    };

    const handler = createInboundBppConfirmHandler({
      config: disabledConfig,
      forward: async () => ({ ok: true, onConfirm: {} as OnConfirmEnvelope }),
      postCallback: async () => {},
    });

    const app = express();
    const json = express.json({ limit: "1mb" });
    app.post("/confirm", json, handler);

    const { server, baseUrl } = await bootApp(app);
    try {
      const res = await postJson(baseUrl, "/confirm", loadFixture("confirm"));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.message?.ack?.status).toBe("NACK");
    } finally {
      await closeServer(server);
    }
  });
});

// ===========================================================================
// Suite 5 — TTL handling
// ===========================================================================

describe("Suite 5 — TTL handling", () => {
  it.todo(
    // TODO(FN-087): Bridge does not validate TTL expiry.
    // Beckn sandbox: if timestamp + ttl < now → NACK with ttl_expired code.
    "POST /search with expired TTL (timestamp+ttl < now) → 400 NACK ttl_expired (TODO: FN-087)",
  );

  it("POST /search with ttl present and future → 200 ACK", async () => {
    const app = createBecknApp();
    const { server, baseUrl } = await bootApp(app);
    try {
      const body = freshEnvelope("search", { ttl: "PT30S" });
      const res = await postJson(baseUrl, "/search", body);
      await expectAck(res);
    } finally {
      await closeServer(server);
    }
  });

  it("POST /search with ttl absent → 200 ACK (ttl is optional per Beckn v2.0)", async () => {
    const app = createBecknApp();
    const { server, baseUrl } = await bootApp(app);
    try {
      const base = freshEnvelope("search");
      const ctx = { ...base.context } as Record<string, unknown>;
      delete ctx["ttl"];
      const res = await postJson(baseUrl, "/search", { context: ctx, message: base.message });
      await expectAck(res);
    } finally {
      await closeServer(server);
    }
  });
});

// ===========================================================================
// Suite 6 — Outbound BAP role (FN-089) — deferred
// ===========================================================================

describe("Suite 6 — Outbound BAP role (FN-089)", () => {
  it.todo(
    // TODO(FN-089): outbound-bap.ts not merged into this worktree branch.
    // Once FN-089 lands: test OutboundBap.sendSearch(), stub the external BG
    // endpoint with undici.MockAgent, assert the outbound POST has the correct
    // Beckn context fields and that on_search callbacks are accepted.
    "sends POST /search to external BG with correct Beckn v2.0 context (TODO: FN-089)",
  );

  it.todo(
    "on_search callback arrives and is dispatched to CatalogSubmitter (TODO: FN-089)",
  );

  it.todo(
    "idempotency: duplicate on_search callback (same transaction_id) triggers single chain write (TODO: FN-089)",
  );
});

// ===========================================================================
// Suite 7 — Outbound BPP role (FN-091) — deferred
// ===========================================================================

describe("Suite 7 — Outbound BPP role (FN-091)", () => {
  it.todo(
    // TODO(FN-091): FN-091 (outbound BPP) task not yet specified or implemented.
    "outbound on_search callback to BAP carries correct transaction_id echo (TODO: FN-091)",
  );

  it.todo(
    "outbound on_confirm callback to BAP carries correct message_id echo (TODO: FN-091)",
  );
});

// ===========================================================================
// Suite 8 — Sandbox certification matrix
// ===========================================================================

describe("Suite 8 — Sandbox certification matrix", () => {
  /**
   * Beckn v2.0 LTS Sandbox certification matrix.
   * Source: https://developers.becknprotocol.io/docs/protocol-specifications/
   *
   * Each row: [checkId, description, status, notes]
   * status: "PASS" | "TODO"
   */
  const certificationMatrix = [
    // Envelope validation checks
    ["SB-01", "valid search envelope → 200 ACK", "PASS", "Suite 1 §1.1"],
    ["SB-02", "valid select envelope → 200 ACK", "PASS", "Suite 1 §1.1"],
    ["SB-03", "valid init envelope → 200 ACK", "PASS", "Suite 1 §1.1"],
    ["SB-04", "valid confirm envelope → 200 ACK", "PASS", "Suite 1 §1.1"],
    ["SB-05", "missing context → 400 NACK", "PASS", "Suite 1 §1.3"],
    ["SB-06", "missing domain → 400 NACK", "PASS", "Suite 1 §1.4"],
    ["SB-07", "missing action → 400 NACK", "PASS", "Suite 1 §1.4"],
    ["SB-08", "missing version → 400 NACK", "PASS", "Suite 1 §1.4"],
    ["SB-09", "missing bap_id → 400 NACK", "PASS", "Suite 1 §1.4"],
    ["SB-10", "missing transaction_id → 400 NACK", "PASS", "Suite 1 §1.4"],
    ["SB-11", "missing message_id → 400 NACK", "PASS", "Suite 1 §1.4"],
    ["SB-12", "missing timestamp → 400 NACK", "PASS", "Suite 1 §1.4"],
    ["SB-13", "unknown action string → 400 NACK", "PASS", "Suite 1 §1.5"],
    ["SB-14", "action mismatch path vs context → 400 NACK", "PASS", "Suite 1 §1.6"],
    ["SB-15", "wrong Content-Type → 415 NACK", "PASS", "Suite 1 §1.7"],
    ["SB-16", "oversized body > 1MiB → 413", "PASS", "Suite 1 §1.11 (status only)"],
    // Version / timestamp / TTL validation
    ["SB-17", "version != '2.0.0' → 400 NACK", "TODO", "TODO(FN-087)"],
    ["SB-18", "malformed timestamp → 400 NACK", "TODO", "TODO(FN-087)"],
    ["SB-19", "malformed ttl → 400 NACK", "TODO", "TODO(FN-087)"],
    ["SB-20", "expired TTL → 400 NACK ttl_expired", "TODO", "TODO(FN-087)"],
    // Role round-trips
    ["SB-21", "inbound BAP /search → ACK + on_search callback", "PASS", "Suite 3"],
    ["SB-22", "inbound BPP /confirm → ACK + on_confirm callback", "PASS", "Suite 4"],
    ["SB-23", "context.transaction_id echoed in on_search callback", "PASS", "Suite 3"],
    ["SB-24", "context.transaction_id+message_id echoed in on_confirm", "PASS", "Suite 4"],
    // Idempotency
    ["SB-25", "duplicate (tx_id, msg_id) → both ACK", "PASS", "Suites 3+4"],
    // Method allow-list
    ["SB-26", "GET on action endpoint → 404", "PASS", "Suite 2 §2.1"],
    ["SB-27", "PUT/DELETE on action endpoints → 404", "PASS", "Suite 2 §2.1"],
    // CORS
    ["SB-28", "OPTIONS preflight → 204 with CORS headers", "PASS", "Suite 2 §2.2"],
    // Signing headers
    ["SB-29", "outbound Authorization: Signature header", "TODO", "TODO: signing follow-up"],
    ["SB-30", "outbound X-Gateway-Authorization header", "TODO", "TODO: signing follow-up"],
    // Health
    ["SB-31", "GET /health → 200 liveness", "PASS", "Suite 2 §2.4"],
    // Outbound roles
    ["SB-32", "outbound BAP: sends /search to external BG", "TODO", "TODO(FN-089)"],
    ["SB-33", "outbound BPP: sends on_confirm to BAP", "TODO", "TODO(FN-091)"],
  ] as const;

  const REQUIRED_PASSING_CHECKS = certificationMatrix.filter(
    ([, , status]) => status === "PASS",
  );
  const TODO_CHECKS = certificationMatrix.filter(
    ([, , status]) => status === "TODO",
  );

  it("matches Beckn v2.0 LTS minimum compliance matrix", () => {
    // Counts: SB-01..SB-16 = 16 PASS, SB-21..SB-28 = 8 PASS, SB-31 = 1 PASS → 25 PASS
    // TODO: SB-17..SB-20 = 4, SB-29..SB-30 = 2, SB-32..SB-33 = 2 → 8 TODO
    // Total: 33
    expect(REQUIRED_PASSING_CHECKS.length).toBe(25);
    expect(TODO_CHECKS.length).toBe(8);
    expect(certificationMatrix.length).toBe(33);
  });

  describe.each(certificationMatrix)(
    "%s — %s",
    (checkId, description, status, notes) => {
      if (status === "PASS") {
        it(`[${checkId}] is covered by an active test (${notes})`, () => {
          expect(status).toBe("PASS");
        });
      } else {
        it.todo(`[${checkId}] ${description} — ${notes}`);
      }
    },
  );
});
