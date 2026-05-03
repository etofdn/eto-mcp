import { describe, it, expect } from "vitest";
import {
  sharesHumanAuthority,
  canInheritTrust,
} from "../../src/models/authority-inheritance.js";
import type {
  AgentIdentity,
  HumanAuthority,
} from "../../src/models/agent-identity.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIdentity(
  authority: HumanAuthority | undefined,
): AgentIdentity {
  return {
    // `as any` only for the missing-field case; otherwise authority is set.
    human_authority: authority as HumanAuthority,
    model_attestation: { attestation_status: "absent" },
    environment: {
      surface: "sse",
      server_instance: "2026-05-03T00:00:00.000Z",
      wallet_anchor: { id: "w-1", svm: null, evm: null, label: null },
    },
    session_scope: {
      scope: authority?.sub ?? "0xUnknown",
      expires_at_iso: "2030-01-01T00:00:00.000Z",
      capabilities: [],
    },
  };
}

const aliceSiwe: HumanAuthority = {
  sub: "0xAlice",
  kind: "thirdweb",
  auth_strategy: "siwe",
};

const aliceSiweOther: HumanAuthority = {
  sub: "0xAlice",
  kind: "thirdweb",
  auth_strategy: "siwe",
};

const aliceOauth: HumanAuthority = {
  sub: "0xAlice",
  kind: "thirdweb",
  auth_strategy: "inapp_oauth",
};

const bobSiwe: HumanAuthority = {
  sub: "0xBob",
  kind: "thirdweb",
  auth_strategy: "siwe",
};

const aliceDev: HumanAuthority = {
  sub: "0xAlice",
  kind: "dev",
  auth_strategy: "dev",
};

const aliceStdio: HumanAuthority = {
  sub: "__stdio__",
  kind: "stdio",
};

// ---------------------------------------------------------------------------
// Positive case
// ---------------------------------------------------------------------------

describe("sharesHumanAuthority — positive", () => {
  it("two verified identities with matching (auth_strategy, sub) inherit trust", () => {
    const a = makeIdentity(aliceSiwe);
    const b = makeIdentity(aliceSiweOther);
    expect(sharesHumanAuthority(a, b)).toBe(true);
    expect(canInheritTrust(a, b)).toEqual({ allowed: true, reason: "allowed" });
  });

  it("is symmetric", () => {
    const a = makeIdentity(aliceSiwe);
    const b = makeIdentity(aliceSiweOther);
    expect(sharesHumanAuthority(b, a)).toBe(true);
  });

  it("is reflexive on a verified identity", () => {
    const a = makeIdentity(aliceSiwe);
    expect(sharesHumanAuthority(a, a)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Strategy / sub mismatches
// ---------------------------------------------------------------------------

describe("sharesHumanAuthority — strategy/sub mismatches", () => {
  it("different auth_strategy → false / different_strategy", () => {
    const a = makeIdentity(aliceSiwe);
    const b = makeIdentity(aliceOauth);
    expect(sharesHumanAuthority(a, b)).toBe(false);
    expect(canInheritTrust(a, b)).toEqual({
      allowed: false,
      reason: "different_strategy",
    });
  });

  it("different sub → false / different_sub", () => {
    const a = makeIdentity(aliceSiwe);
    const b = makeIdentity(bobSiwe);
    expect(sharesHumanAuthority(a, b)).toBe(false);
    expect(canInheritTrust(a, b)).toEqual({
      allowed: false,
      reason: "different_sub",
    });
  });
});

// ---------------------------------------------------------------------------
// Verification failures
// ---------------------------------------------------------------------------

describe("sharesHumanAuthority — verification failures", () => {
  it("self is dev-bypass → unverified_self even with matching sub", () => {
    const self = makeIdentity(aliceDev);
    const other = makeIdentity(aliceSiwe);
    expect(sharesHumanAuthority(self, other)).toBe(false);
    expect(canInheritTrust(self, other)).toEqual({
      allowed: false,
      reason: "unverified_self",
    });
  });

  it("other is dev-bypass → unverified_other even with matching sub", () => {
    const self = makeIdentity(aliceSiwe);
    const other = makeIdentity(aliceDev);
    expect(sharesHumanAuthority(self, other)).toBe(false);
    expect(canInheritTrust(self, other)).toEqual({
      allowed: false,
      reason: "unverified_other",
    });
  });

  it("self is stdio-kind → unverified_self", () => {
    const self = makeIdentity(aliceStdio);
    const other = makeIdentity(aliceSiwe);
    expect(sharesHumanAuthority(self, other)).toBe(false);
    expect(canInheritTrust(self, other).reason).toBe("unverified_self");
  });

  it("thirdweb-kind without auth_strategy → unverified", () => {
    const dodgy: HumanAuthority = { sub: "0xAlice", kind: "thirdweb" };
    const self = makeIdentity(dodgy);
    const other = makeIdentity(aliceSiwe);
    expect(sharesHumanAuthority(self, other)).toBe(false);
    expect(canInheritTrust(self, other).reason).toBe("unverified_self");
  });

  it("thirdweb-kind with dev auth_strategy is invalid for inheritance", () => {
    // Synthetic: kind=thirdweb but strategy=dev should never occur via
    // buildInterimAgentIdentity, but defensive predicate must reject.
    const dodgy: HumanAuthority = {
      sub: "0xAlice",
      kind: "thirdweb",
      auth_strategy: "dev",
    };
    const self = makeIdentity(dodgy);
    const other = makeIdentity(aliceSiwe);
    expect(sharesHumanAuthority(self, other)).toBe(false);
    expect(canInheritTrust(self, other).reason).toBe("unverified_self");
  });
});

// ---------------------------------------------------------------------------
// Missing field
// ---------------------------------------------------------------------------

describe("sharesHumanAuthority — missing human_authority", () => {
  it("self missing field → missing_human_authority", () => {
    const self = makeIdentity(undefined);
    const other = makeIdentity(aliceSiwe);
    expect(sharesHumanAuthority(self, other)).toBe(false);
    expect(canInheritTrust(self, other)).toEqual({
      allowed: false,
      reason: "missing_human_authority",
    });
  });

  it("other missing field → missing_human_authority", () => {
    const self = makeIdentity(aliceSiwe);
    const other = makeIdentity(undefined);
    expect(sharesHumanAuthority(self, other)).toBe(false);
    expect(canInheritTrust(self, other)).toEqual({
      allowed: false,
      reason: "missing_human_authority",
    });
  });

  it("missing_human_authority takes precedence over unverified_*", () => {
    // Even if the *other* side is unverified, missing-on-self wins per
    // spec §2.3 precedence ordering.
    const self = makeIdentity(undefined);
    const other = makeIdentity(aliceDev);
    expect(canInheritTrust(self, other).reason).toBe("missing_human_authority");
  });
});
