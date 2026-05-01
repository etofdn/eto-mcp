/**
 * Inbound BAP role — receives /search and /select POSTs from external Beckn
 * Application Providers, validates them against the Beckn v2.0 LTS schema
 * (FN-087), translates to on-chain Beckn instruction args, and submits
 * (currently STUBBED — real submission lands once eto-cli exposes the
 * subcommand).
 *
 * Spec: T-2.8.2.1 (FN-088). Sibling roles: outbound-bap (FN-089),
 * inbound-bpp (FN-090).
 */

import { createHash } from "crypto";

import type { Express, Request, Response } from "express";
import { validateBecknRequest } from "./beckn-schemas.js";
import type { BecknAction } from "./beckn-schemas.js";

export type { BecknAction };

export interface InboundBapDeps {
  /** Submit an on-chain Beckn instruction. STUBBED today. */
  submitOnChain: (action: BecknAction, args: unknown) => Promise<{ tx_signature: string }>;
  /** Resolve catalog responses for a SearchIntent. STUBBED today. */
  pollCatalogResponses?: (intent_hash: string, max: number) => Promise<unknown[]>;
}

export function mountInboundBap(app: Express, deps: InboundBapDeps): void {
  app.post("/search", async (req: Request, res: Response) => {
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
