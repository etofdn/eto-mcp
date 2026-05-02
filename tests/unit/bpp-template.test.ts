/**
 * Unit tests for the BPP keeper template (FN-073, T-2.7.1.1).
 *
 * Covers: type/Zod parsing, AgentCard registration tx-builder,
 * credential gating, runtime dispatch, and the worked echo example.
 */

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  zCapabilityTags,
  zBppConfig,
  zRequiredCredential,
  type BppConfig,
  type CapabilityTags,
  type RequiredCredential,
  type AgentCardSnapshot,
  type BppHandler,
  type BeckonInitEvent,
  type TaskResult,
} from "../../keeper/templates/bpp/types.js";
import {
  buildRegisterAgentInstruction,
  encodeMetadataUri,
  registerBppAgentCard,
  InMemoryPinner,
  REGISTER_AGENT_NAME_MAX,
  REGISTER_AGENT_METADATA_URI_MAX,
  AGENT_CARD_PDA_PREFIX,
} from "../../keeper/templates/bpp/register.js";
import {
  defaultCredentialGate,
} from "../../keeper/templates/bpp/credential-gate.js";
import {
  runBpp,
  InMemoryEventSource,
  InMemoryChain,
} from "../../keeper/templates/bpp/runtime.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SCHEMA_A = "a".repeat(64);
const SCHEMA_B = "b".repeat(64);
const ISSUER_X = "IssuerXAuthorityPubkey1111111111111111111111";
const ISSUER_Y = "IssuerYAuthorityPubkey2222222222222222222222";
const BAP = "BapAgentCardPubkey3333333333333333333333333";
const BPP = "BppAgentCardPubkey4444444444444444444444444";
const NETWORK = "NetworkPubkey555555555555555555555555555555";
const AUTHORITY = "BppAuthorityPubkey66666666666666666666666666";

const baseTags: CapabilityTags = {
  domain: "util",
  action: "echo",
  version: "1.0.0",
  price: { amount: "0", currency: "ETO" },
  requiredCredentials: [],
  description: "Echo BPP — returns the input message verbatim.",
};

const baseConfig: BppConfig = {
  name: "echo-bpp",
  modelId: "test-model",
  authority: AUTHORITY,
  capabilityTags: baseTags,
  requiredBapCredentials: [],
};

/* -------------------------------------------------------------------------- */
/* Step 1 — Type system                                                       */
/* -------------------------------------------------------------------------- */

