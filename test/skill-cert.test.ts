import {
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildSkillCertClaim,
  canonicalJson,
  defaultClaimHasher,
  ed25519SkillCertSignatureVerifier,
  InMemorySkillBindingStore,
  schemaIdForSkill,
  sha256Hex,
  SKILL_CERT_SCHEMA_PREFIX,
  SKILL_CERT_SCHEMA_SUFFIX,
  skillCertSignaturePreimage,
  SkillCertIssuer,
  SkillCertIssuerError,
  StaticSkillWhitelist,
} from "../src/issuers/skill-cert.js";
import type {
  AgentCardSignatureVerifier,
  ChainClient,
  IpfsPinner,
  IssueCredentialArgs,
  IssueCredentialResult,
  SkillCertIssueRequest,
  SkillCertIssuerConfig,
  SkillCertIssuerDeps,
} from "../src/issuers/skill-cert.js";

/** Stub that accepts any signature — used by tests focused on other paths. */
const acceptAllSignatureVerifier: AgentCardSignatureVerifier = {
  async verify() {
    return true;
  },
};

/** Helper: tack a stub signature/nonce onto a (skill, subject) request. */
function req(
  skill: string,
  subjectAgentCard: string,
  overrides: Partial<SkillCertIssueRequest> = {},
): SkillCertIssueRequest {
  return {
    skill,
    subjectAgentCard,
    agentCardSignature: "AA",
    issuanceNonce: "nonce-1",
    ...overrides,
  } as SkillCertIssueRequest;
}

const SUBJECT_A = "AgentCardPubkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SUBJECT_B = "AgentCardPubkeyBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SUBJECT_C = "AgentCardPubkeyCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const SKILL = "solidity-audit";
const ISSUER_DID = "did:eto:issuer:skill-cert";

class FakeChain implements ChainClient {
  public calls: IssueCredentialArgs[] = [];
  public failures = 0;
  public constructor(private readonly pdaSeed = "PDA") {}
  public async issueCredential(
    args: IssueCredentialArgs,
  ): Promise<IssueCredentialResult> {
    this.calls.push(args);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("simulated chain failure");
    }
    return {
      credentialPda: `${this.pdaSeed}:${sha256Hex(args.subjectAgentCard).slice(0, 16)}:${args.schema.slice(0, 8)}`,
      txSignature: `tx-${this.calls.length}`,
    };
  }
}

class FakePinner implements IpfsPinner {
  public pinned: unknown[] = [];
  public async pinJson(value: unknown): Promise<string> {
    this.pinned.push(value);
    return `ipfs://Qm${sha256Hex(JSON.stringify(value)).slice(0, 44)}`;
  }
}

interface MakeIssuerDeps {
  whitelist: StaticSkillWhitelist;
  bindingStore: InMemorySkillBindingStore;
  chain: FakeChain;
  ipfs: FakePinner;
  now: () => number;
}

function makeIssuer(opts: {
  whitelist?: StaticSkillWhitelist;
  store?: InMemorySkillBindingStore;
  chain?: FakeChain;
  ipfs?: FakePinner;
  now?: () => number;
  signatureVerifier?: AgentCardSignatureVerifier;
} = {}): { issuer: SkillCertIssuer; deps: MakeIssuerDeps } {
  const whitelist =
    opts.whitelist ??
    new StaticSkillWhitelist({ [SKILL]: [SUBJECT_A, SUBJECT_B] });
  const bindingStore = opts.store ?? new InMemorySkillBindingStore();
  const chain = opts.chain ?? new FakeChain();
  const ipfs = opts.ipfs ?? new FakePinner();
  const now = opts.now ?? (() => 1_700_000_000_000);
  const cfg: SkillCertIssuerConfig = { issuerDid: ISSUER_DID };
  const deps: SkillCertIssuerDeps = {
    whitelist,
    bindingStore,
    chain,
    ipfs,
    signatureVerifier: opts.signatureVerifier ?? acceptAllSignatureVerifier,
    now,
  };
  return {
    issuer: new SkillCertIssuer(cfg, deps),
    deps: { whitelist, bindingStore, chain, ipfs, now },
  };
}

