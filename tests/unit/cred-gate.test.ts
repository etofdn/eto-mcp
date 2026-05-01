/**
 * Unit tests for the composable BAP credential-gating helpers
 * (FN-074, T-2.7.1.2).
 */

import { describe, expect, it, vi } from "vitest";

import {
  composeGates,
  requireCred,
  type GateMiddleware,
} from "../../keeper/lib/cred-gate.js";
import type {
  AgentCardSnapshot,
  HeldCredentialSnapshot,
  Pubkey,
  RequiredCredential,
} from "../../keeper/templates/bpp/types.js";
import type { AgentCardLoader } from "../../keeper/templates/bpp/credential-gate.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = 1_700_000_000;

const SCHEMA_A = "a".repeat(64);
const SCHEMA_B = "b".repeat(64);
const ISSUER_X: Pubkey = "IssuerXPubkey1111111111111111111111111111";
const ISSUER_Y: Pubkey = "IssuerYPubkey2222222222222222222222222222";
const BAP: Pubkey = "BapPubkey3333333333333333333333333333333333";

function cred(
  overrides: Partial<HeldCredentialSnapshot> = {},
): HeldCredentialSnapshot {
  return {
    schema: SCHEMA_A,
    predicateHash: "0".repeat(64),
    issuer: ISSUER_X,
    validFrom: 0,
    validUntil: 0,
    revoked: false,
    ...overrides,
  };
}

function cardWith(
  credentials: readonly HeldCredentialSnapshot[],
): AgentCardSnapshot {
  return { authority: BAP, credentials };
}

function loaderFor(card: AgentCardSnapshot): AgentCardLoader {
  return async () => card;
}

const ctxDeps = (card: AgentCardSnapshot) => ({
  loadAgentCard: loaderFor(card),
  now: () => NOW,
});

/* -------------------------------------------------------------------------- */
/* requireCred                                                                */
/* -------------------------------------------------------------------------- */

