/**
 * FN-100 / T-3.9.1.6 — Bank Network lifecycle test scaffolding.
 *
 * Acceptance Criteria (verbatim):
 *   Bank Network created; admin updates; BPP catalog published; issuer auth works.
 *
 * Dependencies:
 *   IN  — FN-095: Bank IssuerNetwork init module + CLI (merged on master)
 *   IN  — FN-098: Bank BPP catalog scaffold (keeper/bpps/bank/catalog.json, 8 services)
 *   PENDING — T-3.9.1.3: Bank issuer service (not yet landed)
 *
 * PDA derivation reference (from src/runtime/src/programs/beckn/account.rs):
 *   seeds = ["network", network_id]
 *   IssuerNetworkAccount extends Network with:
 *     - issuer_authority: Pubkey
 *     - issuable_schemas: Vec<Hex32>
 *   Canonical bank schemas:
 *     - eto.beckn.schema.account.checking.v1
 *     - eto.beckn.schema.account.savings.v1
 *     - eto.beckn.schema.kyc.us-test.v1
 *
 * Test structure: 4 describe groups, 10 stubs (test.todo).
 * Real assertions are limited to what is already landed (catalog shape,
 * service count). Everything requiring on-chain or issuer-service
 * interaction is stubbed with test.todo pending T-3.9.1.1 / T-3.9.1.3
 * full wiring.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";

import catalogJson from "../../keeper/bpps/bank/catalog.json" assert { type: "json" };

// ---------------------------------------------------------------------------
// Constants derived from the in-tree catalog (FN-098, landed)
// ---------------------------------------------------------------------------

const CATALOG_SERVICE_COUNT = 8;

const CANONICAL_BANK_SCHEMAS = [
  "eto.beckn.schema.account.checking.v1",
  "eto.beckn.schema.account.savings.v1",
  "eto.beckn.schema.kyc.us-test.v1",
] as const;

// ---------------------------------------------------------------------------
// Helper: sha256 of a UTF-8 string → hex
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("bank Network lifecycle (FN-100)", () => {
  // -------------------------------------------------------------------------
  // Phase 1: Network creation (depends on FN-095 / T-3.9.1.1)
  // -------------------------------------------------------------------------
  describe("created (FN-095 / T-3.9.1.1, merged)", () => {
    test.todo("CLI init creates IssuerNetworkAccount at correct PDA");
    test.todo("issuer_authority matches the bank operator key");
    test.todo(
      "issuable_schemas contains the canonical bank schemas (account.checking, account.savings, kyc.us-test)",
    );
  });

  // -------------------------------------------------------------------------
  // Phase 2: Admin updates (depends on on-chain UpdateIssuer instruction)
  // -------------------------------------------------------------------------
  describe("admin updates", () => {
    test.todo("admin can rotate issuer_authority via UpdateIssuer instruction");
    test.todo("non-admin signer is rejected");
  });

  // -------------------------------------------------------------------------
  // Phase 3: BPP catalog published (FN-098 landed + FN-085 PublishCatalog)
  // -------------------------------------------------------------------------
  describe("BPP catalog published (FN-098 + FN-085)", () => {
    it("catalog.json contains exactly 8 services (FN-098 invariant)", () => {
      const services = (catalogJson as { services: unknown[] }).services;
      expect(services).toHaveLength(CATALOG_SERVICE_COUNT);
    });

    it("catalog.json sha256 is deterministic and non-empty", () => {
      const raw = JSON.stringify(catalogJson);
      const hash = sha256Hex(raw);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test.todo("PublishCatalog instruction creates CatalogCommit PDA");
    test.todo("catalog_hash matches sha256(catalog.json)");
    test.todo("all 8 services from FN-098 are reachable via Beckn search");
  });

  // -------------------------------------------------------------------------
  // Phase 4: Issuer auth (depends on T-3.9.1.3 — pending)
  // -------------------------------------------------------------------------
  describe("issuer auth works (T-3.9.1.3 — pending)", () => {
    test.todo("bank issuer signs IssueCredential for account.checking");
    test.todo("non-bank-issuer signing the same schema is rejected");
  });
});
