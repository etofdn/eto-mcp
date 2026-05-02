import { describe, expect, it } from "vitest";

import {
  HmacKycTestFormTokenSigner,
  KYC_TEST_MIN_DWELL_SECONDS,
  KYC_TEST_SCHEMA_ID_HEX,
  KycTestDedupeRow,
  KycTestDedupeStore,
  KycTestFormSubmission,
  KycTestFormTokenSigner,
  KycTestIssueCredentialClient,
  KycTestIssueError,
  KycTestIssuerDeps,
  KycTestSlotClock,
  KycTestVcPinner,
  buildKycTestVc,
  deriveNullifier,
  issueKycTest,
  jcsCanonicalize,
  normalizeName,
  renderKycTestFormHtml,
} from "../src/issuers/kyc-test.js";

const CARD_A = "AgentCardAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CARD_B = "AgentCardBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ISSUER = "IssuerAuthorityyyyyyyyyyyyyyyyyyyyyyyyyy";
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

class MemoryDedupe implements KycTestDedupeStore {
  public rows = new Map<string, KycTestDedupeRow>();

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
  public calls: ChainCall[] = [];
  public failNext = false;

  async issueCredential(input: ChainCall): Promise<{
    credentialPda: string;
    txSignature: string;
  }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated rpc failure");
    }
    this.calls.push(input);
    const idx = this.calls.length;
    return {
      credentialPda: `pda_${idx}_${input.subjectAgentCardPubkey.slice(0, 8)}`,
      txSignature: `sig_${idx}`,
    };
  }
}

class StubPinner implements KycTestVcPinner {
  public pinned: string[] = [];
  async pin(json: string): Promise<{ uri: string }> {
    this.pinned.push(json);
    return { uri: `ipfs://stub/${this.pinned.length}` };
  }
}

class FixedClock implements KycTestSlotClock {
  public constructor(private readonly slot: bigint) {}
  async currentSlot(): Promise<bigint> {
    return this.slot;
  }
}

function makeSigner(): KycTestFormTokenSigner {
  return new HmacKycTestFormTokenSigner(SECRET);
}

function makeSubmission(opts: {
  signer: KycTestFormTokenSigner;
  fullName?: string;
  dobIso?: string;
  flowStartedAtUnix: number;
  tagOverride?: string;
}): KycTestFormSubmission {
  const fullName = opts.fullName ?? "Ada Lovelace";
  const dobIso = opts.dobIso ?? "1990-01-31";
  const flowStartedAtUnix = opts.flowStartedAtUnix;
  const tag =
    opts.tagOverride ??
    opts.signer.sign({ fullName, dobIso, flowStartedAtUnix });
  return {
    fullName,
    dobIso,
    flowStartedAtUnix,
    formTokenHmacHex: tag,
  };
}

interface DepsOverrides {
  tokenSigner?: KycTestFormTokenSigner;
  dedupe?: KycTestDedupeStore;
  chain?: KycTestIssueCredentialClient;
  pinner?: KycTestVcPinner;
  clock?: KycTestSlotClock;
  issuerAuthorityPubkey?: string;
  minDwellSeconds?: number;
  nowUnix: number;
}

function depsWith(overrides: DepsOverrides): KycTestIssuerDeps {
  return {
    tokenSigner: overrides.tokenSigner ?? makeSigner(),
    dedupe: overrides.dedupe ?? new MemoryDedupe(),
    chain: overrides.chain ?? new StubChain(),
    pinner: overrides.pinner ?? new StubPinner(),
    clock: overrides.clock ?? new FixedClock(123n),
    issuerAuthorityPubkey: overrides.issuerAuthorityPubkey ?? ISSUER,
    nowUnix: () => overrides.nowUnix,
    ...(overrides.minDwellSeconds !== undefined
      ? { minDwellSeconds: overrides.minDwellSeconds }
      : {}),
  };
}

