/**
 * FN-018 — Civic issuer boundary suite.
 *
 * Mirrors the structure of `tests/issuers/worldcoin.test.ts`: a
 * file-local mock chain ledger, a file-local in-memory IPFS pinner,
 * real Ed25519 keypairs for the wallet-binding signature, and one
 * `it` per mandatory boundary case (happy issuance, replay-idempotent,
 * replay-conflict, tampered signature, expiry, no-PII, uniqueness).
 *
 * Contract reality check (per PROMPT): `CivicIssuer.issue` THROWS
 * `CivicIssuerError` on every failure path. We lock the typed-error
 * invariant rather than pretending the issuer returns a tagged union.
 *
 * Bun-runner note: this file uses `vitest` imports identically to
 * `worldcoin.test.ts`; bun's runner re-exports the named symbols.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CivicIssuer,
  CivicIssuerError,
  InMemoryNullifierStore,
  StubCivicVerifier,
  VERIFIED_HUMAN_SCHEMA_ID,
  base58Decode,
  buildVerifiedHumanVc,
  civicNullifierFromGatewayToken,
  defaultClaimHasher,
  jcsCanonicalize,
} from "../../src/issuers/civic.js";
import type {
  AgentCardSignatureVerifier,
  ChainClient,
  CivicConfig,
  CivicIssuerDeps,
  CivicVerifier,
  CivicVerifyResult,
  IpfsPinner,
  IssueCredentialArgs,
  IssueCredentialResult,
} from "../../src/issuers/civic.types.js";

/* -------------------------------------------------------------------------- */
/* base58 encoder (decode-only ships in src; tests need to encode pubkeys)    */
/* -------------------------------------------------------------------------- */

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
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]!]!;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Wallet — real Ed25519                                                       */
/* -------------------------------------------------------------------------- */

interface Wallet {
  readonly pubkey: string; // base58 32-byte
  readonly rawPub: Uint8Array;
  readonly privateKey: ReturnType<typeof createPrivateKey>;
}

function newWallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = new Uint8Array(spki.subarray(spki.length - 32));
  return {
    pubkey: base58Encode(raw),
    rawPub: raw,
    privateKey,
  };
}

function signBinding(wallet: Wallet, nullifierHex: string): string {
  const nullifierBytes = Buffer.from(nullifierHex, "hex");
  const message = createHash("sha256")
    .update(nullifierBytes)
    .update(wallet.rawPub)
    .digest();
  return Buffer.from(nodeSign(null, message, wallet.privateKey)).toString(
    "base64",
  );
}

