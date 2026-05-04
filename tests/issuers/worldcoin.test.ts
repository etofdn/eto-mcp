/**
 * FN-044 / T-1.4.3.2 — End-to-end Worldcoin issuer flow test.
 *
 * Acceptance criterion (from PROMPT.md):
 *
 *     Mock Worldcoin proof → cred issued → cred validatable on chain.
 *
 * This test wires the `WorldcoinIssuer` against three in-memory fakes
 * that together simulate the full production stack:
 *
 *   • a fake Worldcoin OIDC verifier that returns a well-formed
 *     id_token for the configured app,
 *   • a fake Worldcoin Cloud `/api/v2/verify/{appId}` that mirrors
 *     the request's `nullifier_hash` and `action`,
 *   • an in-memory IPFS pinner that stores VC envelopes by CID, and
 *   • an in-memory chain ledger that derives a deterministic PDA
 *     from `(issuer, schema, subject)` and persists `Credential`
 *     records — mirroring the on-chain `IssueCredential` instruction.
 *
 * After issuance, the test independently validates the credential
 * "on chain" by pulling the `Credential` record out of the ledger
 * (no shared state with the issuer beyond the PDA), re-fetching the
 * VC envelope from the pinner, recomputing `sha256(JCS(vc))`, and
 * asserting all of the on-chain bindings hold:
 *
 *   1. `schema == sha256("eto.beckn.schema.verified-human.v1")`
 *   2. `subject_agent_card == caller's AgentCard pubkey`
 *   3. `claim_hash == sha256(JCS(claim_uri payload))`
 *   4. `claim_uri` resolves to a JSON-LD `VerifiedHumanCredential`
 *      envelope binding the same nullifier + Worldcoin action.
 *   5. `valid_until_slot == 0` (no expiry) per spec §3.
 *
 * The test is deliberately distinct from the unit suite at
 * `eto-mcp/test/worldcoin.test.ts`: that suite covers individual
 * validation branches; this one covers the *integrated* happy path
 * end-to-end, which is the contract a downstream verifier relies on.
 */

import {
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildVerifiedHumanVc,
  canonicalJson,
  sha256Hex,
  VERIFIED_HUMAN_ACTION,
  VERIFIED_HUMAN_SCHEMA_ID,
  VERIFIED_HUMAN_SCHEMA_TAG,
  WORLDCOIN_ISSUER_URL,
  WorldcoinIssuer,
  WorldcoinIssuerError,
  type WorldcoinIssuerConfig,
  type WorldcoinIssuerDeps,
  normalizeHex,
} from "../../src/issuers/worldcoin.js";
import {
  type AgentCardPubkey,
  type AgentCardSignatureVerifier,
  type ChainClient,
  type CloudVerifier,
  type Hex32,
  type IdTokenVerifier,
  type IpfsPinner,
  type IssueCredentialArgs,
  type IssueCredentialResult,
} from "../../src/issuers/worldcoin.types.js";
import { InMemoryNullifierStore } from "../../src/issuers/worldcoin.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const APP_ID = "app_e2e_worldcoin";
const ISSUER_DID = "did:eto:worldcoin";
const ISSUER_AUTHORITY: AgentCardPubkey = "Issuer_Authority_Pubkey";
const NULLIFIER: Hex32 =
  "0xfeedface00112233445566778899aabbccddeeff0011223344556677889900aa";
const MERKLE_ROOT: Hex32 =
  "0xcafebabe00112233445566778899aabbccddeeff0011223344556677889900bb";


/* -------------------------------------------------------------------------- */
/* Mock chain ledger — simulates the on-chain Credential account store.        */
/* -------------------------------------------------------------------------- */

interface OnChainCredential {
  readonly issuerAuthority: AgentCardPubkey;
  readonly schema: Hex32;
  readonly subjectAgentCard: AgentCardPubkey;
  readonly claimHash: Hex32;
  readonly claimUri: string;
  readonly validUntilSlot: bigint;
  readonly slot: bigint;
}

/**
 * Tiny stand-in for the on-chain Credential PDA store. The PDA
 * derivation matches what the runtime program produces: a
 * deterministic hash over `(issuer_authority, schema, subject)` so
 * a verifier can derive the address from public inputs alone and
 * read the account back.
 */
class MockChainLedger implements ChainClient {
  public readonly accounts = new Map<string, OnChainCredential>();
  private slot = 100n;
  public txCount = 0;

  public constructor(private readonly issuerAuthority: AgentCardPubkey) {}

