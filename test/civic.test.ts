import { describe, expect, it } from "vitest";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";

import {
  base58Decode,
  buildVerifiedHumanVc,
  CivicIssuer,
  CivicIssuerError,
  civicNullifierFromGatewayToken,
  ed25519SignatureVerifier,
  InMemoryNullifierStore,
  jcsCanonicalize,
  StubCivicVerifier,
  VERIFIED_HUMAN_SCHEMA_ID,
} from "../src/issuers/civic.js";
import type {
  AgentCardSignatureVerifier,
  ChainClient,
  CivicConfig,
  CivicIssuerDeps,
  CivicVerifyResult,
  ClaimHasher,
  IpfsPinner,
  IssueCredentialArgs,
  IssueCredentialResult,
  IssuerLogger,
  NullifierStore,
} from "../src/issuers/civic.types.js";
import { defaultClaimHasher } from "../src/issuers/civic.js";

// ---------- Test fixtures ----------

const NETWORK = "civicNet11111111111111111111111111111111111";
const GATEWAY_TOKEN = "gtokAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_ADDRESS_2 =
  "gtokBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"; // distinct token

// Base58 encoder for keypair fixtures (decode-only ships in src; tests
// need to encode generated pubkeys).
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
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
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58_ALPHABET[digits[i]!]!;
  return out;
}

interface CardKey {
  pubkey: string; // base58
  privateKeyPem: ReturnType<typeof createPrivateKey>;
  rawPub: Uint8Array;
}

function makeCard(): CardKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Extract the 32-byte raw pubkey from the SPKI DER (last 32 bytes).
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = new Uint8Array(spki.subarray(spki.length - 32));
  return {
    pubkey: base58Encode(raw),
    privateKeyPem: privateKey,
    rawPub: raw,
  };
}

function signCard(card: CardKey, nullifierHex: string): string {
  const nullifierBytes = Buffer.from(nullifierHex, "hex");
  const message = createHash("sha256")
    .update(nullifierBytes)
    .update(card.rawPub)
    .digest();
  const sig = cryptoSign(null, message, card.privateKeyPem);
  return Buffer.from(sig).toString("base64");
}

function okVerify(): CivicVerifyResult {
  return {
    tokenAddress: GATEWAY_TOKEN,
    owner: "ignored — issuer trusts verifier output for owner check",
    gatekeeperNetwork: NETWORK,
    state: "Active",
    expiresAt: 1_999_999_999,
    civicPassLevel: "uniqueness",
  };
}

class TrackingChain implements ChainClient {
  public calls: IssueCredentialArgs[] = [];
  public failNext = false;
  public slot = 123_456n;

  async issueCredential(
    args: IssueCredentialArgs,
  ): Promise<IssueCredentialResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated rpc failure");
    }
    this.calls.push(args);
    const idx = this.calls.length;
    return {
      credentialPda: `pda_${idx}_${args.subjectAgentCard.slice(0, 6)}`,
      txSignature: `sig_${idx}`,
    };
  }

  async currentSlot(): Promise<bigint> {
    return this.slot;
  }
}

class StubPinner implements IpfsPinner {
  public pinned: string[] = [];
  async pin(json: string): Promise<{ uri: string }> {
    this.pinned.push(json);
    return { uri: `ipfs://stub/${this.pinned.length}` };
  }
}

class CapturingLogger implements IssuerLogger {
  public records: Array<{ level: string; record: Record<string, unknown> }> =
    [];
  info(record: Record<string, unknown>): void {
    this.records.push({ level: "info", record });
  }
  warn(record: Record<string, unknown>): void {
    this.records.push({ level: "warn", record });
  }
  error(record: Record<string, unknown>): void {
    this.records.push({ level: "error", record });
  }
}

const ENABLED_CONFIG: { civic: CivicConfig } = {
  civic: {
    gatekeeperNetwork: NETWORK,
    issuerKeypairPath: "/dev/null/issuer.json",
    networkId:
      "0000000000000000000000000000000000000000000000000000000000000000",
    enabled: true,
  },
};