describe("kyc.us-test schema and helpers", () => {
  it("schema id is sha256('eto.beckn.schema.kyc.us-test.v1')", () => {
    expect(KYC_TEST_SCHEMA_ID_HEX).toMatch(/^[0-9a-f]{64}$/);
    // Differs from verified-human schema by construction (different label).
    const verifiedHumanLikely = require("node:crypto")
      .createHash("sha256")
      .update("eto.beckn.schema.verified-human.v1", "utf8")
      .digest("hex");
    expect(KYC_TEST_SCHEMA_ID_HEX).not.toBe(verifiedHumanLikely);
  });

  it("normalizeName collapses whitespace and lowercases", () => {
    expect(normalizeName("  Ada   Lovelace ")).toBe("ada lovelace");
    expect(normalizeName("ADA\tLovelace")).toBe("ada lovelace");
  });

  it("derives a stable nullifier insensitive to whitespace/case", () => {
    const a = deriveNullifier(normalizeName("Ada Lovelace"), "1990-01-31");
    const b = deriveNullifier(normalizeName("  ada  LOVELACE "), "1990-01-31");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("buildKycTestVc emits a JCS-stable, mock-labelled VC", () => {
    const vc = buildKycTestVc({
      agentCardPubkey: CARD_A,
      issuerAuthorityPubkey: ISSUER,
      fullName: "ada lovelace",
      dobIso: "1990-01-31",
      nullifier: "n",
      issuanceDate: "2030-01-01T00:00:00.000Z",
    });
    const sub = vc["credentialSubject"] as Record<string, unknown>;
    expect(sub["kycLevel"]).toBe("mock-test");
    expect(sub["kycJurisdiction"]).toBe("us-test");
    expect(vc["issuer"]).toBe("did:eto:kyc-us-test");
    expect(jcsCanonicalize(vc)).toBe(jcsCanonicalize(vc));
  });
});

describe("HmacKycTestFormTokenSigner", () => {
  it("round-trips sign/verify", () => {
    const s = makeSigner();
    const tag = s.sign({
      fullName: "Ada",
      dobIso: "1990-01-31",
      flowStartedAtUnix: 1000,
    });
    expect(
      s.verify({
        fullName: "Ada",
        dobIso: "1990-01-31",
        flowStartedAtUnix: 1000,
        tag,
      }),
    ).toBe(true);
  });

  it("rejects a tampered field", () => {
    const s = makeSigner();
    const tag = s.sign({
      fullName: "Ada",
      dobIso: "1990-01-31",
      flowStartedAtUnix: 1000,
    });
    expect(
      s.verify({
        fullName: "Eve",
        dobIso: "1990-01-31",
        flowStartedAtUnix: 1000,
        tag,
      }),
    ).toBe(false);
    expect(
      s.verify({
        fullName: "Ada",
        dobIso: "1990-01-31",
        flowStartedAtUnix: 999,
        tag,
      }),
    ).toBe(false);
  });

  it("rejects a malformed hex tag without throwing", () => {
    const s = makeSigner();
    expect(
      s.verify({
        fullName: "Ada",
        dobIso: "1990-01-31",
        flowStartedAtUnix: 1000,
        tag: "not-hex",
      }),
    ).toBe(false);
  });

  it("refuses to instantiate with a short secret", () => {
    expect(() => new HmacKycTestFormTokenSigner(Buffer.from("short"))).toThrow();
  });
});

describe("issueKycTest happy path", () => {
  it("issues a credential with the kyc.us-test schema after the dwell", async () => {
    const signer = makeSigner();
    const dedupe = new MemoryDedupe();
    const chain = new StubChain();
    const pinner = new StubPinner();
    const flowStartedAtUnix = 1_700_000_000;
    const nowUnix = flowStartedAtUnix + KYC_TEST_MIN_DWELL_SECONDS;

    const deps = depsWith({
      tokenSigner: signer,
      dedupe,
      chain,
      pinner,
      nowUnix,
    });
    const submission = makeSubmission({ signer, flowStartedAtUnix });

    const res = await issueKycTest(deps, {
      submission,
      agentCardPubkey: CARD_A,
    });

    expect(res.status).toBe("issued");
    if (res.status !== "issued") return;
    expect(res.claimHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(res.nullifier).toBe(
      deriveNullifier(normalizeName(submission.fullName), submission.dobIso),
    );

    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]!.schemaIdHex).toBe(KYC_TEST_SCHEMA_ID_HEX);
    expect(chain.calls[0]!.subjectAgentCardPubkey).toBe(CARD_A);
    expect(chain.calls[0]!.validFromSlot).toBe(123n);
    expect(chain.calls[0]!.validUntilSlot).toBe(0n);

    // dedupe row persisted post-tx
    expect(dedupe.rows.size).toBe(1);
    expect(pinner.pinned).toHaveLength(1);
  });

  it("idempotent re-issue from the same card returns the original PDA", async () => {
    const signer = makeSigner();
    const dedupe = new MemoryDedupe();
    const chain = new StubChain();
    const flowStartedAtUnix = 1_700_000_000;
    const nowUnix = flowStartedAtUnix + KYC_TEST_MIN_DWELL_SECONDS;

    const deps = depsWith({
      tokenSigner: signer,
      dedupe,
      chain,
      nowUnix,
    });
    const submission = makeSubmission({ signer, flowStartedAtUnix });

    const first = await issueKycTest(deps, {
      submission,
      agentCardPubkey: CARD_A,
    });
    const second = await issueKycTest(deps, {
      submission,
      agentCardPubkey: CARD_A,
    });

    expect(first.status).toBe("issued");
    expect(second.status).toBe("idempotent");
    if (first.status === "issued" && second.status === "idempotent") {
      expect(second.credentialPda).toBe(first.credentialPda);
    }
    // No second tx.
    expect(chain.calls).toHaveLength(1);
  });
});

describe("issueKycTest dwell enforcement", () => {
  const flowStartedAtUnix = 1_700_000_000;

  it("rejects submissions inside the 30s window", async () => {
    const signer = makeSigner();
    const deps = depsWith({
      tokenSigner: signer,
      nowUnix: flowStartedAtUnix + 5,
    });
    await expect(
      issueKycTest(deps, {
        submission: makeSubmission({ signer, flowStartedAtUnix }),
        agentCardPubkey: CARD_A,
      }),
    ).rejects.toMatchObject({
      kind: "dwell_too_short",
    });
  });

  it("rejects flowStartedAtUnix from the future", async () => {
    const signer = makeSigner();
    const deps = depsWith({
      tokenSigner: signer,
      nowUnix: flowStartedAtUnix - 60,
    });
    await expect(
      issueKycTest(deps, {
        submission: makeSubmission({ signer, flowStartedAtUnix }),
        agentCardPubkey: CARD_A,
      }),
    ).rejects.toBeInstanceOf(KycTestIssueError);
  });

  it("respects a custom minDwellSeconds override (for tests)", async () => {
    const signer = makeSigner();
    const deps = depsWith({
      tokenSigner: signer,
      nowUnix: flowStartedAtUnix + 1,
      minDwellSeconds: 1,
    });
    const res = await issueKycTest(deps, {
      submission: makeSubmission({ signer, flowStartedAtUnix }),
      agentCardPubkey: CARD_A,
    });
    expect(res.status).toBe("issued");
  });
});

describe("issueKycTest token + form validation", () => {
  const flowStartedAtUnix = 1_700_000_000;
  const nowUnix = flowStartedAtUnix + KYC_TEST_MIN_DWELL_SECONDS;

  it("rejects a forged HMAC tag", async () => {
    const signer = makeSigner();
    const deps = depsWith({ tokenSigner: signer, nowUnix });
    const submission = makeSubmission({
      signer,
      flowStartedAtUnix,
      tagOverride: "00".repeat(32),
    });
    await expect(
      issueKycTest(deps, { submission, agentCardPubkey: CARD_A }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("rejects a tampered name (signed name was different)", async () => {
    const signer = makeSigner();
    const deps = depsWith({ tokenSigner: signer, nowUnix });
    const tag = signer.sign({
      fullName: "Ada Lovelace",
      dobIso: "1990-01-31",
      flowStartedAtUnix,
    });
    await expect(
      issueKycTest(deps, {
        submission: {
          fullName: "Eve",
          dobIso: "1990-01-31",
          flowStartedAtUnix,
          formTokenHmacHex: tag,
        },
        agentCardPubkey: CARD_A,
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it.each([
    ["", "empty name"],
    ["   ", "whitespace name"],
    ["x".repeat(300), "over-long name"],
  ])("rejects malformed name (%s)", async (badName) => {
    const signer = makeSigner();
    const deps = depsWith({ tokenSigner: signer, nowUnix });
    const submission = makeSubmission({
      signer,
      fullName: badName,
      flowStartedAtUnix,
    });
    await expect(
      issueKycTest(deps, { submission, agentCardPubkey: CARD_A }),
    ).rejects.toMatchObject({ kind: "invalid_form" });
  });

  it.each([
    "1815/12/10",
    "1815-13-01",
    "1815-02-30",
    "not-a-date",
    "1815-12-1",
  ])("rejects malformed DOB (%s)", async (badDob) => {
    const signer = makeSigner();
    const deps = depsWith({ tokenSigner: signer, nowUnix });
    const submission = makeSubmission({
      signer,
      dobIso: badDob,
      flowStartedAtUnix,
    });
    await expect(
      issueKycTest(deps, { submission, agentCardPubkey: CARD_A }),
    ).rejects.toMatchObject({ kind: "invalid_form" });
  });

  it("rejects an empty agentCardPubkey", async () => {
    const signer = makeSigner();
    const deps = depsWith({ tokenSigner: signer, nowUnix });
    const submission = makeSubmission({ signer, flowStartedAtUnix });
    await expect(
      issueKycTest(deps, { submission, agentCardPubkey: "" }),
    ).rejects.toMatchObject({ kind: "invalid_form" });
  });
});

describe("issueKycTest dedupe semantics", () => {
  const flowStartedAtUnix = 1_700_000_000;
  const nowUnix = flowStartedAtUnix + KYC_TEST_MIN_DWELL_SECONDS;

  it("returns 409 (replay_conflict) on same identity, different card", async () => {
    const signer = makeSigner();
    const dedupe = new MemoryDedupe();
    const chain = new StubChain();
    const deps = depsWith({
      tokenSigner: signer,
      dedupe,
      chain,
      nowUnix,
    });

    await issueKycTest(deps, {
      submission: makeSubmission({ signer, flowStartedAtUnix }),
      agentCardPubkey: CARD_A,
    });

    await expect(
      issueKycTest(deps, {
        submission: makeSubmission({ signer, flowStartedAtUnix }),
        agentCardPubkey: CARD_B,
      }),
    ).rejects.toMatchObject({ kind: "replay_conflict" });

    // No second tx submitted on conflict.
    expect(chain.calls).toHaveLength(1);
  });

  it("does not write a dedupe row when the chain tx fails", async () => {
    const signer = makeSigner();
    const dedupe = new MemoryDedupe();
    const chain = new StubChain();
    chain.failNext = true;
    const deps = depsWith({
      tokenSigner: signer,
      dedupe,
      chain,
      nowUnix,
    });
    await expect(
      issueKycTest(deps, {
        submission: makeSubmission({ signer, flowStartedAtUnix }),
        agentCardPubkey: CARD_A,
      }),
    ).rejects.toMatchObject({ kind: "chain_failed" });
    expect(dedupe.rows.size).toBe(0);

    // Retry succeeds because no dedupe row was poisoned.
    const res = await issueKycTest(deps, {
      submission: makeSubmission({ signer, flowStartedAtUnix }),
      agentCardPubkey: CARD_A,
    });
    expect(res.status).toBe("issued");
  });
});

describe("renderKycTestFormHtml", () => {
  it("renders a form posting to actionUrl with the dwell countdown", () => {
    const signer = makeSigner();
    const html = renderKycTestFormHtml({
      actionUrl: "/issuers/kyc-test/submit",
      tokenSigner: signer,
      nowUnix: () => 1_700_000_000,
    });
    expect(html).toContain('action="/issuers/kyc-test/submit"');
    expect(html).toContain('name="fullName"');
    expect(html).toContain('name="dobIso"');
    expect(html).toContain('name="flowStartedAtUnix"');
    expect(html).toContain('value="1700000000"');
    expect(html).toContain("This is a mock issuer");
    expect(html).toContain("kyc.us-test");
    // Submit button starts disabled until JS clears the dwell.
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("escapes a malicious actionUrl", () => {
    const signer = makeSigner();
    const html = renderKycTestFormHtml({
      actionUrl: '"><script>alert(1)</script>',
      tokenSigner: signer,
      nowUnix: () => 1_700_000_000,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