const realAgentCardSig: AgentCardSignatureVerifier = {
  async verify({ nullifier, agentCardPubkey, signature }) {
    try {
      const nb = Buffer.from(nullifier, "hex");
      if (nb.length !== 32) return false;
      const cb = base58Decode(agentCardPubkey);
      if (cb.length !== 32) return false;
      const sigBytes = Buffer.from(signature, "base64");
      if (sigBytes.length !== 64) return false;
      const msg = createHash("sha256").update(nb).update(cb).digest();
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(cb),
      ]);
      const key = createPublicKey({ key: spki, format: "der", type: "spki" });
      return nodeVerify(null, msg, key, sigBytes);
    } catch {
      return false;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Mock chain ledger                                                           */
/* -------------------------------------------------------------------------- */

interface OnChainCredential {
  readonly schema: string;
  readonly subjectAgentCard: string;
  readonly claimHash: string;
  readonly claimUri: string;
  readonly validUntilSlot: bigint;
}

class MockChainLedger implements ChainClient {
  public readonly accounts = new Map<string, OnChainCredential>();
  public readonly calls: IssueCredentialArgs[] = [];
  private slot = 100n;

  async issueCredential(
    args: IssueCredentialArgs,
  ): Promise<IssueCredentialResult> {
    this.calls.push(args);
    this.slot += 1n;
    const pda = `pda_${this.calls.length.toString().padStart(4, "0")}_${args.subjectAgentCard.slice(0, 6)}`;
    this.accounts.set(pda, {
      schema: args.schema,
      subjectAgentCard: args.subjectAgentCard,
      claimHash: args.claimHash,
      claimUri: args.claimUri,
      validUntilSlot: args.validUntilSlot,
    });
    return {
      credentialPda: pda,
      txSignature: `tx_${this.calls.length.toString().padStart(4, "0")}`,
    };
  }

  async currentSlot(): Promise<bigint> {
    return this.slot;
  }
}

class MockIpfs implements IpfsPinner {
  public readonly store = new Map<string, string>();

  async pin(jcs: string): Promise<{ uri: string }> {
    const cid = createHash("sha256").update(jcs).digest("hex").slice(0, 46);
    this.store.set(cid, jcs);
    return { uri: `ipfs://${cid}` };
  }

  fetch(uri: string): unknown {
    const cid = uri.slice("ipfs://".length);
    const jcs = this.store.get(cid);
    if (jcs === undefined) throw new Error(`ipfs cid not found: ${cid}`);
    return JSON.parse(jcs);
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const NETWORK = "civicNet11111111111111111111111111111111111";
const GATEWAY_TOKEN = "gtokAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GATEWAY_TOKEN_2 = "gtokBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ISSUER_AUTHORITY = "issuerAuthorityKey1111111111111111111111111";

const ENABLED_CONFIG: { civic: CivicConfig } = {
  civic: {
    gatekeeperNetwork: NETWORK,
    issuerKeypairPath: "/dev/null/issuer.json",
    networkId: "00".repeat(32),
    enabled: true,
  },
};

function okVerifyResult(): CivicVerifyResult {
  return {
    tokenAddress: GATEWAY_TOKEN,
    owner: "verified-by-stub",
    gatekeeperNetwork: NETWORK,
    state: "Active",
    expiresAt: 1_999_999_999,
    civicPassLevel: "uniqueness",
  };
}

interface BuiltStack {
  readonly issuer: CivicIssuer;
  readonly chain: MockChainLedger;
  readonly ipfs: MockIpfs;
  readonly verifier: StubCivicVerifier;
  readonly nowUnix: () => number;
}

function civicDeps(opts?: {
  readonly verifier?: StubCivicVerifier;
  readonly chain?: MockChainLedger;
  readonly nowUnix?: () => number;
}): BuiltStack {
  const chain = opts?.chain ?? new MockChainLedger();
  const ipfs = new MockIpfs();
  const verifier = opts?.verifier ?? new StubCivicVerifier(okVerifyResult());
  const nowUnix = opts?.nowUnix ?? (() => 1_700_000_000);
  const deps: CivicIssuerDeps = {
    config: ENABLED_CONFIG,
    store: new InMemoryNullifierStore(),
    chainClient: chain,
    civicVerifier: verifier,
    signatureVerifier: realAgentCardSig,
    ipfsPinner: ipfs,
    claimHasher: defaultClaimHasher,
    issuerAuthorityPubkey: ISSUER_AUTHORITY,
    nowUnix,
  };
  return { issuer: new CivicIssuer(deps), chain, ipfs, verifier, nowUnix };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                        */
/* -------------------------------------------------------------------------- */

describe("Civic issuer — boundary suite (FN-018)", () => {
  it("happy issuance: mints a verified-human credential bound to the caller's AgentCard", async () => {
    const fixedNow = 1_700_000_000;
    const { issuer, chain, ipfs, verifier } = civicDeps({
      nowUnix: () => fixedNow,
    });
    const wallet = newWallet();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);

    const out = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: wallet.pubkey,
      agentCardSignature: signBinding(wallet, nullifier),
    });

    expect(out.idempotent).toBe(false);
    expect(out.claimHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.claimUri.startsWith("ipfs://")).toBe(true);
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.schema).toBe(VERIFIED_HUMAN_SCHEMA_ID);
    // Lock subject provenance: caller-supplied, not store-derived.
    expect(chain.calls[0]?.subjectAgentCard).toBe(wallet.pubkey);
    expect(chain.calls[0]?.idempotencyKey).toBe(`civic:${nullifier}`);
    expect(chain.calls[0]?.validUntilSlot).toBe(0n);
    expect(verifier.calls).toHaveLength(1);

    // claimHash equals sha256(JCS(VC))
    const vc = ipfs.fetch(out.claimUri) as Record<string, unknown>;
    expect(defaultClaimHasher.hash(vc)).toBe(out.claimHash);

    // issuanceDate ISO equals injected clock
    expect(vc["issuanceDate"]).toBe(new Date(fixedNow * 1000).toISOString());

    // No-PII bonus invariant — credentialSubject only contains bridge-safe fields.
    const subj = vc["credentialSubject"] as Record<string, unknown>;
    expect(Object.keys(subj).sort()).toEqual(["id", "type"]);
    expect(subj["id"]).toBe(`did:eto:agentcard:${wallet.pubkey}`);

    // Lock VC envelope shape (no email/DOB/keypair material).
    // NB: civic.ts intentionally records the *public* gateway-token
    // account address in `evidence[].tokenAddress` per
    // `spec/issuers/civic-integration.md` — that's the on-chain
    // verifiable handle, not a secret. The leak invariant is
    // therefore phrased against secret-bearing fields only.
    const pinnedJcs = jcsCanonicalize(vc);
    expect(pinnedJcs.toLowerCase()).not.toContain("keypair");
    expect(pinnedJcs.toLowerCase()).not.toContain("email");
    expect(pinnedJcs.toLowerCase()).not.toContain("dateofbirth");
  });

  it("replay (same wallet): idempotent — same PDA, no second chain tx", async () => {
    const { issuer, chain, verifier } = civicDeps();
    const wallet = newWallet();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const sig = signBinding(wallet, nullifier);

    const first = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: wallet.pubkey,
      agentCardSignature: sig,
    });
    const second = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: wallet.pubkey,
      agentCardSignature: sig,
    });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.credentialPda).toBe(first.credentialPda);
    expect(chain.calls).toHaveLength(1);
    // Idempotent re-hit short-circuits BEFORE the verifier per spec §6.
    expect(verifier.calls).toHaveLength(1);
  });

  it("replay (different wallet, same gatewayToken): 409 NULLIFIER_BOUND_TO_OTHER_CARD", async () => {
    const { issuer, chain } = civicDeps();
    const a = newWallet();
    const b = newWallet();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);

    await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: a.pubkey,
      agentCardSignature: signBinding(a, nullifier),
    });

    let caught: unknown;
    try {
      await issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: b.pubkey,
        agentCardSignature: signBinding(b, nullifier),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CivicIssuerError);
    const cErr = caught as CivicIssuerError;
    expect(cErr.code).toBe("NULLIFIER_BOUND_TO_OTHER_CARD");
    expect(cErr.status).toBe(409);
    expect(chain.calls).toHaveLength(1);
  });

  it("tampered signature: 401 INVALID_AGENT_CARD_SIGNATURE; chain not called", async () => {
    const { issuer, chain, verifier } = civicDeps();
    const victim = newWallet();
    const attacker = newWallet();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);

    let caught: unknown;
    try {
      await issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: victim.pubkey,
        agentCardSignature: signBinding(attacker, nullifier),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CivicIssuerError);
    const cErr = caught as CivicIssuerError;
    expect(cErr.code).toBe("INVALID_AGENT_CARD_SIGNATURE");
    expect(cErr.status).toBe(401);
    expect(chain.calls).toHaveLength(0);
    expect(verifier.calls).toHaveLength(0);
  });

  it("expiry: gateway-token expiry from injected verifier propagates as CivicIssuerError", async () => {
    // Emulate Civic's gateway-token TTL via an injected verifier
    // throwing the documented error code with a 410 Gone status.
    const expiredVerifier = new StubCivicVerifier(
      new CivicIssuerError(
        "GATEWAY_TOKEN_INACTIVE",
        "civic gateway token expired",
        410,
      ),
    );
    const { issuer, chain } = civicDeps({ verifier: expiredVerifier });
    const wallet = newWallet();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);

    let caught: unknown;
    try {
      await issuer.issue({
        gatewayToken: GATEWAY_TOKEN,
        agentCardPubkey: wallet.pubkey,
        agentCardSignature: signBinding(wallet, nullifier),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CivicIssuerError);
    const cErr = caught as CivicIssuerError;
    expect(cErr.code).toBe("GATEWAY_TOKEN_INACTIVE");
    expect(cErr.status).toBe(410);
    expect(chain.calls).toHaveLength(0);
  });

  it("no PII leak: credentialSubject carries no email/DOB/keypair material", async () => {
    // Civic's verified-human VC subject is minimal — `{ id, type }`.
    // The gateway-token *account address* (a public Solana pubkey) is
    // recorded in `evidence[].tokenAddress` and is the verifiable
    // public handle by design; it is NOT secret. This test pins the
    // narrower invariant: no email, no DOB, no keypair material.
    const { issuer, ipfs } = civicDeps();
    const wallet = newWallet();
    const nullifier = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const out = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: wallet.pubkey,
      agentCardSignature: signBinding(wallet, nullifier),
    });
    const vc = ipfs.fetch(out.claimUri) as Record<string, unknown>;
    const json = JSON.stringify(vc).toLowerCase();
    expect(json).not.toContain("email");
    expect(json).not.toContain("dateofbirth");
    expect(json).not.toContain("keypair");
    const subj = vc["credentialSubject"] as Record<string, unknown>;
    expect(Object.keys(subj).sort()).toEqual(["id", "type"]);
  });

  it("emits unique credentials across two independent issuances", async () => {
    let now = 1_700_000_000;
    const { issuer, chain, ipfs } = civicDeps({ nowUnix: () => now });
    const a = newWallet();
    const b = newWallet();

    const na = civicNullifierFromGatewayToken(GATEWAY_TOKEN);
    const nb = civicNullifierFromGatewayToken(GATEWAY_TOKEN_2);

    const r1 = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN,
      agentCardPubkey: a.pubkey,
      agentCardSignature: signBinding(a, na),
    });
    now += 60;
    const r2 = await issuer.issue({
      gatewayToken: GATEWAY_TOKEN_2,
      agentCardPubkey: b.pubkey,
      agentCardSignature: signBinding(b, nb),
    });

    expect(r1.credentialPda).not.toBe(r2.credentialPda);
    expect(chain.calls).toHaveLength(2);
    const vc1 = ipfs.fetch(r1.claimUri) as Record<string, unknown>;
    const vc2 = ipfs.fetch(r2.claimUri) as Record<string, unknown>;
    expect(vc1["issuanceDate"]).not.toBe(vc2["issuanceDate"]);
    // bridgeNullifier (the per-VC unique identifier we emit) differs.
    expect(vc1["bridgeNullifier"]).not.toBe(vc2["bridgeNullifier"]);
  });

  it("buildVerifiedHumanVc shape parity with the issuer (no drift)", () => {
    // Defensive: locks the subject-key contract used by the no-PII test.
    const vc = buildVerifiedHumanVc({
      agentCardPubkey: "Card",
      issuerAuthorityPubkey: "Issuer",
      civicVerifyResult: okVerifyResult(),
      civicNullifier: "00".repeat(32),
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    expect(Object.keys(vc.credentialSubject).sort()).toEqual(["id", "type"]);
  });
});
