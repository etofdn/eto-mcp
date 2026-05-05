/**
 * Vitest unit tests for the bank-as-BPP scaffold (FN-096).
 *
 * Coverage:
 *   1. BANK_CAPABILITY_KEYS — length and spec order
 *   2. buildBankCatalog — five capabilities, correct Zod parse
 *   3. canonicalCatalogJson — byte-stability (deterministic)
 *   4. catalogHashHex — snapshot regression test
 *   5. computeBankNetworkId integration — networkIdHex matches FN-095
 *   6. buildConfig — valid BppConfig with umbrella tag
 *   7. createBankHandler dispatch — not_implemented + unknown_action
 *   8. publishBankCatalog + InMemoryCatalogCommitRecorder
 *   9. main() invocation — AgentCard registered once, CatalogCommit once,
 *      all five events recorded as failed with not_implemented
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BANK_CAPABILITY_KEYS, buildBankCatalog, canonicalCatalogJson, catalogHashHex, buildCatalogCommit } from "../../keeper/bpps/bank/catalog.js";
import { buildConfig } from "../../keeper/bpps/bank/config.js";
import { createBankHandler } from "../../keeper/bpps/bank/handler.js";
import { InMemoryCatalogCommitRecorder, publishBankCatalog } from "../../keeper/bpps/bank/catalog-publisher.js";
import { makeStubSigner, projectCapabilityTags } from "../../keeper/templates/bpp/index.js";
import { zBankCapability, zBankCatalog, zCatalogCommitPayload } from "../../keeper/bpps/bank/types.js";
import { zBppConfig, zCapabilityTags } from "../../keeper/templates/bpp/types.js";
import {
  BANK_NETWORK_LABEL,
  computeBankNetworkId,
} from "../../keeper/bpps/bank/network-id.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const FIXED_BPP_AUTHORITY = "TestBppAuthority1111111111111111111111111111";
const FIXED_ISSUER_AUTHORITY = "TestIssuerAuthority11111111111111111111111111";
const FIXED_PUBLISHED_AT = 1746000000;

function fixedCatalog() {
  return buildBankCatalog({
    bppAuthority: FIXED_BPP_AUTHORITY,
    issuerAuthority: FIXED_ISSUER_AUTHORITY,
    networkLabel: BANK_NETWORK_LABEL,
    publishedAtSec: FIXED_PUBLISHED_AT,
  });
}

/* -------------------------------------------------------------------------- */
/* 1. BANK_CAPABILITY_KEYS                                                    */
/* -------------------------------------------------------------------------- */

