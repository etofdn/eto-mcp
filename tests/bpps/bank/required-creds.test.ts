/**
 * Tests for the bank-as-BPP required-credential policy (FN-099 /
 * T-3.9.1.5). Covers schema-hash pinning, parity with the FN-040
 * source of truth, hex/HEX32 conformance, per-action lookup
 * semantics, immutability, and Zod parity.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_OPEN_ACTIONS,
  ACCOUNT_OPEN_REQUIRED_CREDS,
  BANK_REQUIRED_CREDS_BY_ACTION,
  KYC_US_TEST_SCHEMA_HASH_HEX,
  KYC_US_TEST_SCHEMA_LABEL,
  VERIFIED_HUMAN_SCHEMA_HASH_HEX,
  VERIFIED_HUMAN_SCHEMA_LABEL,
  isAccountOpenAction,
  requiredCredsForAction,
} from "../../../keeper/bpps/bank/required-creds.js";
import { KYC_TEST_SCHEMA_ID_HEX } from "../../../src/issuers/kyc-test.js";
import {
  zRequiredCredential,
  type RequiredCredential,
} from "../../../keeper/templates/bpp/types.js";

const HEX32_RE = /^[0-9a-f]{64}$/;

// Recompute pin: sha256("eto.beckn.schema.verified-human.v1") =
//   1582fa154aa27a43f18d78fe28c7bb407790d7a63f782396b120bb77de71f389
const VERIFIED_HUMAN_PIN =
  "1582fa154aa27a43f18d78fe28c7bb407790d7a63f782396b120bb77de71f389";

describe("FN-099 — bank required-cred policy: hash pinning", () => {
  it("verified-human schema hash matches the pinned hex", () => {
    expect(VERIFIED_HUMAN_SCHEMA_LABEL).toBe(
      "eto.beckn.schema.verified-human.v1",
    );
    expect(VERIFIED_HUMAN_SCHEMA_HASH_HEX).toBe(VERIFIED_HUMAN_PIN);
    // Recompute inline so a future label drift is loud.
    const expected = createHash("sha256")
      .update(VERIFIED_HUMAN_SCHEMA_LABEL, "utf8")
      .digest("hex");
    expect(VERIFIED_HUMAN_SCHEMA_HASH_HEX).toBe(expected);
  });

  it("kyc.us-test schema hash matches FN-040's KYC_TEST_SCHEMA_ID_HEX exactly", () => {
    expect(KYC_US_TEST_SCHEMA_LABEL).toBe("eto.beckn.schema.kyc.us-test.v1");
    expect(KYC_US_TEST_SCHEMA_HASH_HEX).toBe(KYC_TEST_SCHEMA_ID_HEX);
  });
});

describe("FN-099 — HEX32 conformance", () => {
  it("both hashes match the HEX32 regex", () => {
    expect(VERIFIED_HUMAN_SCHEMA_HASH_HEX).toMatch(HEX32_RE);
    expect(KYC_US_TEST_SCHEMA_HASH_HEX).toMatch(HEX32_RE);
  });

  it("both hashes decode to 32 raw bytes", () => {
    expect(Buffer.from(VERIFIED_HUMAN_SCHEMA_HASH_HEX, "hex").length).toBe(32);
    expect(Buffer.from(KYC_US_TEST_SCHEMA_HASH_HEX, "hex").length).toBe(32);
  });

  it("the two hashes are distinct (no accidental aliasing)", () => {
    expect(VERIFIED_HUMAN_SCHEMA_HASH_HEX).not.toBe(KYC_US_TEST_SCHEMA_HASH_HEX);
  });
});

describe("FN-099 — policy shape", () => {
  it("ACCOUNT_OPEN_REQUIRED_CREDS has exactly two entries in [verified-human, kyc.us-test] order", () => {
    expect(ACCOUNT_OPEN_REQUIRED_CREDS.length).toBe(2);
    expect(ACCOUNT_OPEN_REQUIRED_CREDS[0]?.schema).toBe(
      VERIFIED_HUMAN_SCHEMA_HASH_HEX,
    );
    expect(ACCOUNT_OPEN_REQUIRED_CREDS[1]?.schema).toBe(
      KYC_US_TEST_SCHEMA_HASH_HEX,
    );
  });

  it("every entry is mustBeActive=true with an empty issuerSet", () => {
    for (const cred of ACCOUNT_OPEN_REQUIRED_CREDS) {
      expect(cred.mustBeActive).toBe(true);
      expect(cred.issuerSet).toEqual([]);
    }
  });

  it("every entry parses under zRequiredCredential", () => {
    for (const cred of ACCOUNT_OPEN_REQUIRED_CREDS) {
      expect(() => zRequiredCredential.parse(cred)).not.toThrow();
    }
  });
});

describe("FN-099 — map coverage", () => {
  it("BANK_REQUIRED_CREDS_BY_ACTION keys exactly the two account-open actions", () => {
    expect(BANK_REQUIRED_CREDS_BY_ACTION.size).toBe(2);
    const keys = [...BANK_REQUIRED_CREDS_BY_ACTION.keys()].sort();
    expect(keys).toEqual([...ACCOUNT_OPEN_ACTIONS].sort());
  });

  it("both keys map to a deep-equal copy of ACCOUNT_OPEN_REQUIRED_CREDS", () => {
    for (const a of ACCOUNT_OPEN_ACTIONS) {
      expect(BANK_REQUIRED_CREDS_BY_ACTION.get(a)).toEqual(
        ACCOUNT_OPEN_REQUIRED_CREDS,
      );
    }
  });
});

describe("FN-099 — requiredCredsForAction lookup", () => {
  it("returns the two-cred policy for both account-open actions", () => {
    expect(requiredCredsForAction("bank.checking.open")).toEqual(
      ACCOUNT_OPEN_REQUIRED_CREDS,
    );
    expect(requiredCredsForAction("bank.savings.open")).toEqual(
      ACCOUNT_OPEN_REQUIRED_CREDS,
    );
  });

  it("returns [] for non-account-open / unknown / empty actions", () => {
    expect(requiredCredsForAction("bank.fiat-ramp")).toEqual([]);
    expect(requiredCredsForAction("text:summarize")).toEqual([]);
    expect(requiredCredsForAction("")).toEqual([]);
  });
});

describe("FN-099 — isAccountOpenAction predicate", () => {
  it("true for both account-open actions", () => {
    expect(isAccountOpenAction("bank.checking.open")).toBe(true);
    expect(isAccountOpenAction("bank.savings.open")).toBe(true);
  });

  it("false for unrelated / unknown actions", () => {
    expect(isAccountOpenAction("bank.fiat-ramp")).toBe(false);
    expect(isAccountOpenAction("text:summarize")).toBe(false);
    expect(isAccountOpenAction("")).toBe(false);
  });
});

describe("FN-099 — immutability", () => {
  it("ACCOUNT_OPEN_REQUIRED_CREDS array is frozen", () => {
    expect(Object.isFrozen(ACCOUNT_OPEN_REQUIRED_CREDS)).toBe(true);
    expect(() =>
      (ACCOUNT_OPEN_REQUIRED_CREDS as RequiredCredential[]).push({
        schema: VERIFIED_HUMAN_SCHEMA_HASH_HEX,
        issuerSet: [],
        mustBeActive: true,
      }),
    ).toThrow();
  });

  it("each entry in ACCOUNT_OPEN_REQUIRED_CREDS is frozen", () => {
    for (const cred of ACCOUNT_OPEN_REQUIRED_CREDS) {
      expect(Object.isFrozen(cred)).toBe(true);
      expect(() => {
        (cred as { schema: string }).schema = "deadbeef".repeat(8);
      }).toThrow();
    }
  });
});