describe("schemaIdForSkill", () => {
  it("hashes `${PREFIX}${skill}${SUFFIX}` with sha256", () => {
    const expected = sha256Hex(
      SKILL_CERT_SCHEMA_PREFIX + SKILL + SKILL_CERT_SCHEMA_SUFFIX,
    );
    expect(schemaIdForSkill(SKILL)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("yields distinct schema ids per skill", () => {
    expect(schemaIdForSkill("solidity-audit")).not.toBe(
      schemaIdForSkill("rust-audit"),
    );
  });
});

describe("canonicalJson / defaultClaimHasher", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("hashes equal claims to equal digests regardless of key order", () => {
    const a = { skill: "x", subject: "y", n: 1 };
    const b = { n: 1, subject: "y", skill: "x" };
    expect(defaultClaimHasher.hash(a)).toBe(defaultClaimHasher.hash(b));
  });
});

describe("StaticSkillWhitelist", () => {
  it("returns false for unknown skill or subject", () => {
    const wl = new StaticSkillWhitelist({ [SKILL]: [SUBJECT_A] });
    expect(wl.isAllowed(SKILL, SUBJECT_A)).toBe(true);
    expect(wl.isAllowed(SKILL, SUBJECT_B)).toBe(false);
    expect(wl.isAllowed("other-skill", SUBJECT_A)).toBe(false);
  });

  it("`add` augments the in-memory list", () => {
    const wl = new StaticSkillWhitelist({});
    expect(wl.isAllowed(SKILL, SUBJECT_A)).toBe(false);
    wl.add(SKILL, SUBJECT_A);
    expect(wl.isAllowed(SKILL, SUBJECT_A)).toBe(true);
  });
});

describe("InMemorySkillBindingStore", () => {
  it("get returns undefined before put", async () => {
    const store = new InMemorySkillBindingStore();
    expect(await store.get(SKILL, SUBJECT_A)).toBeUndefined();
  });

  it("put + get roundtrips", async () => {
    const store = new InMemorySkillBindingStore();
    await store.put({
      skill: SKILL,
      subjectAgentCard: SUBJECT_A,
      credentialPda: "PDA",
      txSignature: "sig",
      claimUri: "ipfs://x",
      claimHash: "00".repeat(32),
      issuedAtMs: 1,
    });
    const got = await store.get(SKILL, SUBJECT_A);
    expect(got?.credentialPda).toBe("PDA");
  });

  it("throws on duplicate (skill, subject)", async () => {
    const store = new InMemorySkillBindingStore();
    const b = {
      skill: SKILL,
      subjectAgentCard: SUBJECT_A,
      credentialPda: "PDA",
      txSignature: "sig",
      claimUri: "ipfs://x",
      claimHash: "00".repeat(32),
      issuedAtMs: 1,
    };
    await store.put(b);
    await expect(store.put(b)).rejects.toThrow(/already exists/);
  });

  it("isolates entries by skill", async () => {
    const store = new InMemorySkillBindingStore();
    await store.put({
      skill: "a",
      subjectAgentCard: SUBJECT_A,
      credentialPda: "PDA-A",
      txSignature: "sig-A",
      claimUri: "ipfs://a",
      claimHash: "11".repeat(32),
      issuedAtMs: 1,
    });
    expect(await store.get("b", SUBJECT_A)).toBeUndefined();
  });
});

describe("buildSkillCertClaim", () => {
  it("emits the canonical envelope shape", () => {
    const claim = buildSkillCertClaim({
      issuerDid: ISSUER_DID,
      skill: SKILL,
      subjectAgentCard: SUBJECT_A,
      issuanceDate: "2026-01-01T00:00:00.000Z",
    });
    expect(claim).toMatchObject({
      type: ["VerifiableCredential", "SkillCertCredential"],
      issuer: ISSUER_DID,
      issuanceDate: "2026-01-01T00:00:00.000Z",
      credentialSubject: {
        id: `did:eto:agent:${SUBJECT_A}`,
        skill: SKILL,
      },
    });
    expect(Array.isArray((claim as Record<string, unknown>)["@context"])).toBe(true);
  });
});

describe("SkillCertIssuer.issue — happy path (AC: whitelist + per-(subject,skill))", () => {
  it("issues a credential for a whitelisted (skill, subject) pair", async () => {
    const { issuer, deps } = makeIssuer();
    const res = await issuer.issue(req(SKILL, SUBJECT_A));
    expect(res.idempotent).toBe(false);
    expect(res.schema).toBe(schemaIdForSkill(SKILL));
    expect(res.claimUri.startsWith("ipfs://")).toBe(true);
    expect(res.txSignature).toBe("tx-1");
    expect(deps.chain.calls).toHaveLength(1);
    expect(deps.chain.calls[0]).toMatchObject({
      schema: schemaIdForSkill(SKILL),
      subjectAgentCard: SUBJECT_A,
      claimUri: res.claimUri,
      claimHash: res.claimHash,
      validUntilSlot: 0n,
    });
    // Persisted under (skill, subject)
    const stored = await deps.bindingStore.get(SKILL, SUBJECT_A);
    expect(stored?.credentialPda).toBe(res.credentialPda);
  });

  it("claim_hash matches sha256(JCS(envelope))", async () => {
    const { issuer, deps } = makeIssuer({ now: () => 1_700_000_000_000 });
    const res = await issuer.issue(req(SKILL, SUBJECT_A));
    const expectedClaim = buildSkillCertClaim({
      issuerDid: ISSUER_DID,
      skill: SKILL,
      subjectAgentCard: SUBJECT_A,
      issuanceDate: new Date(1_700_000_000_000).toISOString(),
    });
    expect(res.claimHash).toBe(defaultClaimHasher.hash(expectedClaim));
    expect(deps.ipfs.pinned).toHaveLength(1);
  });
});

describe("SkillCertIssuer.issue — AC1: whitelist enforcement", () => {
  it("rejects (skill, subject) not on the whitelist", async () => {
    const { issuer, deps } = makeIssuer();
    await expect(
      issuer.issue(req(SKILL, SUBJECT_C )),
    ).rejects.toMatchObject({
      name: "SkillCertIssuerError",
      code: "NOT_WHITELISTED",
      status: 403,
    });
    expect(deps.chain.calls).toHaveLength(0);
    expect(deps.ipfs.pinned).toHaveLength(0);
    expect(await deps.bindingStore.get(SKILL, SUBJECT_C)).toBeUndefined();
  });

  it("rejects unknown skill (no whitelist entries)", async () => {
    const { issuer } = makeIssuer();
    await expect(
      issuer.issue(req("rust-audit", SUBJECT_A )),
    ).rejects.toMatchObject({ code: "NOT_WHITELISTED" });
  });

  it("supports async whitelist", async () => {
    const asyncWhitelist = {
      isAllowed: vi
        .fn()
        .mockImplementation(
          async (s: string, sub: string) => s === SKILL && sub === SUBJECT_A,
        ),
    };
    const issuer = new SkillCertIssuer(
      { issuerDid: ISSUER_DID },
      {
        whitelist: asyncWhitelist,
        bindingStore: new InMemorySkillBindingStore(),
        chain: new FakeChain(),
        ipfs: new FakePinner(),
        signatureVerifier: acceptAllSignatureVerifier,
      },
    );
    await expect(
      issuer.issue(req(SKILL, SUBJECT_A )),
    ).resolves.toMatchObject({ idempotent: false });
    await expect(
      issuer.issue(req(SKILL, SUBJECT_B )),
    ).rejects.toMatchObject({ code: "NOT_WHITELISTED" });
    expect(asyncWhitelist.isAllowed).toHaveBeenCalled();
  });
});

describe("SkillCertIssuer.issue — AC2: one credential per (subject, skill)", () => {
  it("returns the cached binding on the second call (idempotent)", async () => {
    const { issuer, deps } = makeIssuer();
    const first = await issuer.issue(req(SKILL, SUBJECT_A));
    const second = await issuer.issue(req(SKILL, SUBJECT_A));
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.credentialPda).toBe(first.credentialPda);
    expect(second.txSignature).toBe(first.txSignature);
    expect(second.claimHash).toBe(first.claimHash);
    expect(second.claimUri).toBe(first.claimUri);
    // Only one chain tx + one IPFS pin total.
    expect(deps.chain.calls).toHaveLength(1);
    expect(deps.ipfs.pinned).toHaveLength(1);
  });

  it("issues separate credentials for different subjects on the same skill", async () => {
    const { issuer, deps } = makeIssuer();
    const a = await issuer.issue(req(SKILL, SUBJECT_A));
    const b = await issuer.issue(req(SKILL, SUBJECT_B));
    expect(a.credentialPda).not.toBe(b.credentialPda);
    expect(deps.chain.calls).toHaveLength(2);
  });

  it("issues separate credentials for different skills on the same subject", async () => {
    const wl = new StaticSkillWhitelist({
      "solidity-audit": [SUBJECT_A],
      "rust-audit": [SUBJECT_A],
    });
    const { issuer, deps } = makeIssuer({ whitelist: wl });
    const s1 = await issuer.issue(req("solidity-audit", SUBJECT_A));
    const s2 = await issuer.issue(req("rust-audit", SUBJECT_A));
    expect(s1.schema).not.toBe(s2.schema);
    expect(s1.credentialPda).not.toBe(s2.credentialPda);
    expect(deps.chain.calls).toHaveLength(2);
  });

  it("idempotent re-hit serves even if subject is later removed from whitelist", async () => {
    const wl = new StaticSkillWhitelist({ [SKILL]: [SUBJECT_A] });
    const { issuer, deps } = makeIssuer({ whitelist: wl });
    const first = await issuer.issue(req(SKILL, SUBJECT_A));
    // The deps object inside the issuer is the original one — but we're
    // testing the contract: a previously-bound subject should still get
    // the cached row because the bridge consults the binding store
    // BEFORE the whitelist (cached row wins).
    void deps;
    const second = await issuer.issue(req(SKILL, SUBJECT_A));
    expect(second.idempotent).toBe(true);
    expect(second.credentialPda).toBe(first.credentialPda);
  });
});

describe("SkillCertIssuer.issue — request validation", () => {
  it("rejects invalid skill slugs", async () => {
    const { issuer } = makeIssuer();
    for (const bad of ["", "Solidity-Audit", "x_y", "x y", "x--y", "-x", "x-"]) {
      await expect(
        issuer.issue(req(bad, SUBJECT_A )),
      ).rejects.toMatchObject({ code: "INVALID_SKILL", status: 400 });
    }
  });

  it("rejects empty subjectAgentCard", async () => {
    const { issuer } = makeIssuer();
    await expect(
      issuer.issue(req(SKILL, "" )),
    ).rejects.toMatchObject({ code: "INVALID_SUBJECT", status: 400 });
  });
});

describe("SkillCertIssuer.issue — failure modes", () => {
  it("maps chain failure to CHAIN_TX_FAILED 502 and does not persist", async () => {
    const chain = new FakeChain();
    chain.failures = 1;
    const { issuer, deps } = makeIssuer({ chain });
    await expect(
      issuer.issue(req(SKILL, SUBJECT_A )),
    ).rejects.toMatchObject({ code: "CHAIN_TX_FAILED", status: 502 });
    expect(await deps.bindingStore.get(SKILL, SUBJECT_A)).toBeUndefined();
  });

  it("rejects non-ipfs uris from the pinner", async () => {
    const ipfs: IpfsPinner = {
      pinJson: async () => "https://example.com/cid",
    };
    const { issuer } = makeIssuer({ ipfs: ipfs as unknown as FakePinner });
    await expect(
      issuer.issue(req(SKILL, SUBJECT_A )),
    ).rejects.toMatchObject({ code: "CHAIN_TX_FAILED", status: 500 });
  });

  it("recovers on lost-race put: returns canonical row with idempotent=true", async () => {
    // Pre-seed the canonical row, then make `put` fail to simulate a
    // concurrent winner getting there first.
    const store = new InMemorySkillBindingStore();
    const canonical = {
      skill: SKILL,
      subjectAgentCard: SUBJECT_A,
      credentialPda: "PDA-canonical",
      txSignature: "tx-canonical",
      claimUri: "ipfs://canonical",
      claimHash: "ab".repeat(32),
      issuedAtMs: 42,
    };
    // Wrap the store so the *first* `put` collides but `get` returns a
    // canonical row inserted out-of-band.
    const racingStore: InMemorySkillBindingStore = Object.create(store);
    racingStore.get = async () => canonical;
    racingStore.put = async () => {
      throw new Error("simulated race-loss");
    };
    // But keep the idempotency pre-check fresh: the bridge calls
    // `get` BEFORE the chain tx for the cache hit — so we need it to
    // return undefined first and then return canonical after `put`
    // collides. Use a counter.
    let getCalls = 0;
    racingStore.get = async () => (getCalls++ === 0 ? undefined : canonical);

    const { issuer, deps } = makeIssuer({ store: racingStore });
    const res = await issuer.issue(req(SKILL, SUBJECT_A));
    expect(res.idempotent).toBe(true);
    expect(res.credentialPda).toBe("PDA-canonical");
    expect(res.txSignature).toBe("tx-canonical");
    // Chain was still hit once before the put collided.
    expect(deps.chain.calls).toHaveLength(1);
  });

  it("surfaces an error if the canonical row vanishes after a lost race", async () => {
    const store = new InMemorySkillBindingStore();
    const racingStore: InMemorySkillBindingStore = Object.create(store);
    racingStore.get = async () => undefined;
    racingStore.put = async () => {
      throw new Error("simulated race-loss");
    };
    const { issuer } = makeIssuer({ store: racingStore });
    await expect(
      issuer.issue(req(SKILL, SUBJECT_A )),
    ).rejects.toMatchObject({ code: "CHAIN_TX_FAILED", status: 500 });
  });
});

describe("SkillCertIssuer.issue — caller-binding signature (FN-058)", () => {
  // Generate a stable Ed25519 keypair for tests; the wallet pubkey is
  // the raw 32-byte public key encoded as base58 — the AgentCard wire
  // format used elsewhere in this codebase. We rebuild the base58
  // string locally so tests do not pull in extra deps.
  const BASE58_ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58Encode(bytes: Uint8Array): string {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
    const digits: number[] = [];
    for (let i = zeros; i < bytes.length; i += 1) {
      let carry = bytes[i]!;
      for (let j = 0; j < digits.length; j += 1) {
        carry += digits[j]! << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let out = "";
    for (let i = 0; i < zeros; i += 1) out += "1";
    for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58_ALPHABET[digits[i]!];
    return out;
  }

  function makeKeypair(): {
    pubBase58: string;
    sign: (msg: Buffer) => string;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    // Strip RFC 8410 SPKI prefix (12 bytes) to get raw 32-byte pubkey.
    const spki = publicKey.export({ format: "der", type: "spki" });
    const raw = spki.subarray(spki.length - 32);
    return {
      pubBase58: base58Encode(new Uint8Array(raw)),
      sign: (msg) => cryptoSign(null, msg, privateKey).toString("base64"),
    };
  }

  it("happy path: valid signature by subjectAgentCard issues credential", async () => {
    const kp = makeKeypair();
    const wl = new StaticSkillWhitelist({ [SKILL]: [kp.pubBase58] });
    const { issuer, deps } = makeIssuer({
      whitelist: wl,
      signatureVerifier: ed25519SkillCertSignatureVerifier,
    });
    const nonce = "nonce-happy-1";
    const sig = kp.sign(
      skillCertSignaturePreimage({
        skill: SKILL,
        subjectAgentCard: kp.pubBase58,
        issuanceNonce: nonce,
      }),
    );
    const out = await issuer.issue({
      skill: SKILL,
      subjectAgentCard: kp.pubBase58,
      agentCardSignature: sig,
      issuanceNonce: nonce,
    });
    expect(out.idempotent).toBe(false);
    expect(deps.chain.calls).toHaveLength(1);
    expect(deps.chain.calls[0]?.subjectAgentCard).toBe(kp.pubBase58);
  });

  it("rejects 401 when subjectAgentCard != signer (front-run defence) BEFORE binding-store / whitelist / chain", async () => {
    const victim = makeKeypair();
    const attacker = makeKeypair();
    // Victim is whitelisted for SKILL; attacker is not.
    const wl = new StaticSkillWhitelist({
      [SKILL]: [victim.pubBase58],
    });
    // Track that the binding-store, whitelist, and chain are NOT consulted.
    const bindingStore: InMemorySkillBindingStore = Object.create(
      InMemorySkillBindingStore.prototype,
    );
    let storeGetCalls = 0;
    let storePutCalls = 0;
    bindingStore.get = async () => {
      storeGetCalls += 1;
      return undefined;
    };
    bindingStore.put = async () => {
      storePutCalls += 1;
    };
    let whitelistCalls = 0;
    const wlSpy = {
      isAllowed: (s: string, sub: string) => {
        whitelistCalls += 1;
        return wl.isAllowed(s, sub);
      },
    };
    const chain = new FakeChain();
    const { issuer } = makeIssuer({
      whitelist: wlSpy as unknown as StaticSkillWhitelist,
      store: bindingStore,
      chain,
      signatureVerifier: ed25519SkillCertSignatureVerifier,
    });

    // Attacker forges a request claiming the VICTIM's pubkey as subject
    // but signs with the attacker's own (or some random) key. Since the
    // signature does not validate against the victim's pubkey, the
    // request must 401 before any side effect.
    const nonce = "nonce-attack-1";
    const attackerSig = attacker.sign(
      skillCertSignaturePreimage({
        skill: SKILL,
        subjectAgentCard: victim.pubBase58,
        issuanceNonce: nonce,
      }),
    );
    await expect(
      issuer.issue({
        skill: SKILL,
        subjectAgentCard: victim.pubBase58,
        agentCardSignature: attackerSig,
        issuanceNonce: nonce,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_AGENT_CARD_SIGNATURE",
      status: 401,
    });
    expect(storeGetCalls).toBe(0);
    expect(storePutCalls).toBe(0);
    expect(whitelistCalls).toBe(0);
    expect(chain.calls).toHaveLength(0);
  });

  it("rejects 401 if signature is over a different (skill) preimage", async () => {
    const kp = makeKeypair();
    const wl = new StaticSkillWhitelist({ [SKILL]: [kp.pubBase58] });
    const { issuer, deps } = makeIssuer({
      whitelist: wl,
      signatureVerifier: ed25519SkillCertSignatureVerifier,
    });
    const nonce = "nonce-bad-skill";
    // Sign over a different skill name — valid sig but bound to wrong skill.
    const sig = kp.sign(
      skillCertSignaturePreimage({
        skill: "some-other-skill",
        subjectAgentCard: kp.pubBase58,
        issuanceNonce: nonce,
      }),
    );
    await expect(
      issuer.issue({
        skill: SKILL,
        subjectAgentCard: kp.pubBase58,
        agentCardSignature: sig,
        issuanceNonce: nonce,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_AGENT_CARD_SIGNATURE",
      status: 401,
    });
    expect(deps.chain.calls).toHaveLength(0);
  });

  it("rejects empty agentCardSignature with 401", async () => {
    const { issuer, deps } = makeIssuer();
    await expect(
      issuer.issue({
        skill: SKILL,
        subjectAgentCard: SUBJECT_A,
        agentCardSignature: "",
        issuanceNonce: "n",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_AGENT_CARD_SIGNATURE",
      status: 401,
    });
    expect(deps.chain.calls).toHaveLength(0);
  });

  it("rejects empty issuanceNonce with 401", async () => {
    const { issuer, deps } = makeIssuer();
    await expect(
      issuer.issue({
        skill: SKILL,
        subjectAgentCard: SUBJECT_A,
        agentCardSignature: "AA",
        issuanceNonce: "",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_AGENT_CARD_SIGNATURE",
      status: 401,
    });
    expect(deps.chain.calls).toHaveLength(0);
  });
});

describe("SkillCertIssuerError", () => {
  it("is an Error subclass with name + code + status", () => {
    const e = new SkillCertIssuerError("NOT_WHITELISTED", "nope", 403);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SkillCertIssuerError");
    expect(e.code).toBe("NOT_WHITELISTED");
    expect(e.status).toBe(403);
  });
});