describe("BANK_CAPABILITY_KEYS", () => {
  it("has exactly 5 keys", () => {
    expect(BANK_CAPABILITY_KEYS.length).toBe(5);
  });

  it("matches spec order exactly", () => {
    expect(BANK_CAPABILITY_KEYS).toEqual([
      "bank.checking",
      "bank.savings",
      "bank.fiat-ramp",
      "bank.card",
      "bank.wire",
    ]);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(BANK_CAPABILITY_KEYS)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. buildBankCatalog                                                        */
/* -------------------------------------------------------------------------- */

describe("buildBankCatalog", () => {
  it("returns a catalog with exactly 5 capabilities", () => {
    const c = fixedCatalog();
    expect(c.capabilities.length).toBe(5);
  });

  it("all capabilities have domain === 'bank'", () => {
    const c = fixedCatalog();
    for (const cap of c.capabilities) {
      expect(cap.domain).toBe("bank");
    }
  });

  it("all capabilities have version === '0.1.0'", () => {
    const c = fixedCatalog();
    for (const cap of c.capabilities) {
      expect(cap.version).toBe("0.1.0");
    }
  });

  it("capability keys match BANK_CAPABILITY_KEYS in spec order", () => {
    const c = fixedCatalog();
    const keys = c.capabilities.map((cap) => cap.capabilityKey);
    expect(keys).toEqual(BANK_CAPABILITY_KEYS);
  });

  it("each capability action equals the key suffix (after 'bank.')", () => {
    const c = fixedCatalog();
    for (const cap of c.capabilities) {
      const expectedAction = cap.capabilityKey.slice("bank.".length);
      expect(cap.action).toBe(expectedAction);
    }
  });

  it("parses with zBankCatalog Zod schema", () => {
    const c = fixedCatalog();
    expect(() => zBankCatalog.parse(c)).not.toThrow();
  });

  it("each capability parses with zBankCapability", () => {
    const c = fixedCatalog();
    for (const cap of c.capabilities) {
      expect(() => zBankCapability.parse(cap)).not.toThrow();
    }
  });

  it("default price is 0 ETO", () => {
    const c = fixedCatalog();
    for (const cap of c.capabilities) {
      expect(cap.price.amount).toBe("0");
      expect(cap.price.currency).toBe("ETO");
    }
  });

  it("accepts pricing overrides", () => {
    const c = buildBankCatalog({
      bppAuthority: FIXED_BPP_AUTHORITY,
      issuerAuthority: FIXED_ISSUER_AUTHORITY,
      publishedAtSec: FIXED_PUBLISHED_AT,
      pricing: {
        "bank.checking": { amount: "1.50", currency: "ETO" },
        "bank.wire": { amount: "5.00", currency: "EUSD" },
      },
    });
    const checking = c.capabilities.find((cap) => cap.capabilityKey === "bank.checking");
    const wire = c.capabilities.find((cap) => cap.capabilityKey === "bank.wire");
    expect(checking?.price).toEqual({ amount: "1.50", currency: "ETO" });
    expect(wire?.price).toEqual({ amount: "5.00", currency: "EUSD" });
    // others still default to zero
    const savings = c.capabilities.find((cap) => cap.capabilityKey === "bank.savings");
    expect(savings?.price).toEqual({ amount: "0", currency: "ETO" });
  });

  it("version defaults to '0.1.0'", () => {
    const c = fixedCatalog();
    expect(c.version).toBe("0.1.0");
  });

  it("uses publishedAtSec when provided", () => {
    const c = fixedCatalog();
    expect(c.publishedAtSec).toBe(FIXED_PUBLISHED_AT);
  });

  it("defaults publishedAtSec to approximately now when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const c = buildBankCatalog({
      bppAuthority: FIXED_BPP_AUTHORITY,
      issuerAuthority: FIXED_ISSUER_AUTHORITY,
    });
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(c.publishedAtSec).toBeGreaterThanOrEqual(before);
    expect(c.publishedAtSec).toBeLessThanOrEqual(after);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. canonicalCatalogJson — determinism                                      */
/* -------------------------------------------------------------------------- */

describe("canonicalCatalogJson", () => {
  it("is deterministic: two builds with same input produce identical output", () => {
    const c1 = fixedCatalog();
    const c2 = fixedCatalog();
    expect(canonicalCatalogJson(c1)).toBe(canonicalCatalogJson(c2));
  });

  it("sorts object keys lexicographically at every level", () => {
    const json = canonicalCatalogJson(fixedCatalog());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it("preserves array element order (capabilities in spec order)", () => {
    const json = canonicalCatalogJson(fixedCatalog());
    const parsed = JSON.parse(json) as { capabilities: Array<{ capabilityKey: string }> };
    const capKeys = parsed.capabilities.map((c) => c.capabilityKey);
    expect(capKeys).toEqual(BANK_CAPABILITY_KEYS);
  });

  it("produces no extra whitespace", () => {
    const json = canonicalCatalogJson(fixedCatalog());
    // round-trip: JSON.stringify of parsed should equal original
    expect(json).toBe(JSON.stringify(JSON.parse(json)));
  });
});

/* -------------------------------------------------------------------------- */
/* 4. catalogHashHex — snapshot                                               */
/* -------------------------------------------------------------------------- */

describe("catalogHashHex", () => {
  // snapshot: ae3c42d0fe61b6ae5e8ae32d54d13a3e487d32e9ebe4b1ff86cd9648205e3ffa
  // Generated with:
  //   buildBankCatalog({ bppAuthority: 'TestBppAuthority1111111111111111111111111111',
  //     issuerAuthority: 'TestIssuerAuthority11111111111111111111111111',
  //     networkLabel: 'bank.eto.us-test', publishedAtSec: 1746000000 })
  const SNAPSHOT_HASH =
    "ae3c42d0fe61b6ae5e8ae32d54d13a3e487d32e9ebe4b1ff86cd9648205e3ffa";

  it("matches snapshot for fixed-input fixture", () => {
    const c = fixedCatalog();
    expect(catalogHashHex(c)).toBe(SNAPSHOT_HASH);
  });

  it("is 64 lowercase hex chars", () => {
    const hash = catalogHashHex(fixedCatalog());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when publishedAtSec changes", () => {
    const c1 = buildBankCatalog({
      bppAuthority: FIXED_BPP_AUTHORITY,
      issuerAuthority: FIXED_ISSUER_AUTHORITY,
      publishedAtSec: FIXED_PUBLISHED_AT,
    });
    const c2 = buildBankCatalog({
      bppAuthority: FIXED_BPP_AUTHORITY,
      issuerAuthority: FIXED_ISSUER_AUTHORITY,
      publishedAtSec: FIXED_PUBLISHED_AT + 1,
    });
    expect(catalogHashHex(c1)).not.toBe(catalogHashHex(c2));
  });
});

/* -------------------------------------------------------------------------- */
/* 5. computeBankNetworkId integration                                        */
/* -------------------------------------------------------------------------- */

describe("computeBankNetworkId / BANK_NETWORK_LABEL integration", () => {
  it("BANK_NETWORK_LABEL is the expected string", () => {
    expect(BANK_NETWORK_LABEL).toBe("bank.eto.us-test");
  });

  it("networkIdHex in built catalog matches computeBankNetworkId(BANK_NETWORK_LABEL)", () => {
    const c = fixedCatalog();
    const expected = Buffer.from(computeBankNetworkId(BANK_NETWORK_LABEL)).toString("hex");
    expect(c.networkIdHex).toBe(expected);
  });

  it("networkIdHex is 64 lowercase hex chars", () => {
    const c = fixedCatalog();
    expect(c.networkIdHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. buildConfig — valid BppConfig                                           */
/* -------------------------------------------------------------------------- */

describe("buildConfig", () => {
  it("returns a valid BppConfig (zBppConfig.parse passes)", () => {
    const { config } = buildConfig({
      authority: FIXED_BPP_AUTHORITY,
      issuerAuthority: FIXED_ISSUER_AUTHORITY,
    });
    expect(() => zBppConfig.parse(config)).not.toThrow();
  });

  it("capabilityTags has domain === 'bank'", () => {
    const { config } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    expect(config.capabilityTags.domain).toBe("bank");
  });

  it("capabilityTags has action === 'catalog' (umbrella tag)", () => {
    const { config } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    expect(config.capabilityTags.action).toBe("catalog");
  });

  it("capabilityTags has version === '0.1.0'", () => {
    const { config } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    expect(config.capabilityTags.version).toBe("0.1.0");
  });

  it("projectCapabilityTags surfaces price.cents on umbrella tag (ADR-0001)", () => {
    const { config } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    const entry = projectCapabilityTags(config.capabilityTags);
    expect(entry.domain).toBe("bank");
    expect(entry.price.cents).toBe(config.capabilityTags.price.cents);
  });

  it("description is short enough (≤ 512 chars)", () => {
    const { config } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    expect(config.capabilityTags.description.length).toBeLessThanOrEqual(512);
  });

  it("catalog has 5 capabilities", () => {
    const { catalog } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    expect(catalog.capabilities.length).toBe(5);
  });

  it("umbrella tag price advertises free capability with integer cents", () => {
    const { config } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    expect(config.capabilityTags.price.amount).toBe("0");
    expect(config.capabilityTags.price.currency).toBe("ETO");
    expect(config.capabilityTags.price.cents).toBe(0);
  });

  it("umbrella tag round-trips through zCapabilityTags", () => {
    const { config } = buildConfig({ authority: FIXED_BPP_AUTHORITY });
    expect(() => zCapabilityTags.parse(config.capabilityTags)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 7. createBankHandler dispatch                                              */
/* -------------------------------------------------------------------------- */

describe("createBankHandler", () => {
  // Reusable dummy task-request factory
  function req(action: string) {
    return {
      taskId: `test-${action}`,
      bapPubkey: "BapPubkey1111111111111111111111111111111111",
      bppPubkey: "BppPubkey1111111111111111111111111111111111",
      networkPubkey: "NetPubkey1111111111111111111111111111111111",
      action,
      input: {},
    };
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agent: { authority: "bpp", name: "bank-bpp" },
    now: () => 1746000000,
  };

  describe("known capability actions", () => {
    const cases: [string, string][] = [
      ["bank.checking", "FN-097"],
      ["bank.savings", "FN-121"],
      ["bank.fiat-ramp", "FN-107"],
      ["bank.card", "FN-125"],
      ["bank.wire", "FN-119"],
    ];

    for (const [action, taskId] of cases) {
      it(`${action} → status failure, reason starts not_implemented`, async () => {
        const handler = createBankHandler();
        const result = await handler.handleTask(req(action), ctx);
        expect(result.status).toBe("failure");
        if (result.status === "failure") {
          expect(result.reason).toMatch(/^not_implemented:/);
        }
      });

      it(`${action} → reason contains ${taskId}`, async () => {
        const handler = createBankHandler();
        const result = await handler.handleTask(req(action), ctx);
        if (result.status === "failure") {
          expect(result.reason).toContain(taskId);
        }
      });
    }
  });

  it("bogus.action → status failure, reason starts unknown_action", async () => {
    const handler = createBankHandler();
    const result = await handler.handleTask(req("bogus.action"), ctx);
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.reason).toMatch(/^unknown_action:/);
      expect(result.reason).toContain("bogus.action");
    }
  });

  it("accepts custom now dep", async () => {
    const nowFn = vi.fn(() => 1_000_000_000);
    const handler = createBankHandler({ now: nowFn });
    await handler.handleTask(req("bank.checking"), ctx);
    // now is not called during stub dispatch, but the handler was created OK
    expect(handler).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 8. publishBankCatalog + InMemoryCatalogCommitRecorder                     */
/* -------------------------------------------------------------------------- */

describe("publishBankCatalog + InMemoryCatalogCommitRecorder", () => {
  it("records exactly one commit", async () => {
    const catalog = fixedCatalog();
    const recorder = new InMemoryCatalogCommitRecorder();
    const signer = makeStubSigner("test-seed");

    await publishBankCatalog({
      catalog,
      networkPubkey: "NetPubkey1111111111111111111111111111111111",
      recorder,
      signer,
    });

    expect(recorder.count).toBe(1);
  });

  it("commit catalogHash equals catalogHashHex(catalog)", async () => {
    const catalog = fixedCatalog();
    const recorder = new InMemoryCatalogCommitRecorder();
    const signer = makeStubSigner("test-seed");

    const result = await publishBankCatalog({
      catalog,
      networkPubkey: "NetPubkey1111111111111111111111111111111111",
      recorder,
      signer,
    });

    expect(result.commit.catalogHash).toBe(catalogHashHex(catalog));
  });

  it("commit passes zCatalogCommitPayload Zod schema", async () => {
    const catalog = fixedCatalog();
    const recorder = new InMemoryCatalogCommitRecorder();
    const signer = makeStubSigner("test-seed");

    const result = await publishBankCatalog({
      catalog,
      networkPubkey: "NetPubkey1111111111111111111111111111111111",
      recorder,
      signer,
    });

    expect(() => zCatalogCommitPayload.parse(result.commit)).not.toThrow();
  });

  it("returns non-empty signature string", async () => {
    const catalog = fixedCatalog();
    const recorder = new InMemoryCatalogCommitRecorder();
    const signer = makeStubSigner("test-seed");

    const result = await publishBankCatalog({
      catalog,
      networkPubkey: "NetPubkey1111111111111111111111111111111111",
      recorder,
      signer,
    });

    expect(typeof result.signature).toBe("string");
    expect(result.signature.length).toBeGreaterThan(0);
  });

  it("publishedCommits is read-only copy (mutating return does not affect recorder)", async () => {
    const catalog = fixedCatalog();
    const recorder = new InMemoryCatalogCommitRecorder();
    const signer = makeStubSigner("test-seed");

    await publishBankCatalog({
      catalog,
      networkPubkey: "NetPubkey1111111111111111111111111111111111",
      recorder,
      signer,
    });

    const commits1 = recorder.publishedCommits;
    // Mutate the returned array
    (commits1 as unknown[]).push("bogus");
    // Recorder should still have exactly 1 commit
    expect(recorder.count).toBe(1);
    expect(recorder.publishedCommits.length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. main() invocation                                                       */
/* -------------------------------------------------------------------------- */

describe("main()", () => {
  it("completes without throwing", async () => {
    const { main } = await import("../../keeper/bpps/bank/main.js");
    await expect(main()).resolves.toBeUndefined();
  });

  it("logs the CatalogCommit hash to stdout (spy on console.log)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("../../keeper/bpps/bank/main.js");
      await main();
      const allLogs = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
      expect(allLogs).toMatch(/CatalogCommit published/);
      expect(allLogs).toMatch(/catalogHash/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records exactly 5 not_implemented failures", async () => {
    // We verify by inspecting that main() does not throw — which only
    // succeeds if all 5 stub responses pass the internal assertion.
    const { main } = await import("../../keeper/bpps/bank/main.js");
    // main() throws if any event does not return not_implemented
    await expect(main()).resolves.toBeUndefined();
  });
});