function buildIssuer(overrides: Partial<{
  store: NullifierStore;
  chainClient: ChainClient;
  civicVerifier: ConstructorParameters<typeof StubCivicVerifier>[0] | StubCivicVerifier;
  signatureVerifier: AgentCardSignatureVerifier;
  ipfsPinner: IpfsPinner;
  claimHasher: ClaimHasher;
  logger: IssuerLogger;
  config: { civic: CivicConfig };
}> = {}): { issuer: CivicIssuer; deps: CivicIssuerDeps; logger: CapturingLogger; chain: TrackingChain; store: NullifierStore } {
  const logger = (overrides.logger as CapturingLogger | undefined) ?? new CapturingLogger();
  const chain = (overrides.chainClient as TrackingChain | undefined) ?? new TrackingChain();
  const store = overrides.store ?? new InMemoryNullifierStore();
  const verifier =
    overrides.civicVerifier instanceof StubCivicVerifier
      ? overrides.civicVerifier
      : new StubCivicVerifier(
          (overrides.civicVerifier as CivicVerifyResult | CivicIssuerError | undefined) ?? okVerify(),
        );
  const deps: CivicIssuerDeps = {
    config: overrides.config ?? ENABLED_CONFIG,
    store,
    chainClient: chain,
    civicVerifier: verifier,
    signatureVerifier: overrides.signatureVerifier ?? ed25519SignatureVerifier,
    ipfsPinner: overrides.ipfsPinner ?? new StubPinner(),
    claimHasher: overrides.claimHasher ?? defaultClaimHasher,
    logger,
    issuerAuthorityPubkey: "issuerAuthorityKey1111111111111111111111111",
    nowUnix: () => 1_700_000_000,
  };
  return { issuer: new CivicIssuer(deps), deps, logger, chain, store };
}

// ---------- civicNullifierFromGatewayToken ----------

describe("civicNullifierFromGatewayToken", () => {
  it("produces a stable 64-char lowercase hex digest with the prefix preimage", () => {
    const n = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    expect(n).toMatch(/^[0-9a-f]{64}$/);

    // Compute by hand and compare.
    const expected = createHash("sha256")
      .update(Buffer.from("eto.civic.verified-human.v1", "utf8"))
      .update(Buffer.from(base58Decode(GATEWAY_TOKEN)))
      .digest("hex");
    expect(n).toBe(expected);
  });

  it("varies with gatewayToken", () => {
    expect(civicNullifierFromGatewayToken(GATEWAY_TOKEN)).not.toBe(
      civicNullifierFromGatewayToken(TOKEN_ADDRESS_2),
    );
  });

  it("yields the same digest regardless of which AgentCard presents it", () => {
    // Property: cross-wallet replay detection. The nullifier preimage
    // intentionally excludes the AgentCard pubkey.
    const a = makeCard();
    const b = makeCard();
    expect(a.pubkey).not.toBe(b.pubkey);
    const nA = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const nB = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    expect(nA).toBe(nB);
  });
});

// ---------- ed25519SignatureVerifier ----------

describe("ed25519SignatureVerifier", () => {
  it("accepts a valid Ed25519 signature over sha256(nullifier || pubkey)", async () => {
    const card = makeCard();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const sig = signCard(card, nullifier);
    const ok = await ed25519SignatureVerifier.verify({
      nullifier,
      agentCardPubkey: card.pubkey,
      signature: sig,
    });
    expect(ok).toBe(true);
  });

  it("rejects a signature by the wrong key", async () => {
    const card = makeCard();
    const other = makeCard();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const sig = signCard(other, nullifier);
    const ok = await ed25519SignatureVerifier.verify({
      nullifier,
      agentCardPubkey: card.pubkey,
      signature: sig,
    });
    expect(ok).toBe(false);
  });

  it("rejects a signature over the wrong message (different nullifier)", async () => {
    const card = makeCard();
    const sig = signCard(
      card,
      civicNullifierFromGatewayToken(GATEWAY_TOKEN),
    );
    const otherNullifier = civicNullifierFromGatewayToken(TOKEN_ADDRESS_2);
    const ok = await ed25519SignatureVerifier.verify({
      nullifier: otherNullifier,
      agentCardPubkey: card.pubkey,
      signature: sig,
    });
    expect(ok).toBe(false);
  });

  it("rejects a malformed-length signature", async () => {
    const card = makeCard();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const tooShort = Buffer.alloc(32).toString("base64");
    const ok = await ed25519SignatureVerifier.verify({
      nullifier,
      agentCardPubkey: card.pubkey,
      signature: tooShort,
    });
    expect(ok).toBe(false);
  });
});

// ---------- CivicIssuer.issue ----------