describe("requireCred", () => {
  it("matches an active cred → ok", async () => {
    const card = cardWith([cred()]);
    const gate = composeGates([requireCred(SCHEMA_A)], ctxDeps(card));
    expect(await gate(BAP)).toEqual({ ok: true });
  });

  it("missing schema → reason not_found with prefix", async () => {
    const card = cardWith([cred({ schema: SCHEMA_B })]);
    const gate = composeGates([requireCred(SCHEMA_A)], ctxDeps(card));
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(`missing_cred:${SCHEMA_A.slice(0, 8)}:not_found`);
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]?.schema).toBe(SCHEMA_A);
    }
  });

  it("rejects revoked cred → reason inactive", async () => {
    const card = cardWith([cred({ revoked: true })]);
    const gate = composeGates([requireCred(SCHEMA_A)], ctxDeps(card));
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(":inactive");
  });

  it("rejects expired cred (validUntil in past) → inactive", async () => {
    const card = cardWith([cred({ validUntil: NOW - 10 })]);
    const gate = composeGates([requireCred(SCHEMA_A)], ctxDeps(card));
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(":inactive");
  });

  it("rejects wrong-issuer cred → wrong_issuer", async () => {
    const card = cardWith([cred({ issuer: ISSUER_X })]);
    const gate = composeGates(
      [requireCred(SCHEMA_A, undefined, { issuerSet: [ISSUER_Y] })],
      ctxDeps(card),
    );
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(":wrong_issuer");
  });

  it("rejects when predicate returns false → predicate_rejected (not not_found)", async () => {
    const card = cardWith([cred()]);
    const predicate = vi.fn().mockReturnValue(false);
    const gate = composeGates(
      [requireCred(SCHEMA_A, predicate)],
      ctxDeps(card),
    );
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(":predicate_rejected");
    expect(predicate).toHaveBeenCalledOnce();
  });

  it("rejects cred expiring within margin → expiring", async () => {
    const card = cardWith([cred({ validUntil: NOW + 60 })]);
    const gate = composeGates(
      [requireCred(SCHEMA_A, undefined, { notExpiredWithinSec: 3600 })],
      ctxDeps(card),
    );
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(":expiring");
  });

  it("predicate receives ctx with deterministic now and bapPubkey", async () => {
    const card = cardWith([cred()]);
    const predicate = vi.fn().mockReturnValue(true);
    const gate = composeGates(
      [requireCred(SCHEMA_A, predicate)],
      ctxDeps(card),
    );
    await gate(BAP);
    expect(predicate).toHaveBeenCalledWith(
      expect.objectContaining({ schema: SCHEMA_A }),
      { now: NOW, bapPubkey: BAP },
    );
  });

  it("attaches RequiredCredential meta to the returned middleware", () => {
    const mw = requireCred(SCHEMA_A, undefined, {
      issuerSet: [ISSUER_X],
      notExpiredWithinSec: 60,
    });
    const meta: RequiredCredential = mw.meta;
    expect(meta).toEqual({
      schema: SCHEMA_A,
      issuerSet: [ISSUER_X],
      mustBeActive: true,
      notExpiredWithinSec: 60,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* composeGates                                                               */
/* -------------------------------------------------------------------------- */

describe("composeGates", () => {
  it("empty middleware list → ok", async () => {
    const gate = composeGates([], ctxDeps(cardWith([])));
    expect(await gate(BAP)).toEqual({ ok: true });
  });

  it("aggregates failure reason and meta into missing[]", async () => {
    const card = cardWith([cred({ schema: SCHEMA_A })]);
    const aOk = requireCred(SCHEMA_A);
    const bFail = requireCred(SCHEMA_B);
    const gate = composeGates([aOk, bFail], ctxDeps(card));
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(`missing_cred:${SCHEMA_B.slice(0, 8)}:not_found`);
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]?.schema).toBe(SCHEMA_B);
    }
  });

  it("default mode='all' runs all middlewares and joins reasons", async () => {
    const card = cardWith([]);
    const a = vi.fn<Parameters<GateMiddleware>, ReturnType<GateMiddleware>>(
      () => ({ ok: false, reason: "reason_a" }),
    );
    const b = vi.fn<Parameters<GateMiddleware>, ReturnType<GateMiddleware>>(
      () => ({ ok: false, reason: "reason_b" }),
    );
    const gate = composeGates([a, b], ctxDeps(card));
    const r = await gate(BAP);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reason_a,reason_b");
  });

  it("mode='first-fail' short-circuits on first denial", async () => {
    const card = cardWith([]);
    const a = vi.fn<Parameters<GateMiddleware>, ReturnType<GateMiddleware>>(
      () => ({ ok: false, reason: "reason_a" }),
    );
    const b = vi.fn<Parameters<GateMiddleware>, ReturnType<GateMiddleware>>(
      () => ({ ok: false, reason: "reason_b" }),
    );
    const gate = composeGates([a, b], ctxDeps(card), { mode: "first-fail" });
    const r = await gate(BAP);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reason_a");
  });

  it("surfaces agent_card_unavailable when loader throws and skips middlewares", async () => {
    const mw = vi.fn<Parameters<GateMiddleware>, ReturnType<GateMiddleware>>(
      () => ({ ok: true }),
    );
    const gate = composeGates([mw], {
      loadAgentCard: async () => {
        throw new Error("rpc-down");
      },
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(mw).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("agent_card_unavailable: rpc-down");
      expect(r.missing).toEqual([]);
    }
  });

  it("custom GateMiddleware lacking meta is still accepted by composeGates (no missing entry)", async () => {
    const card = cardWith([]);
    const customMw: GateMiddleware = () => ({ ok: false, reason: "custom" });
    // @ts-expect-error — `meta` is not present on a plain GateMiddleware,
    // confirming custom middlewares need not provide one.
    const _meta: RequiredCredential = customMw.meta;
    void _meta;
    const gate = composeGates([customMw], ctxDeps(card));
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("custom");
      expect(r.missing).toEqual([]);
    }
  });

  it("calls loadAgentCard once per gate invocation regardless of middleware count", async () => {
    const card = cardWith([cred()]);
    const loader = vi.fn(async () => card);
    const gate = composeGates(
      [requireCred(SCHEMA_A), requireCred(SCHEMA_A)],
      { loadAgentCard: loader, now: () => NOW },
    );
    await gate(BAP);
    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith(BAP);
  });
});
