import { describe, expect, it, vi } from "vitest";

import {
  buildVerifiedHumanVc,
  canonicalJson,
  createFetchCloudVerifier,
  defaultClaimHasher,
  InMemoryNullifierStore,
  normalizeHex,
  sha256Hex,
  VERIFIED_HUMAN_ACTION,
  VERIFIED_HUMAN_SCHEMA_ID,
  VERIFIED_HUMAN_SCHEMA_TAG,
  WORLDCOIN_ISSUER_URL,
  WorldcoinIssuer,
  type WorldcoinIssuerConfig,
  type WorldcoinIssuerDeps,
  WorldcoinIssuerError,
  type WorldcoinIssueRequest,
} from "../src/issuers/worldcoin.js";
import {
  type AgentCardSignatureVerifier,
  type ChainClient,
  type CloudVerifier,
  type IdTokenVerifier,
  type IpfsPinner,
  type NullifierStore,
  type VerifiedIdToken,
  type WorldcoinVerificationLevel,
} from "../src/issuers/worldcoin.types.js";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

const APP_ID = "app_test_42";
const ISSUER_DID = "did:eto:worldcoin";
const NULLIFIER = "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd";
const MERKLE_ROOT =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const CARD_A = "AgentCardPubkey_AAAA";
const CARD_B = "AgentCardPubkey_BBBB";

function fakeIdTokenVerifier(claims: Partial<VerifiedIdToken> = {}): IdTokenVerifier {
  return {
    verify: vi.fn().mockResolvedValue({
      sub: "world_user_1",
      iss: WORLDCOIN_ISSUER_URL,
      aud: APP_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    } satisfies VerifiedIdToken),
  };
}

function fakeAgentCardSig(ok = true): AgentCardSignatureVerifier {
  return {
    verify: vi.fn().mockResolvedValue(ok),
  };
}

function fakeCloud(
  level: WorldcoinVerificationLevel = "orb",
  overrides: { nullifier?: string; action?: string; throwError?: Error } = {},
): CloudVerifier {
  return {
    verifyProof: vi.fn().mockImplementation(async (input) => {
      if (overrides.throwError) throw overrides.throwError;
      return {
        success: true,
        verificationLevel: level,
        nullifierHash: overrides.nullifier ?? input.nullifierHash,
        action: overrides.action ?? input.action,
      };
    }),
  };
}

function fakeStore(): NullifierStore {
  return new InMemoryNullifierStore();
}

function fakeChain(): ChainClient & {
  calls: number;
} {
  let n = 0;
  return {
    get calls() {
      return n;
    },
    issueCredential: vi.fn().mockImplementation(async () => {
      n += 1;
      return {
        credentialPda: `Credential_PDA_${n}`,
        txSignature: `tx_sig_${n}`,
      };
    }),
  } as unknown as ChainClient & { calls: number };
}

function fakeIpfs(): IpfsPinner {
  let n = 0;
  return {
    pinJson: vi.fn().mockImplementation(async () => {
      n += 1;
      return `ipfs://Qm_test_${n}`;
    }),
  };
}

function makeIssuer(
  overrides: Partial<WorldcoinIssuerDeps> = {},
  cfgOverrides: Partial<WorldcoinIssuerConfig> = {},
): { issuer: WorldcoinIssuer; deps: WorldcoinIssuerDeps } {
  const deps: WorldcoinIssuerDeps = {
    idTokenVerifier: fakeIdTokenVerifier(),
    cloudVerifier: fakeCloud(),
    agentCardSignatureVerifier: fakeAgentCardSig(),
    nullifierStore: fakeStore(),
    chain: fakeChain(),
    ipfs: fakeIpfs(),
    ...overrides,
  };
  const cfg: WorldcoinIssuerConfig = {
    appId: APP_ID,
    issuerDid: ISSUER_DID,
    ...cfgOverrides,
  };
  return { issuer: new WorldcoinIssuer(cfg, deps), deps };
}