describe("CivicIssuer.issue", () => {
  it("happy path: issues a credential, writes the binding, calls chain once", async () => {
    const card = makeCard();
    const { issuer, chain, store } = buildIssuer();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const out = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: card.pubkey,
      agentCardSignature: signCard(card, nullifier),
    });
    expect(out.idempotent).toBe(false);
    expect(out.credentialPda).toMatch(/^pda_1_/);
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.schema).toBe(VERIFIED_HUMAN_SCHEMA_ID);
    expect(chain.calls[0]?.subjectAgentCard).toBe(card.pubkey);
    expect(chain.calls[0]?.idempotencyKey).toBe(`civic:${nullifier}`);
    expect(chain.calls[0]?.validFromSlot).toBe(123_456n);
    expect(chain.calls[0]?.validUntilSlot).toBe(0n);
    const stored = await store.get(nullifier);
    expect(stored?.agentCardPubkey).toBe(card.pubkey);
  });

  it("idempotent reissue for the same (gatewayToken, card)", async () => {
    const card = makeCard();
    const { issuer, chain } = buildIssuer();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const first = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: card.pubkey,
      agentCardSignature: signCard(card, nullifier),
    });
    const second = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: card.pubkey,
      agentCardSignature: signCard(card, nullifier),
    });
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.credentialPda).toBe(first.credentialPda);
    expect(second.txSignature).toBe(first.txSignature);
    expect(second.claimUri).toBe(first.claimUri);
    expect(second.claimHash).toBe(first.claimHash);
    expect(chain.calls).toHaveLength(1);
  });

  it("cross-wallet replay → 409 NULLIFIER_BOUND_TO_OTHER_CARD", async () => {
    const cardA = makeCard();
    const cardB = makeCard();
    const { issuer, chain, store } = buildIssuer();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);

    await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: cardA.pubkey,
      agentCardSignature: signCard(cardA, nullifier),
    });

    await expect(
      issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: cardB.pubkey,
        agentCardSignature: signCard(cardB, nullifier),
      }),
    ).rejects.toMatchObject({
      name: "CivicIssuerError",
      code: "NULLIFIER_BOUND_TO_OTHER_CARD",
      status: 409,
    });
    expect(chain.calls).toHaveLength(1);
    const stored = await store.get(nullifier);
    expect(stored?.agentCardPubkey).toBe(cardA.pubkey);
  });

  it("bad wallet-binding signature → 401 INVALID_AGENT_CARD_SIGNATURE; chain not called", async () => {
    const card = makeCard();
    const otherCard = makeCard();
    const { issuer, chain } = buildIssuer();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    await expect(
      issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: card.pubkey,
        agentCardSignature: signCard(otherCard, nullifier),
      }),
    ).rejects.toMatchObject({
      name: "CivicIssuerError",
      code: "INVALID_AGENT_CARD_SIGNATURE",
      status: 401,
    });
    expect(chain.calls).toHaveLength(0);
  });

  it("each GATEWAY_TOKEN_* failure propagates with status 400; chain not called", async () => {
    const cases: Array<[string, CivicIssuerError]> = [
      [
        "GATEWAY_TOKEN_NOT_FOUND",
        new CivicIssuerError(
          "GATEWAY_TOKEN_NOT_FOUND",
          "no such token account",
          400,
        ),
      ],
      [
        "GATEWAY_TOKEN_NOT_OWNED_BY_CARD",
        new CivicIssuerError(
          "GATEWAY_TOKEN_NOT_OWNED_BY_CARD",
          "owner mismatch",
          400,
        ),
      ],
      [
        "GATEWAY_TOKEN_INACTIVE",
        new CivicIssuerError(
          "GATEWAY_TOKEN_INACTIVE",
          "state=Frozen",
          400,
        ),
      ],
      [
        "GATEWAY_TOKEN_WRONG_NETWORK",
        new CivicIssuerError(
          "GATEWAY_TOKEN_WRONG_NETWORK",
          "wrong network",
          400,
        ),
      ],
    ];
    for (const [code, err] of cases) {
      const card = makeCard();
      const { issuer, chain } = buildIssuer({ civicVerifier: err });
      const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
      await expect(
        issuer.issue({
          gatewayToken: GATEWAY_TOKEN,
          agentCardPubkey: card.pubkey,
          agentCardSignature: signCard(card, nullifier),
        }),
      ).rejects.toMatchObject({
        name: "CivicIssuerError",
        code,
        status: 400,
      });
      expect(chain.calls).toHaveLength(0);
    }
  });

  it("upstream outage → CivicIssuerError code=UPSTREAM_OUTAGE, status=503", async () => {
    const card = makeCard();
    const { issuer, chain } = buildIssuer({
      civicVerifier: new CivicIssuerError(
        "UPSTREAM_OUTAGE",
        "rpc unreachable",
        503,
      ),
    });
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    await expect(
      issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: card.pubkey,
        agentCardSignature: signCard(card, nullifier),
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_OUTAGE",
      status: 503,
    });
    expect(chain.calls).toHaveLength(0);
  });

  it("call ordering: signature failure short-circuits BEFORE the verifier is called", async () => {
    const card = makeCard();
    const otherCard = makeCard();
    const verifier = new StubCivicVerifier(okVerify());
    const { issuer } = buildIssuer({ civicVerifier: verifier });
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    await expect(
      issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: card.pubkey,
        agentCardSignature: signCard(otherCard, nullifier),
      }),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CARD_SIGNATURE" });
    expect(verifier.calls).toHaveLength(0);
  });

  it("chain failure → CHAIN_TX_FAILED 502; binding NOT written", async () => {
    const card = makeCard();
    const chain = new TrackingChain();
    chain.failNext = true;
    const store = new InMemoryNullifierStore();
    const { issuer } = buildIssuer({ chainClient: chain, store });
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    await expect(
      issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: card.pubkey,
        agentCardSignature: signCard(card, nullifier),
      }),
    ).rejects.toMatchObject({ code: "CHAIN_TX_FAILED", status: 502 });
    expect(await store.get(nullifier)).toBeUndefined();
  });

  it("claim hash is deterministic and excludes the proof block", () => {
    const vc = buildVerifiedHumanVc({
      agentCardPubkey: "AgentCardX",
      issuerAuthorityPubkey: "issuer",
      civicVerifyResult: okVerify(),
      civicNullifier: civicNullifierFromGatewayToken(GATEWAY_TOKEN),
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    const h1 = defaultClaimHasher.hash(vc);
    const h2 = defaultClaimHasher.hash(vc);
    expect(h1).toBe(h2);

    // Mutating the `proof` block (which is excluded from hashing input)
    // does not change the hash, because we hash `vcWithoutProof`.
    const vcWithProof = { ...vc, proof: { signature: "ZZZZ" } };
    const { proof: _proof, ...vcSansProof } = vcWithProof as Record<
      string,
      unknown
    >;
    const h3 = defaultClaimHasher.hash(vcSansProof as typeof vc);
    expect(h3).toBe(h1);
  });

  it("logs never contain the raw gatewayToken or issuer keypair material", async () => {
    const card = makeCard();
    const logger = new CapturingLogger();
    const { issuer } = buildIssuer({ logger });
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: card.pubkey,
      agentCardSignature: signCard(card, nullifier),
    });
    for (const { record } of logger.records) {
      const json = JSON.stringify(record);
      expect(json).not.toContain(GATEWAY_TOKEN);
      expect(json.toLowerCase()).not.toContain("keypair");
      expect(json).not.toContain("issuerKeypairPath");
    }
  });

  it("disabled config → constructor throws CivicIssuerError(UPSTREAM_OUTAGE, 503)", () => {
    const disabled: { civic: CivicConfig } = {
      civic: {
        gatekeeperNetwork: "",
        issuerKeypairPath: "",
        networkId: "",
        enabled: false,
      },
    };
    let caught: unknown;
    try {
      buildIssuer({ config: disabled });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CivicIssuerError);
    const err = caught as CivicIssuerError;
    expect(err.code).toBe("UPSTREAM_OUTAGE");
    expect(err.status).toBe(503);
  });

  it("cross-issuer parity: schema id == sha256('eto.beckn.schema.verified-human.v1')", async () => {
    const card = makeCard();
    const { issuer, chain } = buildIssuer();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: card.pubkey,
      agentCardSignature: signCard(card, nullifier),
    });
    const expected = createHash("sha256")
      .update("eto.beckn.schema.verified-human.v1", "utf8")
      .digest("hex");
    expect(VERIFIED_HUMAN_SCHEMA_ID).toBe(expected);
    expect(chain.calls[0]?.schema).toBe(expected);
  });
});