  public static derivePda(input: {
    readonly issuerAuthority: AgentCardPubkey;
    readonly schema: Hex32;
    readonly subjectAgentCard: AgentCardPubkey;
  }): string {
    return sha256Hex(
      canonicalJson({
        issuer: input.issuerAuthority,
        schema: normalizeHex(input.schema),
        subject: input.subjectAgentCard,
      }),
    );
  }

  public async issueCredential(
    args: IssueCredentialArgs,
  ): Promise<IssueCredentialResult> {
    const pda = MockChainLedger.derivePda({
      issuerAuthority: this.issuerAuthority,
      schema: args.schema,
      subjectAgentCard: args.subjectAgentCard,
    });
    if (this.accounts.has(pda)) {
      throw new Error(`Credential PDA ${pda} already exists`);
    }
    this.txCount += 1;
    this.slot += 1n;
    const record: OnChainCredential = {
      issuerAuthority: this.issuerAuthority,
      schema: normalizeHex(args.schema),
      subjectAgentCard: args.subjectAgentCard,
      claimHash: normalizeHex(args.claimHash),
      claimUri: args.claimUri,
      validUntilSlot: args.validUntilSlot,
      slot: this.slot,
    };
    this.accounts.set(pda, record);
    return {
      credentialPda: pda,
      txSignature: `tx_${this.txCount.toString().padStart(4, "0")}`,
    };
  }

  /** Public accessor: a verifier reading the chain by PDA. */
  public getAccount(pda: string): OnChainCredential | undefined {
    return this.accounts.get(pda);
  }
}

/* -------------------------------------------------------------------------- */
/* Mock IPFS pinner — content-addressable so claim_uri → bytes is stable.      */
/* -------------------------------------------------------------------------- */

class MockIpfs implements IpfsPinner {
  public readonly store = new Map<string, unknown>();

  public async pinJson(value: unknown): Promise<string> {
    const cid = `Qm${sha256Hex(canonicalJson(value)).slice(0, 44)}`;
    this.store.set(cid, value);
    return `ipfs://${cid}`;
  }

  /** Mirrors a real verifier's `ipfs cat` step. */
  public fetch(uri: string): unknown {
    if (!uri.startsWith("ipfs://")) {
      throw new Error(`not an ipfs uri: ${uri}`);
    }
    const cid = uri.slice("ipfs://".length);
    if (!this.store.has(cid)) {
      throw new Error(`ipfs cid not found: ${cid}`);
    }
    return this.store.get(cid);
  }
}

/* -------------------------------------------------------------------------- */
/* Other fakes — minimal shims for the non-chain dependencies.                 */
/* -------------------------------------------------------------------------- */

