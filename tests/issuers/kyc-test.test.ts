/**
 * FN-018 — kyc.us-test issuer boundary suite.
 *
 * Mirrors the structure of `tests/issuers/worldcoin.test.ts`. Locks the
 * four mandatory boundary cases against the real `KycTestIssueError`
 * contract (every failure throws a typed error; no bare `Error`).
 *
 * NB on PII: this is the **mock** kyc.us-test issuer. It deliberately
 * embeds `legalName` and `dateOfBirth` in `credentialSubject` because
 * the credential is labeled `kyc.us-test` and exists for demo wiring
 * only. The boundary invariant we lock here is therefore "the schema
 * id, the bridge nullifier, and the kycLevel='mock-test' marker are
 * all present so a relying party cannot mistake this for real KYC".
 * See FN-018 follow-up FN-072 for the upgrade path.
 */

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  HmacKycTestFormTokenSigner,
  KYC_TEST_MIN_DWELL_SECONDS,
  KYC_TEST_SCHEMA_ID_HEX,
  KycTestIssueError,
  buildKycTestVc,
  deriveNullifier,
  ed25519KycTestSignatureVerifier,
  issueKycTest,
  jcsCanonicalize,
  normalizeName,
} from "../../src/issuers/kyc-test.js";
import type {
  KycTestAgentCardSignatureVerifier,
  KycTestDedupeRow,
  KycTestDedupeStore,
  KycTestFormSubmission,
  KycTestIssueCredentialClient,
  KycTestIssuerDeps,
  KycTestSlotClock,
  KycTestVcPinner,
} from "../../src/issuers/kyc-test.types.js";

// FN-057 — wallet-binding signature is required. Most existing
// boundary tests don't depend on signature semantics, so they use
// an always-true stub. The dedicated FN-057 test below uses the
// real Ed25519 verifier with a real keypair.
const stubSigVerifier: KycTestAgentCardSignatureVerifier = {
  async verify() {
    return true;
  },
};
const STUB_SIGNATURE = Buffer.alloc(64).toString("base64");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const CARD_A = "AgentCardAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CARD_B = "AgentCardBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ISSUER = "IssuerAuthorityyyyyyyyyyyyyyyyyyyyyyyyyy";
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

class MemoryDedupe implements KycTestDedupeStore {
  public readonly rows = new Map<string, KycTestDedupeRow>();
  async get(nullifier: string): Promise<KycTestDedupeRow | undefined> {
    return this.rows.get(nullifier);
  }
  async putIfAbsent(row: KycTestDedupeRow): Promise<KycTestDedupeRow> {
    const existing = this.rows.get(row.nullifier);
    if (existing) return existing;
    this.rows.set(row.nullifier, row);
    return row;
  }
}

interface ChainCall {
  subjectAgentCardPubkey: string;
  schemaIdHex: string;
  claimUri: string;
  claimHashHex: string;
  validFromSlot: bigint;
  validUntilSlot: bigint;
}

class StubChain implements KycTestIssueCredentialClient {
  public readonly calls: ChainCall[] = [];

  async issueCredential(
    input: ChainCall,
  ): Promise<{ credentialPda: string; txSignature: string }> {
    this.calls.push(input);
    const idx = this.calls.length;
    return {
      credentialPda: `pda_${idx}_${input.subjectAgentCardPubkey.slice(0, 8)}`,
      txSignature: `sig_${idx}`,
    };
  }
}

class StubPinner implements KycTestVcPinner {
  public readonly pinned: string[] = [];
  async pin(json: string): Promise<{ uri: string }> {
    this.pinned.push(json);
    return { uri: `ipfs://stub/${this.pinned.length}` };
  }
  /** Decode-by-uri helper for assertions. */
  fetch(uri: string): Record<string, unknown> {
    const idx = Number(uri.replace("ipfs://stub/", ""));
    const json = this.pinned[idx - 1];
    if (json === undefined) throw new Error(`unknown uri: ${uri}`);
    return JSON.parse(json) as Record<string, unknown>;
  }
}

class FixedClock implements KycTestSlotClock {
  public constructor(private readonly slot: bigint) {}
  async currentSlot(): Promise<bigint> {
    return this.slot;
  }
}

interface BuiltStack {
  readonly deps: KycTestIssuerDeps;
  readonly chain: StubChain;
  readonly pinner: StubPinner;
  readonly dedupe: MemoryDedupe;
  readonly signer: HmacKycTestFormTokenSigner;
  readonly nowRef: { value: number };
}