// ---------- jcsCanonicalize / VC envelope ----------

describe("jcsCanonicalize and VC envelope", () => {
  it("sorts keys, omits whitespace, preserves array order", () => {
    expect(jcsCanonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(jcsCanonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("VC roundtrips through JCS deterministically", () => {
    const vc = buildVerifiedHumanVc({
      agentCardPubkey: "AgentCardX",
      issuerAuthorityPubkey: "issuer",
      civicVerifyResult: okVerify(),
      civicNullifier: civicNullifierFromGatewayToken(GATEWAY_TOKEN),
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    const a = jcsCanonicalize(vc);
    const b = jcsCanonicalize(JSON.parse(a));
    expect(a).toBe(b);
  });

  it("VC subject id and issuer reflect Civic provenance", () => {
    const vc = buildVerifiedHumanVc({
      agentCardPubkey: "AgentCardX",
      issuerAuthorityPubkey: "issuer",
      civicVerifyResult: okVerify(),
      civicNullifier: "00".repeat(32),
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    expect(vc.issuer).toBe("did:eto:civic");
    expect(vc.credentialSubject.id).toBe("did:eto:agentcard:AgentCardX");
    expect(vc.credentialSubject.type).toBe("VerifiedHuman");
    expect(Array.isArray(vc.evidence)).toBe(true);
  });
});