function fakeIdTokenVerifier(): IdTokenVerifier {
  return {
    async verify() {
      return {
        sub: "world_user_e2e",
        iss: WORLDCOIN_ISSUER_URL,
        aud: APP_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Real Ed25519 wallet + verifier — exercises the actual signature path.       */
/* -------------------------------------------------------------------------- */

interface Wallet {
  /** AgentCard pubkey, base64-encoded raw 32 bytes. */
  readonly agentCardPubkey: AgentCardPubkey;
  /** Sign `nullifier_bytes || agent_card_pubkey_bytes`, returning base64. */
  sign(nullifierHash: Hex32): string;
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = normalizeHex(hex);
  if (stripped.length % 2 !== 0) {
    throw new Error(`odd-length hex: ${hex}`);
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bindingMessage(
  pubkey: AgentCardPubkey,
  nullifierHash: Hex32,
): Buffer {
  const nullifierBytes = hexToBytes(nullifierHash);
  const pubkeyBytes = Buffer.from(pubkey, "base64");
  const out = Buffer.alloc(nullifierBytes.length + pubkeyBytes.length);
  out.set(nullifierBytes, 0);
  out.set(pubkeyBytes, nullifierBytes.length);
  return out;
}

function newWallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Raw 32-byte pubkey, b64 encoded — tests treat AgentCardPubkey as opaque,
  // matches the spec's "base58/base64-encoded Ed25519 public key" contract.
  const rawPub = publicKey.export({ format: "der", type: "spki" }).slice(-32);
  const agentCardPubkey = Buffer.from(rawPub).toString("base64");
  return {
    agentCardPubkey,
    sign(nullifierHash) {
      const msg = bindingMessage(agentCardPubkey, nullifierHash);
      return nodeSign(null, msg, privateKey).toString("base64");
    },
  };
}

/** Real Ed25519 verifier matching the wallet's signing scheme. */
function realAgentCardSig(): AgentCardSignatureVerifier {
  return {
    async verify({ agentCardPubkey, nullifierHash, signature }) {
      try {
        const rawPub = Buffer.from(agentCardPubkey, "base64");
        if (rawPub.length !== 32) return false;
        // Reconstruct an SPKI DER for Ed25519 from the raw 32-byte pubkey.
        const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
        const spki = Buffer.concat([spkiPrefix, rawPub]);
        const pubKey = createPublicKey({
          key: spki,
          format: "der",
          type: "spki",
        });
        const msg = bindingMessage(agentCardPubkey, nullifierHash);
        const sig = Buffer.from(signature, "base64");
        return nodeVerify(null, msg, pubKey, sig);
      } catch {
        return false;
      }
    },
  };
}


/**
 * Fake Worldcoin Cloud verifier. Echoes the wallet-supplied
 * `nullifier_hash` / `action` back so the issuer's defensive checks
 * pass — exactly what the real `/api/v2/verify/{appId}` endpoint does
 * on a successful proof.
 */
interface CountingCloudVerifier extends CloudVerifier {
  readonly callCount: { value: number };
}

function fakeCloudVerifier(): CountingCloudVerifier {
  const callCount = { value: 0 };
  return {
    callCount,
    async verifyProof(input) {
      callCount.value += 1;
      return {
        success: true,
        verificationLevel: "orb",
        nullifierHash: input.nullifierHash,
        action: input.action,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

describe("Worldcoin issuer — end-to-end (FN-044 / T-1.4.3.2)", () => {
  it("mock proof → cred issued → cred validatable on chain", async () => {
    /* -- arrange: build the integrated stack --------------------------- */
    const ledger = new MockChainLedger(ISSUER_AUTHORITY);
    const ipfs = new MockIpfs();
    const nullifierStore = new InMemoryNullifierStore();
    const fixedNow = Date.UTC(2026, 3, 29, 12, 0, 0); // 2026-04-29T12:00:00Z
    const wallet = newWallet();

    const cfg: WorldcoinIssuerConfig = {
      appId: APP_ID,
      issuerDid: ISSUER_DID,
    };
    const deps: WorldcoinIssuerDeps = {
      idTokenVerifier: fakeIdTokenVerifier(),
      cloudVerifier: fakeCloudVerifier(),
      agentCardSignatureVerifier: realAgentCardSig(),
      nullifierStore,
      chain: ledger,
      ipfs,
      now: () => fixedNow,
    };
    const issuer = new WorldcoinIssuer(cfg, deps);

    /* -- act: submit a mock Worldcoin proof for the wallet ------------- */
    const response = await issuer.issue({
      idToken: "header.payload.signature",
      proof: "base64_zk_proof",
      merkleRoot: MERKLE_ROOT,
      nullifierHash: NULLIFIER,
      verificationLevel: "orb",
      agentCardPubkey: wallet.agentCardPubkey,
      agentCardSignature: wallet.sign(NULLIFIER),
    });

    /* -- assert: issuer reported a fresh on-chain issuance -------------- */
    expect(response.idempotent).toBe(false);
    expect(response.txSignature).toMatch(/^tx_\d{4}$/);
    expect(response.claimUri.startsWith("ipfs://")).toBe(true);
    expect(response.claimHash).toHaveLength(64);
    expect(ledger.txCount).toBe(1);

    /* -- assert: the credential is now validatable on chain ------------- *
     * A fresh "verifier" pulls the Credential account out of the
     * ledger using only public inputs (issuer authority + schema +
     * subject) and walks every binding back to the original Worldcoin
     * proof through the off-chain VC envelope. This is the contract
     * the gateway publishes to downstream consumers (E5 verifier).
     */
    const expectedPda = MockChainLedger.derivePda({
      issuerAuthority: ISSUER_AUTHORITY,
      schema: VERIFIED_HUMAN_SCHEMA_ID,
      subjectAgentCard: wallet.agentCardPubkey,
    });
    expect(response.credentialPda).toBe(expectedPda);

    const onChain = ledger.getAccount(response.credentialPda);
    expect(onChain, "credential PDA must be readable on chain").toBeDefined();
    if (onChain === undefined) return; // type narrow

    // (1) schema id matches the canonical verified-human tag
    expect(onChain.schema).toBe(VERIFIED_HUMAN_SCHEMA_ID);
    expect(onChain.schema).toBe(sha256Hex(VERIFIED_HUMAN_SCHEMA_TAG));

    // (2) subject is the caller's AgentCard
    expect(onChain.subjectAgentCard).toBe(wallet.agentCardPubkey);

    // (3) claim_hash equals sha256(JCS(off-chain VC payload))
    const vc = ipfs.fetch(onChain.claimUri) as Record<string, unknown>;
    expect(sha256Hex(canonicalJson(vc))).toBe(onChain.claimHash);
    expect(onChain.claimHash).toBe(response.claimHash);

    // (4) the off-chain VC binds the original Worldcoin nullifier +
    //     action — the chain of custody from proof → cred is intact.
    expect(vc["issuer"]).toBe(ISSUER_DID);
    expect(vc["type"]).toEqual([
      "VerifiableCredential",
      "VerifiedHumanCredential",
    ]);
    const subj = vc["credentialSubject"] as Record<string, unknown>;
    expect(subj["id"]).toBe(`did:eto:agentcard:${wallet.agentCardPubkey}`);
    expect(subj["verificationLevel"]).toBe("orb");
    expect(subj["worldIdAction"]).toBe(VERIFIED_HUMAN_ACTION);
    expect(subj["worldIdNullifierHash"]).toBe(normalizeHex(NULLIFIER));
    expect(subj["worldIdMerkleRoot"]).toBe(normalizeHex(MERKLE_ROOT));

    // (5) verified-human credentials have no expiry per spec §3
    expect(onChain.validUntilSlot).toBe(0n);
    expect(onChain.issuerAuthority).toBe(ISSUER_AUTHORITY);
    expect(onChain.slot).toBeGreaterThan(0n);

    // The recomputed VC envelope (rebuilt from public inputs +
    // §10.3.1 claimCommitments carried alongside the VC) hashes to
    // the on-chain claim_hash — closes the chain-of-custody loop a
    // downstream verifier walks: chain → IPFS → hash equality.
    // claimCommitments are non-deterministic (CSPRNG-salted) so a
    // pure rebuild can't regenerate them; we copy them through from
    // the fetched VC, which is exactly what a verifier does.
    const rebuilt = {
      ...buildVerifiedHumanVc({
        issuerDid: ISSUER_DID,
        agentCardPubkey: wallet.agentCardPubkey,
        verificationLevel: "orb",
        nullifierHash: NULLIFIER,
        merkleRoot: MERKLE_ROOT,
        issuanceDate: vc["issuanceDate"] as string,
      }),
      claimCommitments: vc["claimCommitments"],
    };
    expect(sha256Hex(canonicalJson(rebuilt))).toBe(onChain.claimHash);
  });

  it("re-issuing the same proof is idempotent and does not double-write the chain", async () => {
    const wallet = newWallet();
    /* A second `issue()` for the same (nullifier, card) must hit the
     * dedupe path — the on-chain Credential is unique, so a second
     * `IssueCredential` tx would fail at the runtime account-init
     * step. Verifying this here closes the loop on AC #3 of T-1.4.1.2
     * within the e2e harness so the chain validation we just exercised
     * remains stable across wallet retries. */
    const ledger = new MockChainLedger(ISSUER_AUTHORITY);
    const ipfs = new MockIpfs();
    const cloud = fakeCloudVerifier();
    const issuer = new WorldcoinIssuer(
      { appId: APP_ID, issuerDid: ISSUER_DID },
      {
        idTokenVerifier: fakeIdTokenVerifier(),
        cloudVerifier: cloud,
        agentCardSignatureVerifier: realAgentCardSig(),
        nullifierStore: new InMemoryNullifierStore(),
        chain: ledger,
        ipfs,
      },
    );
    const req = {
      idToken: "header.payload.signature",
      proof: "base64_zk_proof",
      merkleRoot: MERKLE_ROOT,
      nullifierHash: NULLIFIER,
      verificationLevel: "orb" as const,
      agentCardPubkey: wallet.agentCardPubkey,
      agentCardSignature: wallet.sign(NULLIFIER),
    };

    const first = await issuer.issue(req);
    const second = await issuer.issue(req);

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.credentialPda).toBe(first.credentialPda);
    expect(second.claimHash).toBe(first.claimHash);
    expect(ledger.txCount).toBe(1);
    expect(ledger.accounts.size).toBe(1);

    // The ledger record is still readable and still consistent with
    // the issuer's response — a verifier polling after either call
    // sees the same on-chain credential.
    const onChain = ledger.getAccount(first.credentialPda);
    expect(onChain?.claimHash).toBe(second.claimHash);
    expect(onChain?.claimUri).toBe(second.claimUri);
    // Cloud verifier is short-circuited on the idempotent re-hit per
    // the post-signature dedupe pre-check in worldcoin.ts step 3.
    expect(cloud.callCount.value).toBe(1);
  });

  it("re-submitting the same nullifier with a different AgentCard is rejected (409)", async () => {
    const ledger = new MockChainLedger(ISSUER_AUTHORITY);
    const ipfs = new MockIpfs();
    const cloud = fakeCloudVerifier();
    const issuer = new WorldcoinIssuer(
      { appId: APP_ID, issuerDid: ISSUER_DID },
      {
        idTokenVerifier: fakeIdTokenVerifier(),
        cloudVerifier: cloud,
        agentCardSignatureVerifier: realAgentCardSig(),
        nullifierStore: new InMemoryNullifierStore(),
        chain: ledger,
        ipfs,
      },
    );
    const walletA = newWallet();
    const walletB = newWallet();

    await issuer.issue({
      idToken: "header.payload.signature",
      proof: "base64_zk_proof",
      merkleRoot: MERKLE_ROOT,
      nullifierHash: NULLIFIER,
      verificationLevel: "orb",
      agentCardPubkey: walletA.agentCardPubkey,
      agentCardSignature: walletA.sign(NULLIFIER),
    });

    /* Wallet B reuses the same Worldcoin nullifier under a different
     * AgentCard — a single human attempting to mint verified-human for
     * a second card. Spec §6 mandates a 409 with the binding
     * untouched. */
    const reqB = {
      idToken: "header.payload.signature",
      proof: "base64_zk_proof",
      merkleRoot: MERKLE_ROOT,
      nullifierHash: NULLIFIER,
      verificationLevel: "orb" as const,
      agentCardPubkey: walletB.agentCardPubkey,
      agentCardSignature: walletB.sign(NULLIFIER),
    };
    let caught: unknown;
    try {
      await issuer.issue(reqB);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorldcoinIssuerError);
    const wErr = caught as WorldcoinIssuerError;
    expect(wErr.code).toBe("NULLIFIER_BOUND_TO_OTHER_CARD");
    expect(wErr.status).toBe(409);

    // Ledger / dedupe store are unchanged — no second tx, no overwrite.
    expect(ledger.txCount).toBe(1);
    expect(ledger.accounts.size).toBe(1);
    const onlyPda = MockChainLedger.derivePda({
      issuerAuthority: ISSUER_AUTHORITY,
      schema: VERIFIED_HUMAN_SCHEMA_ID,
      subjectAgentCard: walletA.agentCardPubkey,
    });
    expect(ledger.getAccount(onlyPda)).toBeDefined();
  });

  it("forged wallet-binding signature is rejected before the cloud verifier runs", async () => {
    const ledger = new MockChainLedger(ISSUER_AUTHORITY);
    const ipfs = new MockIpfs();
    const cloud = fakeCloudVerifier();
    const issuer = new WorldcoinIssuer(
      { appId: APP_ID, issuerDid: ISSUER_DID },
      {
        idTokenVerifier: fakeIdTokenVerifier(),
        cloudVerifier: cloud,
        agentCardSignatureVerifier: realAgentCardSig(),
        nullifierStore: new InMemoryNullifierStore(),
        chain: ledger,
        ipfs,
      },
    );
    const victim = newWallet();
    const attacker = newWallet();

    // Attacker signs with their own key but submits the victim's pubkey
    // — the canonical wallet-binding-forgery attempt the spec §8 calls out.
    const forgedSig = attacker.sign(NULLIFIER);

    let caught: unknown;
    try {
      await issuer.issue({
        idToken: "header.payload.signature",
        proof: "base64_zk_proof",
        merkleRoot: MERKLE_ROOT,
        nullifierHash: NULLIFIER,
        verificationLevel: "orb",
        agentCardPubkey: victim.agentCardPubkey,
        agentCardSignature: forgedSig,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorldcoinIssuerError);
    const wErr = caught as WorldcoinIssuerError;
    expect(wErr.code).toBe("INVALID_AGENT_CARD_SIGNATURE");
    expect(wErr.status).toBe(401);

    // Critically: the cloud verifier was *never* called. A forged caller
    // must not be able to probe Worldcoin's /verify endpoint via the
    // bridge or burn rate-limit budget.
    expect(cloud.callCount.value).toBe(0);
    expect(ledger.txCount).toBe(0);
  });
});
