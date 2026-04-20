import express, { type Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { createSession, verifySession, type AuthStrategy } from "./session.js";
import { generatePayload, verifyPayload } from "./thirdweb.js";
import { McpError } from "../errors/index.js";

// Public auth endpoints. Mount this router at /auth in sse-server — the body
// parser below must NOT leak to /message, which reads the raw stream via the
// MCP SDK. Routes here are written relative to /auth (i.e. POST "/login").

export const authRouter: Router = express.Router();

const loginSchema = z.object({
  address: z.string(),
  chainId: z.number().int().optional(),
});

const strategySchema = z.enum(["siwe", "inapp_email", "inapp_oauth"]) satisfies z.ZodType<AuthStrategy>;

const verifySchema = z.object({
  payload: z.object({}).passthrough(),
  signature: z.string(),
  strategy: strategySchema,
});

// Attach body-parser per-route — never as .use() on the router, because even
// path-scoped mounts can still run on fall-through requests in some Express
// configurations. Per-route is the only guaranteed containment.
const json = express.json();

function authError(message: string, explanation: string, status = 401) {
  const err = new McpError(
    "AUTH_001", "auth", message, explanation,
    [{ action: "authenticate", description: "Call /auth/login, sign the payload, then POST /auth/verify" }],
    false,
  );
  return { status, body: err.toJSON() };
}

authRouter.post("/login", json, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const { status, body } = authError(
      "Invalid /auth/login request",
      "Expected JSON body: { address: string, chainId?: number }",
      400,
    );
    res.status(status).json(body);
    return;
  }
  try {
    const payload = await generatePayload({ address: parsed.data.address, chainId: parsed.data.chainId });
    res.json(payload);
  } catch (e: any) {
    const { status, body } = authError("Failed to generate login payload", e?.message ?? String(e), 500);
    res.status(status).json(body);
  }
});

authRouter.post("/verify", json, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const { status, body } = authError(
      "Invalid /auth/verify request",
      "Expected JSON body: { payload: LoginPayload, signature: string, strategy: 'siwe'|'inapp_email'|'inapp_oauth' }",
      400,
    );
    res.status(status).json(body);
    return;
  }
  try {
    const result = await verifyPayload({
      payload: parsed.data.payload as any,
      signature: parsed.data.signature,
    });
    if (!result.valid) {
      const { status, body } = authError("Signature verification failed", result.error, 401);
      res.status(status).json(body);
      return;
    }
    const address = result.payload.address;
    const token = createSession({
      userId: address,
      walletId: address,
      authStrategy: parsed.data.strategy,
      ttlSeconds: config.auth.sessionTtlSeconds,
      network: config.network,
    });
    const exp = Math.floor(Date.now() / 1000) + config.auth.sessionTtlSeconds;
    res.json({ token, exp });
  } catch (e: any) {
    const { status, body } = authError("Verification error", e?.message ?? String(e), 500);
    res.status(status).json(body);
  }
});

authRouter.get("/me", (req, res) => {
  const header = req.header("authorization");
  if (!header) {
    const { status, body } = authError("Missing Authorization header", "Provide Bearer <token>", 401);
    res.status(status).json(body);
    return;
  }
  const token = header.replace(/^Bearer\s+/i, "");
  const session = verifySession(token);
  if (!session) {
    const { status, body } = authError("Session expired or invalid", "Re-authenticate via /auth/login", 401);
    res.status(status).json(body);
    return;
  }
  res.json({
    sub: session.sub,
    caps: session.caps,
    auth_strategy: session.auth_strategy,
    exp: session.exp,
  });
});