describe("Step 1: types + Zod schemas", () => {
  it("accepts a minimal valid CapabilityTags", () => {
    expect(() => zCapabilityTags.parse(baseTags)).not.toThrow();
  });

  it("rejects bad semver with a descriptive error", () => {
    const r = zCapabilityTags.safeParse({ ...baseTags, version: "1.0" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = JSON.stringify(r.error.issues);
      expect(msg).toMatch(/MAJOR\.MINOR\.PATCH/);
    }
  });

  it("rejects unknown currency", () => {
    const r = zCapabilityTags.safeParse({
      ...baseTags,
      price: { amount: "1", currency: "BTC" as unknown as "ETO" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects schema that is not 64 hex chars", () => {
    const bad: RequiredCredential = {
      schema: "not-hex",
      issuerSet: [],
      mustBeActive: true,
    };
    const r = zRequiredCredential.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects description over 512 chars", () => {
    const r = zCapabilityTags.safeParse({
      ...baseTags,
      description: "x".repeat(513),
    });
    expect(r.success).toBe(false);
  });

  it("validates a full BppConfig", () => {
    expect(() => zBppConfig.parse(baseConfig)).not.toThrow();
  });

  it("RequiredCredential round-trips through JSON", () => {
    const rc: RequiredCredential = {
      schema: SCHEMA_A,
      issuerSet: [ISSUER_X, ISSUER_Y],
      mustBeActive: true,
      notExpiredWithinSec: 300,
    };
    const back = zRequiredCredential.parse(JSON.parse(JSON.stringify(rc)));
    expect(back).toEqual(rc);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 2 — AgentCard registration                                            */
/* -------------------------------------------------------------------------- */

describe("Step 2: registerBppAgentCard", () => {
  it("encodes metadata as a data: URL when small enough", () => {
    const tags: CapabilityTags = { ...baseTags, description: "tiny" };
    const uri = encodeMetadataUri(tags);
    expect(uri).not.toBeNull();
    expect(uri!.startsWith("data:application/json;base64,")).toBe(true);
    expect(uri!.length).toBeLessThanOrEqual(REGISTER_AGENT_METADATA_URI_MAX);
  });

  it("falls back to a pinner when the JSON exceeds the inline budget", async () => {
    const big: CapabilityTags = {
      ...baseTags,
      description: "x".repeat(512),
    };
    const inline = encodeMetadataUri(big);
    expect(inline).toBeNull(); // signal: caller must use pinner
    const pinner = new InMemoryPinner();
    const uri = await pinner.pin(big);
    expect(uri.startsWith("inmem://")).toBe(true);
  });

  it("buildRegisterAgentInstruction produces stable Borsh bytes", () => {
    const ix = buildRegisterAgentInstruction({
      name: "echo-bpp",
      modelId: "test-model",
      metadataUri: "data:application/json;base64,e30=",
    });
    // discriminator 0 + 3 borsh-encoded strings (length-prefixed u32 LE)
    expect(ix[0]).toBe(0);
    // sanity: re-decode and check fields round-trip
    const { name, modelId, metadataUri } = decodeRegisterAgent(ix);
    expect(name).toBe("echo-bpp");
    expect(modelId).toBe("test-model");
    expect(metadataUri).toBe("data:application/json;base64,e30=");
  });

  it("rejects name > REGISTER_AGENT_NAME_MAX", () => {
    expect(() =>
      buildRegisterAgentInstruction({
        name: "x".repeat(REGISTER_AGENT_NAME_MAX + 1),
        modelId: "m",
        metadataUri: "data:,",
      }),
    ).toThrow(/name/i);
  });

  it("rejects metadataUri > REGISTER_AGENT_METADATA_URI_MAX", () => {
    expect(() =>
      buildRegisterAgentInstruction({
        name: "n",
        modelId: "m",
        metadataUri: "x".repeat(REGISTER_AGENT_METADATA_URI_MAX + 1),
      }),
    ).toThrow(/metadata/i);
  });

  it("registerBppAgentCard is idempotent on existing AgentCard", async () => {
    const existingPda = "ExistingAgentCardPda";
    const chain = {
      registerAgent: vi.fn(async () => ({
        pda: "FRESH",
        txSignature: "sig",
      })),
      findAgentCardPda: vi.fn(async () => existingPda),
      completeTask: vi.fn(),
      failTask: vi.fn(),
    };
    const result = await registerBppAgentCard(baseConfig, {
      chain,
      pinner: new InMemoryPinner(),
    });
    expect(result.pda).toBe(existingPda);
    expect(result.idempotent).toBe(true);
    expect(chain.registerAgent).not.toHaveBeenCalled();
  });

  it("registerBppAgentCard registers when no AgentCard exists", async () => {
    const chain = {
      registerAgent: vi.fn(async () => ({
        pda: "FRESH",
        txSignature: "sig",
      })),
      findAgentCardPda: vi.fn(async () => null),
      completeTask: vi.fn(),
      failTask: vi.fn(),
    };
    const result = await registerBppAgentCard(baseConfig, {
      chain,
      pinner: new InMemoryPinner(),
    });
    expect(result.pda).toBe("FRESH");
    expect(result.idempotent).toBe(false);
    expect(chain.registerAgent).toHaveBeenCalledTimes(1);
  });

  it("AGENT_CARD_PDA_PREFIX is the documented seed", () => {
    expect(AGENT_CARD_PDA_PREFIX).toBe("agent_card");
  });
});

/* -------------------------------------------------------------------------- */
/* Step 3 — credential gating                                                 */
/* -------------------------------------------------------------------------- */

describe("Step 3: defaultCredentialGate", () => {
  const NOW = 1_700_000_000;

  function loaderFor(card: AgentCardSnapshot | null) {
    return async (_pubkey: string) => {
      if (!card) throw new Error("agent card not found");
      return card;
    };
  }

  function snap(creds: AgentCardSnapshot["credentials"]): AgentCardSnapshot {
    return { authority: BAP, credentials: creds };
  }

  it("ok when a matching active credential exists", async () => {
    const required: RequiredCredential[] = [
      { schema: SCHEMA_A, issuerSet: [ISSUER_X], mustBeActive: true },
    ];
    const gate = defaultCredentialGate(required, {
      loadAgentCard: loaderFor(
        snap([
          {
            schema: SCHEMA_A,
            predicateHash: "0".repeat(64),
            issuer: ISSUER_X,
            validFrom: 0,
            validUntil: 0,
            revoked: false,
          },
        ]),
      ),
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(r.ok).toBe(true);
  });

  it("rejects when no matching schema is present", async () => {
    const required: RequiredCredential[] = [
      { schema: SCHEMA_A, issuerSet: [], mustBeActive: true },
    ];
    const gate = defaultCredentialGate(required, {
      loadAgentCard: loaderFor(
        snap([
          {
            schema: SCHEMA_B,
            predicateHash: "0".repeat(64),
            issuer: ISSUER_X,
            validFrom: 0,
            validUntil: 0,
            revoked: false,
          },
        ]),
      ),
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]?.schema).toBe(SCHEMA_A);
    }
  });

  it("rejects revoked credentials when mustBeActive=true", async () => {
    const required: RequiredCredential[] = [
      { schema: SCHEMA_A, issuerSet: [], mustBeActive: true },
    ];
    const gate = defaultCredentialGate(required, {
      loadAgentCard: loaderFor(
        snap([
          {
            schema: SCHEMA_A,
            predicateHash: "0".repeat(64),
            issuer: ISSUER_X,
            validFrom: 0,
            validUntil: 0,
            revoked: true,
          },
        ]),
      ),
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
  });

  it("rejects credentials whose issuer is not in issuerSet", async () => {
    const required: RequiredCredential[] = [
      { schema: SCHEMA_A, issuerSet: [ISSUER_X], mustBeActive: true },
    ];
    const gate = defaultCredentialGate(required, {
      loadAgentCard: loaderFor(
        snap([
          {
            schema: SCHEMA_A,
            predicateHash: "0".repeat(64),
            issuer: ISSUER_Y,
            validFrom: 0,
            validUntil: 0,
            revoked: false,
          },
        ]),
      ),
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
  });

  it("rejects credentials expiring within notExpiredWithinSec", async () => {
    const required: RequiredCredential[] = [
      {
        schema: SCHEMA_A,
        issuerSet: [],
        mustBeActive: true,
        notExpiredWithinSec: 600,
      },
    ];
    const gate = defaultCredentialGate(required, {
      loadAgentCard: loaderFor(
        snap([
          {
            schema: SCHEMA_A,
            predicateHash: "0".repeat(64),
            issuer: ISSUER_X,
            validFrom: 0,
            validUntil: NOW + 100,
            revoked: false,
          },
        ]),
      ),
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
  });

  it("multi-requirement: all must pass", async () => {
    const required: RequiredCredential[] = [
      { schema: SCHEMA_A, issuerSet: [], mustBeActive: true },
      { schema: SCHEMA_B, issuerSet: [], mustBeActive: true },
    ];
    const gate = defaultCredentialGate(required, {
      loadAgentCard: loaderFor(
        snap([
          {
            schema: SCHEMA_A,
            predicateHash: "0".repeat(64),
            issuer: ISSUER_X,
            validFrom: 0,
            validUntil: 0,
            revoked: false,
          },
        ]),
      ),
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]?.schema).toBe(SCHEMA_B);
    }
  });

  it("returns reason 'agent_card_unavailable' when loader throws", async () => {
    const gate = defaultCredentialGate(
      [{ schema: SCHEMA_A, issuerSet: [], mustBeActive: true }],
      { loadAgentCard: loaderFor(null), now: () => NOW },
    );
    const r = await gate(BAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/agent_card_unavailable/);
  });

  it("noop when there are zero required credentials", async () => {
    const gate = defaultCredentialGate([], {
      loadAgentCard: loaderFor(snap([])),
      now: () => NOW,
    });
    const r = await gate(BAP);
    expect(r.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 4 — runtime                                                           */
/* -------------------------------------------------------------------------- */

describe("Step 4: runBpp dispatch", () => {
  function event(taskId: string, input: unknown = { message: "hi" }): BeckonInitEvent {
    return {
      taskId,
      bapPubkey: BAP,
      bppPubkey: BPP,
      networkPubkey: NETWORK,
      action: "util:echo",
      input,
      observedAt: 1_700_000_000,
    };
  }

  it("allowed → handler called → completeTask", async () => {
    const events = new InMemoryEventSource();
    const chain = new InMemoryChain();
    const handler: BppHandler = {
      handleTask: vi.fn(
        async (req): Promise<TaskResult> => ({
          status: "success",
          output: { echoed: (req.input as { message: string }).message },
        }),
      ),
    };
    const done = runBpp(baseConfig, handler, {
      eventSource: events,
      chain,
      gate: async () => ({ ok: true }),
      logger: silentLogger(),
    });
    events.push(event("t1"));
    events.close();
    await done;
    expect(handler.handleTask).toHaveBeenCalledTimes(1);
    expect(chain.completed).toEqual([
      { taskId: "t1", output: { echoed: "hi" } },
    ]);
    expect(chain.failed).toEqual([]);
  });

  it("denied gate → handler NOT called → failTask with credential reason", async () => {
    const events = new InMemoryEventSource();
    const chain = new InMemoryChain();
    const handler: BppHandler = {
      handleTask: vi.fn(),
    };
    const done = runBpp(baseConfig, handler, {
      eventSource: events,
      chain,
      gate: async () => ({
        ok: false,
        missing: [],
        reason: "missing skill.solidity-audit",
      }),
      logger: silentLogger(),
    });
    events.push(event("t2"));
    events.close();
    await done;
    expect(handler.handleTask).not.toHaveBeenCalled();
    expect(chain.failed).toHaveLength(1);
    expect(chain.failed[0]?.reason).toMatch(/credential_gate_denied/);
  });

  it("handler throws → failTask with handler_error", async () => {
    const events = new InMemoryEventSource();
    const chain = new InMemoryChain();
    const handler: BppHandler = {
      handleTask: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const done = runBpp(baseConfig, handler, {
      eventSource: events,
      chain,
      gate: async () => ({ ok: true }),
      logger: silentLogger(),
    });
    events.push(event("t3"));
    events.close();
    await done;
    expect(chain.failed).toHaveLength(1);
    expect(chain.failed[0]?.reason).toMatch(/handler_error/);
    expect(chain.failed[0]?.reason).toMatch(/boom/);
  });

  it("handler timeout fires failTask with timeout reason", async () => {
    const events = new InMemoryEventSource();
    const chain = new InMemoryChain();
    const handler: BppHandler = {
      handleTask: () => new Promise(() => {}), // never resolves
    };
    const cfg: BppConfig = { ...baseConfig, handlerTimeoutSec: 0.05 };
    const done = runBpp(cfg, handler, {
      eventSource: events,
      chain,
      gate: async () => ({ ok: true }),
      logger: silentLogger(),
    });
    events.push(event("t4"));
    events.close();
    await done;
    expect(chain.failed).toHaveLength(1);
    expect(chain.failed[0]?.reason).toMatch(/handler_timeout/);
  });

  it("returns a failure handler-result via failTask (not throw)", async () => {
    const events = new InMemoryEventSource();
    const chain = new InMemoryChain();
    const handler: BppHandler = {
      handleTask: async () => ({ status: "failure", reason: "no_capacity" }),
    };
    const done = runBpp(baseConfig, handler, {
      eventSource: events,
      chain,
      gate: async () => ({ ok: true }),
      logger: silentLogger(),
    });
    events.push(event("t5"));
    events.close();
    await done;
    expect(chain.failed).toHaveLength(1);
    expect(chain.failed[0]?.reason).toMatch(/no_capacity/);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 5 — worked example                                                    */
/* -------------------------------------------------------------------------- */

describe("Step 5: echo-bpp example", () => {
  it("runs to completion via tsx and prints two completed tasks", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const example = resolve(
      here,
      "..",
      "..",
      "keeper",
      "templates",
      "bpp",
      "example",
      "echo-bpp.ts",
    );
    // Use node --import tsx (via npx) — fall back to tsx binary if present.
    const result = spawnSync(
      "npx",
      ["--yes", "tsx", example],
      { encoding: "utf8", timeout: 15_000 },
    );
    if (result.status !== 0) {
      // Surface stderr to help debugging if tsx is unavailable in CI.
      throw new Error(
        `echo-bpp exited ${result.status ?? "?"}: ${result.stderr || result.stdout}`,
      );
    }
    expect(result.stdout).toMatch(/completed task t1/);
    expect(result.stdout).toMatch(/completed task t2/);
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function readU32LE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset] ?? 0;
  const b1 = buf[offset + 1] ?? 0;
  const b2 = buf[offset + 2] ?? 0;
  const b3 = buf[offset + 3] ?? 0;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function decodeRegisterAgent(buf: Uint8Array): {
  name: string;
  modelId: string;
  metadataUri: string;
} {
  if (buf[0] !== 0) throw new Error("expected discriminator 0");
  const td = new TextDecoder();
  let off = 1;
  const readStr = (): string => {
    const len = readU32LE(buf, off);
    off += 4;
    const str = td.decode(buf.slice(off, off + len));
    off += len;
    return str;
  };
  const name = readStr();
  const modelId = readStr();
  const metadataUri = readStr();
  return { name, modelId, metadataUri };
}