function kycDeps(opts?: { initialNow?: number }): BuiltStack {
  const signer = new HmacKycTestFormTokenSigner(SECRET);
  const dedupe = new MemoryDedupe();
  const chain = new StubChain();
  const pinner = new StubPinner();
  const nowRef = { value: opts?.initialNow ?? 1_700_000_000 };
  const deps: KycTestIssuerDeps = {
    tokenSigner: signer,
    dedupe,
    chain,
    pinner,
    clock: new FixedClock(123_456n),
    signatureVerifier: stubSigVerifier,
    issuerAuthorityPubkey: ISSUER,
    nowUnix: () => nowRef.value,
  };
  return { deps, chain, pinner, dedupe, signer, nowRef };
}

function makeSubmission(opts: {
  readonly signer: HmacKycTestFormTokenSigner;
  readonly fullName?: string;
  readonly dobIso?: string;
  readonly flowStartedAtUnix: number;
  readonly agentCardPubkey?: string;
  readonly tagOverride?: string;
}): KycTestFormSubmission {
  const fullName = opts.fullName ?? "Test User";
  const dobIso = opts.dobIso ?? "1990-01-01";
  const agentCardPubkey = opts.agentCardPubkey ?? CARD_A;
  const tag =
    opts.tagOverride ??
    opts.signer.sign({
      fullName,
      dobIso,
      flowStartedAtUnix: opts.flowStartedAtUnix,
      agentCardPubkey,
    });
  return {
    fullName,
    dobIso,
    flowStartedAtUnix: opts.flowStartedAtUnix,
    formTokenHmacHex: tag,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("kyc.us-test issuer — boundary suite (FN-018)", () => {
  it("happy issuance: status=issued, schema and PDA bind to the caller", async () => {
    const { deps, chain, pinner, nowRef } = kycDeps({
      initialNow: 1_700_000_100,
    });
    const submission = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
    });
    const out = await issueKycTest(deps, {
      submission,
      agentCardPubkey: CARD_A,
      agentCardSignature: STUB_SIGNATURE,
    });

    expect(out.status).toBe("issued");
    if (out.status !== "issued") return; // type narrow
    expect(out.claimHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.schemaIdHex).toBe(KYC_TEST_SCHEMA_ID_HEX);
    // Lock subject provenance: caller-supplied, not store-derived.
    expect(chain.calls[0]?.subjectAgentCardPubkey).toBe(CARD_A);
    expect(chain.calls[0]?.validUntilSlot).toBe(0n);
    expect(out.nullifier).toBe(deriveNullifier(normalizeName("Test User"), "1990-01-01"));

    // claimHashHex equals sha256(JCS(VC envelope))
    const vc = pinner.fetch(out.claimUri);
    expect(out.claimHashHex).toBe(
      createHash("sha256").update(jcsCanonicalize(vc)).digest("hex"),
    );

    // issuanceDate is set
    expect(typeof vc["issuanceDate"]).toBe("string");
  });

  it("replay (same identity, same card): status=idempotent — no second chain tx", async () => {
    const { deps, chain, nowRef } = kycDeps({ initialNow: 1_700_000_100 });
    const sub = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
    });
    const r1 = await issueKycTest(deps, {
      submission: sub,
      agentCardPubkey: CARD_A,
      agentCardSignature: STUB_SIGNATURE,
    });
    const r2 = await issueKycTest(deps, {
      submission: sub,
      agentCardPubkey: CARD_A,
      agentCardSignature: STUB_SIGNATURE,
    });
    expect(r1.status).toBe("issued");
    expect(r2.status).toBe("idempotent");
    expect(r2.credentialPda).toBe(r1.credentialPda);
    expect(chain.calls).toHaveLength(1);
  });

  it("replay (same identity, DIFFERENT card): throws KycTestIssueError(replay_conflict)", async () => {
    const { deps, chain, nowRef } = kycDeps({ initialNow: 1_700_000_100 });
    const flowStartedAtUnix = nowRef.value - KYC_TEST_MIN_DWELL_SECONDS;
    const subA = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      flowStartedAtUnix,
      agentCardPubkey: CARD_A,
    });
    const subB = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      flowStartedAtUnix,
      agentCardPubkey: CARD_B,
    });
    await issueKycTest(deps, { submission: subA, agentCardPubkey: CARD_A, agentCardSignature: STUB_SIGNATURE });

    let caught: unknown;
    try {
      await issueKycTest(deps, {
        submission: subB,
        agentCardPubkey: CARD_B,
        agentCardSignature: STUB_SIGNATURE,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KycTestIssueError);
    expect((caught as KycTestIssueError).kind).toBe("replay_conflict");
    expect(chain.calls).toHaveLength(1);
  });

  it("tampered form-token HMAC: throws KycTestIssueError(invalid_token); chain not called", async () => {
    const { deps, chain, nowRef } = kycDeps({ initialNow: 1_700_000_100 });
    const sub = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
    });
    // Flip one hex char; HMAC verify must fail with a typed error.
    const tampered = {
      ...sub,
      formTokenHmacHex:
        sub.formTokenHmacHex[0] === "0"
          ? `1${sub.formTokenHmacHex.slice(1)}`
          : `0${sub.formTokenHmacHex.slice(1)}`,
    };
    let caught: unknown;
    try {
      await issueKycTest(deps, {
        submission: tampered,
        agentCardPubkey: CARD_A,
        agentCardSignature: STUB_SIGNATURE,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KycTestIssueError);
    expect((caught as KycTestIssueError).kind).toBe("invalid_token");
    expect(chain.calls).toHaveLength(0);
  });

  it("expiry (dwell-too-short): throws KycTestIssueError(dwell_too_short); chain not called", async () => {
    const { deps, chain, nowRef } = kycDeps({ initialNow: 1_700_000_100 });
    // Submit BEFORE the minimum dwell elapses.
    const sub = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      flowStartedAtUnix: nowRef.value - 1,
    });
    let caught: unknown;
    try {
      await issueKycTest(deps, {
        submission: sub,
        agentCardPubkey: CARD_A,
        agentCardSignature: STUB_SIGNATURE,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KycTestIssueError);
    expect((caught as KycTestIssueError).kind).toBe("dwell_too_short");
    expect(chain.calls).toHaveLength(0);
  });

  it("VC envelope shape: locks the kyc.us-test fields (mock-issuer self-disclosure)", async () => {
    // The kyc.us-test mock embeds `legalName` and `dateOfBirth` *by
    // design* (it has only name+DOB to work with) and labels itself
    // `kycLevel: "mock-test"` so a relying party cannot mistake it
    // for real KYC. We pin the exact field set so any future change
    // either flows through this test (and the spec) or tightens the
    // contract on purpose. See FN-018 follow-up FN-072 for the
    // hash-the-PII upgrade path.
    const vc = buildKycTestVc({
      agentCardPubkey: CARD_A,
      issuerAuthorityPubkey: ISSUER,
      fullName: normalizeName("Test User"),
      dobIso: "1990-01-01",
      nullifier: "00".repeat(32),
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    const subj = vc["credentialSubject"] as Record<string, unknown>;
    expect(Object.keys(subj).sort()).toEqual([
      "bridgeNullifier",
      "dateOfBirth",
      "id",
      "kycJurisdiction",
      "kycLevel",
      "legalName",
    ]);
    // The "this is a mock" self-disclosure that downstream relying
    // parties pin on:
    expect(subj["kycLevel"]).toBe("mock-test");
    expect(subj["kycJurisdiction"]).toBe("us-test");
    // `id` is derived from caller-supplied AgentCardPubkey, not the
    // dedupe store — defends against a regression in subject derivation.
    expect(subj["id"]).toBe(`did:eto:agentcard:${CARD_A}`);
  });

  it("emits unique credentials across two independent issuances", async () => {
    const { deps, chain, pinner, nowRef } = kycDeps({
      initialNow: 1_700_000_100,
    });
    const sub1 = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      fullName: "Alice Test",
      dobIso: "1990-01-01",
      flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
    });
    const r1 = await issueKycTest(deps, {
      submission: sub1,
      agentCardPubkey: CARD_A,
      agentCardSignature: STUB_SIGNATURE,
    });
    nowRef.value += 60;
    const sub2 = makeSubmission({
      signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
      fullName: "Bob Test",
      dobIso: "1991-02-02",
      flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
      agentCardPubkey: CARD_B,
    });
    const r2 = await issueKycTest(deps, {
      submission: sub2,
      agentCardPubkey: CARD_B,
      agentCardSignature: STUB_SIGNATURE,
    });
    expect(r1.credentialPda).not.toBe(r2.credentialPda);
    expect(chain.calls).toHaveLength(2);
    const vc1 = pinner.fetch(r1.claimUri);
    const vc2 = pinner.fetch(r2.claimUri);
    expect(vc1["issuanceDate"]).not.toBe(vc2["issuanceDate"]);
    // Per-VC unique identifier: `bridgeNullifier`.
    const sub1Subj = vc1["credentialSubject"] as Record<string, unknown>;
    const sub2Subj = vc2["credentialSubject"] as Record<string, unknown>;
    expect(sub1Subj["bridgeNullifier"]).not.toBe(sub2Subj["bridgeNullifier"]);
  });

  /* ------------------------------------------------------------------ */
  /* FN-057 — wallet-binding signature                                   */
  /* ------------------------------------------------------------------ */

  describe("FN-057: wallet-binding signature is required", () => {
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

    interface Wallet {
      readonly pubkey: string;
      readonly rawPub: Uint8Array;
      readonly privateKey: ReturnType<typeof createPrivateKey>;
    }
    function newWallet(): Wallet {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const spki = publicKey.export({ format: "der", type: "spki" });
      const raw = new Uint8Array(spki.subarray(spki.length - 32));
      return { pubkey: base58Encode(raw), rawPub: raw, privateKey };
    }
    function signBinding(wallet: Wallet, nullifierHex: string): string {
      const nullifierBytes = Buffer.from(nullifierHex, "hex");
      const message = createHash("sha256")
        .update(nullifierBytes)
        .update(wallet.rawPub)
        .digest();
      return Buffer.from(
        nodeSign(null, message, wallet.privateKey),
      ).toString("base64");
    }

    function realDeps(opts?: { initialNow?: number }): BuiltStack {
      const stack = kycDeps(opts);
      // Swap the stub for the real Ed25519 verifier.
      const realDepsObj: KycTestIssuerDeps = {
        ...stack.deps,
        signatureVerifier: ed25519KycTestSignatureVerifier,
      };
      return { ...stack, deps: realDepsObj };
    }

    it("rejects a request that supplies a victim's pubkey with the attacker's signature (HTTP 401)", async () => {
      const stack = realDeps({ initialNow: 1_700_000_100 });
      const { deps, chain, dedupe, nowRef } = stack;
      const victim = newWallet();
      const attacker = newWallet();

      const submission = makeSubmission({
        signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
        fullName: "Mallory Attacker",
        dobIso: "1990-01-01",
        flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
        // FN-057: HMAC is bound to the AgentCard the request claims;
        // an attacker who legitimately rendered a form for victim.pubkey
        // could capture it, but the wallet-binding signature still gates.
        agentCardPubkey: victim.pubkey,
      });
      const nullifier = deriveNullifier(
        normalizeName(submission.fullName),
        submission.dobIso,
      );
      // Attacker can only sign for their OWN pubkey, but the request
      // claims `agentCardPubkey = victim.pubkey`. The signature
      // therefore validates as Ed25519 bytes but does NOT validate
      // against `victim.pubkey` over `sha256(nullifier || victim.pubkey)`.
      const attackerSig = signBinding(attacker, nullifier);

      let caught: unknown;
      try {
        await issueKycTest(deps, {
          submission,
          agentCardPubkey: victim.pubkey,
          agentCardSignature: attackerSig,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(KycTestIssueError);
      expect((caught as KycTestIssueError).kind).toBe(
        "invalid_agent_card_signature",
      );
      // No chain submission, no dedupe row — the attacker cannot
      // poison the victim's `(nullifier, card)` slot.
      expect(chain.calls).toHaveLength(0);
      expect(dedupe.rows.size).toBe(0);
    });

    it("accepts a request signed by the holder of agentCardPubkey", async () => {
      const stack = realDeps({ initialNow: 1_700_000_100 });
      const { deps, chain, nowRef } = stack;
      const wallet = newWallet();

      const submission = makeSubmission({
        signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
        fullName: "Alice Honest",
        dobIso: "1990-01-01",
        flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
        agentCardPubkey: wallet.pubkey,
      });
      const nullifier = deriveNullifier(
        normalizeName(submission.fullName),
        submission.dobIso,
      );
      const sig = signBinding(wallet, nullifier);

      const out = await issueKycTest(deps, {
        submission,
        agentCardPubkey: wallet.pubkey,
        agentCardSignature: sig,
      });
      expect(out.status).toBe("issued");
      expect(chain.calls).toHaveLength(1);
      expect(chain.calls[0]?.subjectAgentCardPubkey).toBe(wallet.pubkey);
    });

    it("rejects a request with an empty signature", async () => {
      const stack = realDeps({ initialNow: 1_700_000_100 });
      const { deps, chain, nowRef } = stack;
      const wallet = newWallet();

      const submission = makeSubmission({
        signer: deps.tokenSigner as HmacKycTestFormTokenSigner,
        flowStartedAtUnix: nowRef.value - KYC_TEST_MIN_DWELL_SECONDS,
        agentCardPubkey: wallet.pubkey,
      });
      let caught: unknown;
      try {
        await issueKycTest(deps, {
          submission,
          agentCardPubkey: wallet.pubkey,
          agentCardSignature: "",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(KycTestIssueError);
      expect((caught as KycTestIssueError).kind).toBe(
        "invalid_agent_card_signature",
      );
      expect(chain.calls).toHaveLength(0);
    });
  });
});
