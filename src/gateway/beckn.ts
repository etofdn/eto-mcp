/**
 * Beckn HTTP bridge — foundational gateway for Beckn v2.0 LTS protocol.
 *
 * Mounts the four core Beckn endpoints — `/search`, `/select`, `/init`,
 * `/confirm` — each accepting the canonical `{context, message}` envelope
 * and returning a synchronous `ACK` response. This task (FN-086) only
 * delivers the HTTP surface; per-action message validation lands in FN-087
 * and BAP/BPP role dispatch lands in FN-088..FN-091.
 *
 * Design notes:
 *  - Per-route `express.json()` body parser, never `router.use(json)`. This
 *    matches `auth-routes.ts` and prevents body-parser leakage to other
 *    routes that may be mounted on the same app.
 *  - Module is side-effect-free (no `app.listen()`); deploy wiring is FN-093.
 *  - `becknRouter` is the bare router for callers who want to compose into a
 *    larger app; `createBecknApp()` returns a self-contained Express app
 *    that tests and the conformance suite (FN-092) can boot directly.
 */
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";

// ---------- Beckn envelope types ----------

/**
 * Beckn v2.0 LTS context fields. We require the minimum set every action
 * envelope must carry; optional fields (`bpp_id`, `bpp_uri`, `ttl`,
 * `location`) appear in BPP-targeted actions but not search broadcasts.
 *
 * See `spec/SINGULARITY-LAYER-1.md` for the canonical envelope used across
 * the project.
 */
export type BecknAction = "search" | "select" | "init" | "confirm";

export interface BecknContext {
  domain: string;
  action: BecknAction;
  version: string;
  bap_id: string;
  bap_uri: string;
  transaction_id: string;
  message_id: string;
  timestamp: string;
  bpp_id?: string;
  bpp_uri?: string;
  ttl?: string;
  location?: unknown;
}

export interface BecknRequest {
  context: BecknContext;
  message: unknown;
}

export interface BecknAckResponse {
  message: { ack: { status: "ACK" } };
}

export interface BecknNackResponse {
  message: { ack: { status: "NACK" } };
  error: { code: string; message: string };
}

// ---------- Validation ----------

const becknActionSchema = z.enum(["search", "select", "init", "confirm"]);

/**
 * Permissive envelope schema. Validates only that the context carries the
 * required Beckn fields and the action is one of the four supported here.
 * Per-action `message` schemas are deferred to FN-087.
 */
export const becknRequestSchema = z.object({
  context: z.object({
    domain: z.string().min(1),
    action: becknActionSchema,
    version: z.string().min(1),
    bap_id: z.string().min(1),
    bap_uri: z.string().min(1),
    transaction_id: z.string().min(1),
    message_id: z.string().min(1),
    timestamp: z.string().min(1),
    bpp_id: z.string().min(1).optional(),
    bpp_uri: z.string().min(1).optional(),
    ttl: z.string().min(1).optional(),
    location: z.unknown().optional(),
  }).passthrough(),
  message: z.unknown(),
});

// ---------- Helpers ----------

/**
 * Build a Beckn-style NACK response body. Returned as `{body, status}` so
 * the caller can `res.status(status).json(body)` in one line, matching the
 * `auth-routes.ts` error helper convention.
 */
export function becknError(
  code: string,
  message: string,
  status = 400,
): { status: number; body: BecknNackResponse } {
  return {
    status,
    body: {
      message: { ack: { status: "NACK" } },
      error: { code, message },
    },
  };
}

const ACK_BODY: BecknAckResponse = { message: { ack: { status: "ACK" } } };

// Per-route body parser. Per `auth-routes.ts`: never `router.use(json)`,
// always per-route, so the parser is contained to JSON endpoints only.
const json = express.json({ limit: "1mb" });

/**
 * Build a handler for a specific Beckn action. The handler enforces:
 *  1. `Content-Type: application/json` (else 415 + NACK)
 *  2. envelope schema validity (else 400 + NACK)
 *  3. `context.action` matches the route's expected action (else 400 + NACK)
 * On success it returns 200 + a synchronous ACK. Real role dispatch is
 * deferred to FN-088..FN-091.
 */
function makeHandler(expected: BecknAction) {
  return (req: Request, res: Response): void => {
    const ct = req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      const { status, body } = becknError(
        "BECKN_415",
        `Expected Content-Type application/json, got '${ct || "none"}'`,
        415,
      );
      res.status(status).json(body);
      return;
    }

    const parsed = becknRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const { status, body } = becknError(
        "BECKN_400",
        `Invalid Beckn envelope: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
      );
      res.status(status).json(body);
      return;
    }

    if (parsed.data.context.action !== expected) {
      const { status, body } = becknError(
        "BECKN_400",
        `context.action '${parsed.data.context.action}' does not match endpoint '/${expected}'`,
        400,
      );
      res.status(status).json(body);
      return;
    }

    res.status(200).json(ACK_BODY);
  };
}

// ---------- Router ----------

/**
 * Bare Beckn router with the four Beckn v2.0 LTS endpoints plus a `/health`
 * liveness probe. Mount under any prefix (e.g. `/beckn`) — this task does
 * not pick a mount point; that's deferred to FN-093.
 */
export const becknRouter: Router = express.Router();

becknRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "beckn-bridge",
    actions: ["search", "select", "init", "confirm"] as const,
  });
});

becknRouter.post("/search", json, makeHandler("search"));
becknRouter.post("/select", json, makeHandler("select"));
becknRouter.post("/init", json, makeHandler("init"));
becknRouter.post("/confirm", json, makeHandler("confirm"));

// ---------- App factory ----------

/**
 * Build a self-contained Express app hosting `becknRouter` at `/`. Used by
 * tests and by future deploy wiring (FN-093). Mirrors the CORS shape from
 * `sse-server.ts` but trimmed to the methods Beckn needs.
 */
export function createBecknApp(): express.Express {
  const app = express();
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(becknRouter);
  return app;
}