function makeRequest(
  overrides: Partial<WorldcoinIssueRequest> = {},
): WorldcoinIssueRequest {
  return {
    idToken: "header.payload.sig",
    proof: "base64_proof_blob",
    merkleRoot: MERKLE_ROOT,
    nullifierHash: NULLIFIER,
    verificationLevel: "orb",
    agentCardPubkey: CARD_A,
    agentCardSignature: "base64_signature",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Constants & utils                                                           */
/* -------------------------------------------------------------------------- */

describe("constants", () => {
  it("schema id is sha256 of the canonical tag", () => {
    expect(VERIFIED_HUMAN_SCHEMA_ID).toBe(sha256Hex(VERIFIED_HUMAN_SCHEMA_TAG));
    expect(VERIFIED_HUMAN_SCHEMA_ID).toHaveLength(64);
  });

  it("normalizeHex strips 0x and lowercases", () => {
    expect(normalizeHex("0xABCDEF")).toBe("abcdef");
    expect(normalizeHex("0XAbCdEf")).toBe("abcdef");
    expect(normalizeHex("abcdef")).toBe("abcdef");
  });

  it("canonicalJson sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { z: 1, y: 2 }, b: [3, 1, 2] })).toBe(
      '{"a":{"y":2,"z":1},"b":[3,1,2]}',
    );
  });

  it("defaultClaimHasher is sha256(canonicalJson(value))", () => {
    const v = { x: 1, y: "two" };
    expect(defaultClaimHasher.hash(v)).toBe(sha256Hex(canonicalJson(v)));
  });

  it("buildVerifiedHumanVc shape matches spec §7", () => {
    const vc = buildVerifiedHumanVc({
      issuerDid: ISSUER_DID,
      agentCardPubkey: CARD_A,
      verificationLevel: "orb",
      nullifierHash: NULLIFIER,
      merkleRoot: MERKLE_ROOT,
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    expect(vc).toMatchObject({
      issuer: ISSUER_DID,
      type: ["VerifiableCredential", "VerifiedHumanCredential"],
      credentialSubject: {
        id: `did:eto:agentcard:${CARD_A}`,
        verificationLevel: "orb",
        worldIdAction: VERIFIED_HUMAN_ACTION,
        worldIdNullifierHash: normalizeHex(NULLIFIER),
        worldIdMerkleRoot: normalizeHex(MERKLE_ROOT),
      },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Validation: AC #1 — proof validation                                        */
/* -------------------------------------------------------------------------- */

describe("WorldcoinIssuer.issue — proof validation (AC #1)", () => {
  it("rejects an id_token from the wrong issuer", async () => {
    const { issuer } = makeIssuer({
      idTokenVerifier: fakeIdTokenVerifier({ iss: "https://evil.example" }),
    });
    await expect(issuer.issue(makeRequest())).rejects.toMatchObject({
      code: "INVALID_ID_TOKEN",
      status: 401,
    });
  });

  it("rejects an id_token with wrong aud", async () => {
    const { issuer } = makeIssuer({
      idTokenVerifier: fakeIdTokenVerifier({ aud: "app_other" }),
    });
    await expect(issuer.issue(makeRequest())).rejects.toBeInstanceOf(
      WorldcoinIssuerError,
    );
  });

  it("rejects an expired id_token", async () => {
    const { issuer } = makeIssuer({
      idTokenVerifier: fakeIdTokenVerifier({
        exp: Math.floor(Date.now() / 1000) - 60,
      }),
    });
    await expect(issuer.issue(makeRequest())).rejects.toMatchObject({
      code: "INVALID_ID_TOKEN",
    });
  });

  it("rejects an invalid agent_card signature", async () => {
    const { issuer } = makeIssuer({
      agentCardSignatureVerifier: fakeAgentCardSig(false),
    });
    await expect(issuer.issue(makeRequest())).rejects.toMatchObject({
      code: "INVALID_AGENT_CARD_SIGNATURE",
      status: 401,
    });
  });

  it("rejects when Worldcoin Cloud returns a different nullifier", async () => {
    const { issuer } = makeIssuer({
      cloudVerifier: fakeCloud("orb", {
        nullifier:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
      }),
    });
    await expect(issuer.issue(makeRequest())).rejects.toMatchObject({
      code: "PROOF_REJECTED",
    });
  });

  it("maps Cloud verifier outage to UPSTREAM_OUTAGE / 503", async () => {
    const { issuer } = makeIssuer({
      cloudVerifier: fakeCloud("orb", { throwError: new Error("ETIMEDOUT") }),
    });
    await expect(issuer.issue(makeRequest())).rejects.toMatchObject({
      code: "UPSTREAM_OUTAGE",
      status: 503,
    });
  });

  it("rejects mismatched verification levels (wallet vs verifier)", async () => {
    const { issuer } = makeIssuer({
      cloudVerifier: fakeCloud("device"),
    });
    await expect(
      issuer.issue(makeRequest({ verificationLevel: "orb" })),
    ).rejects.toMatchObject({ code: "VERIFICATION_LEVEL_MISMATCH" });
  });

  it("enforces minVerificationLevel=orb when configured", async () => {
    const { issuer } = makeIssuer(
      { cloudVerifier: fakeCloud("device") },
      { minVerificationLevel: "orb" },
    );
    await expect(
      issuer.issue(makeRequest({ verificationLevel: "device" })),
    ).rejects.toMatchObject({
      code: "VERIFICATION_LEVEL_MISMATCH",
      status: 403,
    });
  });

  it("forwards sha256(agent_card_pubkey) as the proof signal", async () => {
    const cloud = fakeCloud();
    const { issuer } = makeIssuer({ cloudVerifier: cloud });
    await issuer.issue(makeRequest());
    expect(cloud.verifyProof).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: sha256Hex(CARD_A),
        action: VERIFIED_HUMAN_ACTION,
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Issuance: AC #2 — verified-human → AgentCard                                */
/* -------------------------------------------------------------------------- */

describe("WorldcoinIssuer.issue — credential issuance (AC #2)", () => {
  it("issues a verified-human credential bound to the caller's AgentCard", async () => {
    const { issuer, deps } = makeIssuer();
    const res = await issuer.issue(makeRequest());

    expect(res.idempotent).toBe(false);
    expect(res.credentialPda).toBe("Credential_PDA_1");
    expect(res.txSignature).toBe("tx_sig_1");
    expect(res.claimUri).toMatch(/^ipfs:\/\//);
    expect(res.claimHash).toHaveLength(64);

    expect(deps.chain.issueCredential).toHaveBeenCalledTimes(1);
    expect(deps.chain.issueCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: VERIFIED_HUMAN_SCHEMA_ID,
        subjectAgentCard: CARD_A,
        validUntilSlot: 0n,
        claimUri: res.claimUri,
        claimHash: res.claimHash,
      }),
    );
  });

  it("pins a JSON-LD VC envelope to IPFS containing the nullifier", async () => {
    const ipfs = fakeIpfs();
    const { issuer } = makeIssuer({ ipfs });
    await issuer.issue(makeRequest());

    const pinnedArg = (ipfs.pinJson as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(pinnedArg).toBeDefined();
    expect(pinnedArg["issuer"]).toBe(ISSUER_DID);
    const subj = pinnedArg["credentialSubject"] as Record<string, unknown>;
    expect(subj["id"]).toBe(`did:eto:agentcard:${CARD_A}`);
    expect(subj["worldIdNullifierHash"]).toBe(normalizeHex(NULLIFIER));
  });

  it("claim_hash is sha256(JCS(vc))", async () => {
    const ipfs = fakeIpfs();
    const { issuer } = makeIssuer({ ipfs });
    const res = await issuer.issue(makeRequest());

    const pinnedArg = (ipfs.pinJson as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(res.claimHash).toBe(sha256Hex(canonicalJson(pinnedArg)));
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotency: AC #3                                                          */
/* -------------------------------------------------------------------------- */

describe("WorldcoinIssuer.issue — idempotency (AC #3)", () => {
  it("returns the existing credential without re-issuing on same nullifier+card", async () => {
    const { issuer, deps } = makeIssuer();
    const first = await issuer.issue(makeRequest());
    const second = await issuer.issue(makeRequest());

    expect(deps.chain.issueCredential).toHaveBeenCalledTimes(1);
    expect(second.idempotent).toBe(true);
    expect(second.credentialPda).toBe(first.credentialPda);
    expect(second.txSignature).toBe(first.txSignature);
    expect(second.claimUri).toBe(first.claimUri);
    expect(second.claimHash).toBe(first.claimHash);
  });

  it("idempotency lookup is case-insensitive and 0x-tolerant", async () => {
    const { issuer } = makeIssuer();
    const first = await issuer.issue(makeRequest());
    const second = await issuer.issue(
      makeRequest({ nullifierHash: NULLIFIER.toUpperCase() }),
    );
    expect(second.idempotent).toBe(true);
    expect(second.credentialPda).toBe(first.credentialPda);
  });

  it("rejects same nullifier bound to a different AgentCard with 409", async () => {
    const { issuer, deps } = makeIssuer();
    await issuer.issue(makeRequest({ agentCardPubkey: CARD_A }));

    // Need a fresh signal binding for CARD_B too — fake signature
    // verifier accepts everything by default, so just retarget.
    await expect(
      issuer.issue(makeRequest({ agentCardPubkey: CARD_B })),
    ).rejects.toMatchObject({
      code: "NULLIFIER_BOUND_TO_OTHER_CARD",
      status: 409,
    });

    // No second IssueCredential tx was sent.
    expect(deps.chain.issueCredential).toHaveBeenCalledTimes(1);
  });

  it("does not leak whether a stranger's nullifier is bound (signature first)", async () => {
    const { issuer } = makeIssuer();
    await issuer.issue(makeRequest({ agentCardPubkey: CARD_A }));

    // Bad signature → INVALID_AGENT_CARD_SIGNATURE, NOT 409, even though
    // the nullifier is occupied. Signature check happens before lookup.
    const badSig = makeIssuer({
      agentCardSignatureVerifier: fakeAgentCardSig(false),
      nullifierStore: (issuer as unknown as { deps: WorldcoinIssuerDeps })
        .deps?.nullifierStore ?? fakeStore(),
    });
    await expect(
      badSig.issuer.issue(makeRequest({ agentCardPubkey: CARD_B })),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CARD_SIGNATURE" });
  });

  it("survives a lost put() race by returning the canonical binding", async () => {
    const store = new InMemoryNullifierStore();
    // Pre-seed a binding from "a parallel request" so put() throws.
    await store.put({
      nullifierHash: normalizeHex(NULLIFIER),
      agentCardPubkey: CARD_A,
      credentialPda: "Credential_PDA_RACE",
      txSignature: "tx_race",
      claimUri: "ipfs://race",
      claimHash: "f".repeat(64),
      issuedAtMs: 0,
    });

    const { issuer } = makeIssuer({ nullifierStore: store });
    // Spoof get() to return undefined the first time (so the issuer
    // proceeds past the early-idempotent path) and the canonical
    // record on the second call (after put() throws).
    let calls = 0;
    const realGet = store.get.bind(store);
    store.get = async (k) => {
      calls += 1;
      if (calls === 1) return undefined;
      return realGet(k);
    };

    const res = await issuer.issue(makeRequest());
    expect(res.idempotent).toBe(true);
    expect(res.credentialPda).toBe("Credential_PDA_RACE");
  });
});

/* -------------------------------------------------------------------------- */
/* InMemoryNullifierStore                                                      */
/* -------------------------------------------------------------------------- */

describe("InMemoryNullifierStore", () => {
  it("get returns undefined for missing keys", async () => {
    const s = new InMemoryNullifierStore();
    expect(await s.get("00".repeat(32))).toBeUndefined();
  });

  it("put rejects duplicate keys", async () => {
    const s = new InMemoryNullifierStore();
    const b = {
      nullifierHash: "aa".repeat(32),
      agentCardPubkey: CARD_A,
      credentialPda: "P",
      txSignature: "T",
      claimUri: "ipfs://x",
      claimHash: "bb".repeat(32),
      issuedAtMs: 1,
    };
    await s.put(b);
    await expect(s.put(b)).rejects.toThrow(/already bound/);
  });
});

/* -------------------------------------------------------------------------- */
/* createFetchCloudVerifier                                                    */
/* -------------------------------------------------------------------------- */

describe("createFetchCloudVerifier", () => {
  it("posts to /api/v2/verify/{appId} with bearer auth", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          verification_level: "orb",
          nullifier_hash: NULLIFIER,
          action: VERIFIED_HUMAN_ACTION,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const cv = createFetchCloudVerifier({
      appId: APP_ID,
      apiKey: "secret",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const out = await cv.verifyProof({
      proof: "p",
      merkleRoot: MERKLE_ROOT,
      nullifierHash: NULLIFIER,
      signal: sha256Hex(CARD_A),
      action: VERIFIED_HUMAN_ACTION,
    });

    expect(out.success).toBe(true);
    expect(out.verificationLevel).toBe("orb");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/api/v2/verify/${APP_ID}`);
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>)["authorization"]).toBe(
      "Bearer secret",
    );
  });

  it("maps 5xx upstream into UPSTREAM_OUTAGE", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("upstream broken", { status: 502 }));
    const cv = createFetchCloudVerifier({
      appId: APP_ID,
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      cv.verifyProof({
        proof: "p",
        merkleRoot: MERKLE_ROOT,
        nullifierHash: NULLIFIER,
        signal: sha256Hex(CARD_A),
        action: VERIFIED_HUMAN_ACTION,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_OUTAGE", status: 503 });
  });

  it("maps 4xx upstream / success:false into PROOF_REJECTED", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, code: "invalid_proof" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const cv = createFetchCloudVerifier({
      appId: APP_ID,
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      cv.verifyProof({
        proof: "p",
        merkleRoot: MERKLE_ROOT,
        nullifierHash: NULLIFIER,
        signal: sha256Hex(CARD_A),
        action: VERIFIED_HUMAN_ACTION,
      }),
    ).rejects.toMatchObject({ code: "PROOF_REJECTED" });
  });
});
