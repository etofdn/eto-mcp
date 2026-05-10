/**
 * FN-018 — skill-cert issuer boundary suite.
 *
 * No-signature issuer: tampered-signature is N/A. We substitute the
 * tampered-envelope invariant from the PROMPT — mutate the pinned VC,
 * recompute `sha256(jcs(...))`, and assert the mutated hash diverges
 * from the on-chain `claim_hash`. This is the boundary contract a
 * verifier walks under the no-signature issuer model.
 *
 * Expiry is N/A on this issuer: skill-cert hard-codes
 * `validUntilSlot = 0n` per L1 §5.1; expiry is an on-chain concern,
 * not an issuer-side one. Documented and omitted.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  InMemorySkillBindingStore,
  SkillCertIssuer,
  SkillCertIssuerError,
  StaticSkillWhitelist,
  canonicalJson,
  schemaIdForSkill,
  sha256Hex,
} from "../../src/issuers/skill-cert.js";
import type {
  AgentCardSignatureVerifier,
  ChainClient,
  IpfsPinner,
  IssueCredentialArgs,
  IssueCredentialResult,
  SkillBinding,
  SkillBindingStore,
  SkillCertIssueRequest,
} from "../../src/issuers/skill-cert.types.js";

const acceptAllSignatureVerifier: AgentCardSignatureVerifier = {
  async verify() {
    return true;
  },
};

function req(
  skill: string,
  subjectAgentCard: string,
): SkillCertIssueRequest {
  return {
    skill,
    subjectAgentCard,
    agentCardSignature: "AA",
    issuanceNonce: "nonce",
  };
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

class MockChainLedger implements ChainClient {
  public readonly calls: IssueCredentialArgs[] = [];
  public readonly accounts = new Map<
    string,
    { schema: string; subject: string; claimHash: string; claimUri: string }
  >();

  async issueCredential(
    args: IssueCredentialArgs,
  ): Promise<IssueCredentialResult> {
    this.calls.push(args);
    const idx = this.calls.length;
    const pda = `pda_${idx}_${args.subjectAgentCard.slice(0, 6)}`;
    this.accounts.set(pda, {
      schema: args.schema,
      subject: args.subjectAgentCard,
      claimHash: args.claimHash,
      claimUri: args.claimUri,
    });
    return {
      credentialPda: pda,
      txSignature: `tx_${idx.toString().padStart(4, "0")}`,
    };
  }
}

class MockIpfs implements IpfsPinner {
  public readonly store = new Map<string, unknown>();
  async pinJson(value: unknown): Promise<string> {
    const cid = sha256Hex(canonicalJson(value)).slice(0, 46);
    this.store.set(cid, value);
    return `ipfs://${cid}`;
  }
  fetch(uri: string): unknown {
    return this.store.get(uri.replace("ipfs://", ""));
  }
}

const ISSUER_DID = "did:eto:skill-cert";
const SUBJECT_A = "AgentCardA1111111111111111111111111111111111";
const SUBJECT_B = "AgentCardB2222222222222222222222222222222222";

function buildIssuer(opts?: {
  readonly whitelist?: StaticSkillWhitelist;
  readonly bindingStore?: SkillBindingStore;
  readonly chain?: MockChainLedger;
  readonly now?: () => number;
}): {
  issuer: SkillCertIssuer;
  whitelist: StaticSkillWhitelist;
  bindingStore: SkillBindingStore;
  chain: MockChainLedger;
  ipfs: MockIpfs;
} {
  const whitelist =
    opts?.whitelist ??
    new StaticSkillWhitelist({
      "solidity-audit": [SUBJECT_A, SUBJECT_B],
      "data-analyze": [SUBJECT_A],
    });
  const bindingStore = opts?.bindingStore ?? new InMemorySkillBindingStore();
  const chain = opts?.chain ?? new MockChainLedger();
  const ipfs = new MockIpfs();
  const now = opts?.now ?? (() => Date.UTC(2026, 3, 29, 12, 0, 0));
  const issuer = new SkillCertIssuer(
    { issuerDid: ISSUER_DID },
    {
      whitelist,
      bindingStore,
      chain,
      ipfs,
      signatureVerifier: acceptAllSignatureVerifier,
      now,
    },
  );
  return { issuer, whitelist, bindingStore, chain, ipfs };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("skill-cert issuer — boundary suite (FN-018)", () => {
  it("happy issuance: schema=schemaIdForSkill(skill), idempotent=false, VC type set", async () => {
    const { issuer, chain, ipfs } = buildIssuer();
    const out = await issuer.issue(req("solidity-audit", SUBJECT_A));

    expect(out.idempotent).toBe(false);
    expect(out.schema).toBe(schemaIdForSkill("solidity-audit"));
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.schema).toBe(schemaIdForSkill("solidity-audit"));
    // Lock subject provenance: caller-supplied, not store-derived.
    expect(chain.calls[0]?.subjectAgentCard).toBe(SUBJECT_A);
    expect(chain.calls[0]?.validUntilSlot).toBe(0n);

    const vc = ipfs.fetch(out.claimUri) as Record<string, unknown>;
    expect(vc["type"]).toEqual([
      "VerifiableCredential",
      "SkillCertCredential",
    ]);
    expect(typeof vc["issuanceDate"]).toBe("string");
    expect(out.claimHash).toBe(sha256Hex(canonicalJson(vc)));
  });

  it("replay (same skill+subject): second issue() returns idempotent with same PDA", async () => {
    const { issuer, chain } = buildIssuer();
    const r1 = await issuer.issue(req("solidity-audit", SUBJECT_A));
    const r2 = await issuer.issue(req("solidity-audit", SUBJECT_A));
    expect(r1.idempotent).toBe(false);
    expect(r2.idempotent).toBe(true);
    expect(r2.credentialPda).toBe(r1.credentialPda);
    expect(chain.calls).toHaveLength(1);
  });

  it("replay (same skill, DIFFERENT subject): independent fresh issuance, new PDA", async () => {
    const { issuer, chain } = buildIssuer();
    const r1 = await issuer.issue(req("solidity-audit", SUBJECT_A));
    const r2 = await issuer.issue(req("solidity-audit", SUBJECT_B));
    expect(r1.idempotent).toBe(false);
    expect(r2.idempotent).toBe(false);
    expect(r1.credentialPda).not.toBe(r2.credentialPda);
    expect(chain.calls).toHaveLength(2);
  });

  it("binding-store race: lost put recovers via canonical row → idempotent", async () => {
    // Simulate the race documented in `skill-cert.ts` step 6:
    //   - `get` returns undefined (no pre-existing row),
    //   - chain.issueCredential succeeds,
    //   - `put` throws because a concurrent caller landed first,
    //   - the issuer recovers by re-`get`ing and returning the
    //     canonical row with `idempotent: true`.
    const canonical: SkillBinding = {
      skill: "solidity-audit",
      subjectAgentCard: SUBJECT_A,
      credentialPda: "canonical-pda",
      txSignature: "canonical-sig",
      claimUri: "ipfs://canonical",
      claimHash: "ff".repeat(32),
      issuedAtMs: Date.UTC(2026, 3, 29),
    };
    let getCalls = 0;
    const racingStore: SkillBindingStore = {
      async get(skill, subject) {
        getCalls += 1;
        // First call (idempotency pre-check): pretend no row exists.
        if (getCalls === 1) return undefined;
        // Recovery `get` (after `put` collision): canonical row.
        if (skill === canonical.skill && subject === canonical.subjectAgentCard) {
          return canonical;
        }
        return undefined;
      },
      async put() {
        throw new Error("simulated race: row already exists");
      },
    };
    const { issuer, chain } = buildIssuer({ bindingStore: racingStore });
    const out = await issuer.issue(req("solidity-audit", SUBJECT_A));
    expect(out.idempotent).toBe(true);
    expect(out.credentialPda).toBe(canonical.credentialPda);
    expect(out.claimHash).toBe(canonical.claimHash);
    // Chain WAS called once before the race surfaced.
    expect(chain.calls).toHaveLength(1);
  });

  it("tampered envelope (no-signature issuer): mutated VC hash differs from chain claim_hash", async () => {
    // skill-cert has no signature path; the boundary invariant under
    // the no-signature contract is: the JCS hash a verifier computes
    // over the pinned envelope MUST equal the on-chain claim_hash. A
    // mutation breaks the equality.
    const { issuer, ipfs, chain } = buildIssuer();
    const out = await issuer.issue(req("solidity-audit", SUBJECT_A));
    const vc = ipfs.fetch(out.claimUri) as Record<string, unknown>;
    expect(out.claimHash).toBe(sha256Hex(canonicalJson(vc)));
    expect(chain.accounts.get(out.credentialPda)?.claimHash).toBe(
      out.claimHash,
    );

    const mutated = { ...vc, issuer: "did:eto:other-issuer" };
    const mutatedHash = sha256Hex(canonicalJson(mutated));
    expect(mutatedHash).not.toBe(out.claimHash);
  });

  // NB: skill-cert hard-codes valid_until_slot = 0; expiry is an
  // on-chain concern. No expiry case here.

  it("non-whitelisted subject: SkillCertIssuerError(NOT_WHITELISTED, 403); chain not called", async () => {
    const { issuer, chain } = buildIssuer();
    let caught: unknown;
    try {
      await issuer.issue(req("solidity-audit", "AgentCardForbiddenZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SkillCertIssuerError);
    expect((caught as SkillCertIssuerError).code).toBe("NOT_WHITELISTED");
    expect((caught as SkillCertIssuerError).status).toBe(403);
    expect(chain.calls).toHaveLength(0);
  });

  it("invalid skill slug: SkillCertIssuerError(INVALID_SKILL, 400); chain not called", async () => {
    const { issuer, chain } = buildIssuer();
    let caught: unknown;
    try {
      await issuer.issue(req("Bad Slug!", SUBJECT_A));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SkillCertIssuerError);
    expect((caught as SkillCertIssuerError).code).toBe("INVALID_SKILL");
    expect((caught as SkillCertIssuerError).status).toBe(400);
    expect(chain.calls).toHaveLength(0);
  });

  it("empty subject: SkillCertIssuerError(INVALID_SUBJECT, 400); chain not called", async () => {
    const { issuer, chain } = buildIssuer();
    let caught: unknown;
    try {
      await issuer.issue(req("solidity-audit", "" ));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SkillCertIssuerError);
    expect((caught as SkillCertIssuerError).code).toBe("INVALID_SUBJECT");
    expect(chain.calls).toHaveLength(0);
  });

  it("emits unique credentials across two independent issuances", async () => {
    let now = Date.UTC(2026, 3, 29, 12, 0, 0);
    const { issuer, chain, ipfs } = buildIssuer({ now: () => now });
    const r1 = await issuer.issue(req("solidity-audit", SUBJECT_A));
    now += 60_000;
    const r2 = await issuer.issue(req("data-analyze", SUBJECT_A));
    expect(r1.credentialPda).not.toBe(r2.credentialPda);
    expect(chain.calls).toHaveLength(2);
    const vc1 = ipfs.fetch(r1.claimUri) as Record<string, unknown>;
    const vc2 = ipfs.fetch(r2.claimUri) as Record<string, unknown>;
    expect(vc1["issuanceDate"]).not.toBe(vc2["issuanceDate"]);
    expect(r1.schema).not.toBe(r2.schema);
  });
});

/* Sanity: the schema-id helper is stable across calls. */
describe("skill-cert schemaIdForSkill (regression pin)", () => {
  it("matches sha256('eto.beckn.schema.skill-cert.<skill>.v1')", () => {
    const expected = createHash("sha256")
      .update("eto.beckn.schema.skill-cert.solidity-audit.v1", "utf8")
      .digest("hex");
    expect(schemaIdForSkill("solidity-audit")).toBe(expected);
  });
});
