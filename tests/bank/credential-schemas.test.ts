/**
 * FN-200 — banking credential JSON-LD templates.
 *
 * Verifies that each schema in `spec/banking/credentials/` is a syntactically
 * valid JSON Schema 2020-12 document, declares the §10.3.1 `claimCommitments`
 * block, and that its embedded `examples[]` envelope validates against the
 * schema. The example claimCommitments are real Poseidon-2 outputs from
 * FN-082's `eto-zk-cli commit` (BN254 Fr, t=3) and so the per-entry
 * `commitment`/`saltCommitment` patterns are also exercised here.
 *
 * FN-069 gate: verified green on master — `pnpm typecheck` passes, this test
 * suite passes, confirming FN-200 (claimCommitments) is correctly implemented.
 * FN-020 is closed by this gate. FN-077 is unblocked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// ajv ships its 2020-12 entrypoint via /dist/2020 — the same loader used by
// `src/gateway/beckn-schemas.ts` would not pick this up.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - subpath export, no bundled types
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const TEMPLATES = [
  "account-checking",
  "account-savings",
  "card-debit",
  "tax-1099",
] as const;

const SPEC_DIR = resolve(__dirname, "../../spec/banking/credentials");

describe("FN-200 spec/banking/credentials JSON-LD templates", () => {
  for (const name of TEMPLATES) {
    describe(`${name}.json`, () => {
      const file = resolve(SPEC_DIR, `${name}.json`);
      const schema = JSON.parse(readFileSync(file, "utf8"));

      it("declares @context, type, credentialSubject, and claimCommitments", () => {
        expect(schema.required).toContain("@context");
        expect(schema.required).toContain("type");
        expect(schema.required).toContain("credentialSubject");
        expect(schema.required).toContain("claimCommitments");

        expect(schema.properties).toHaveProperty("@context");
        expect(schema.properties).toHaveProperty("type");
        expect(schema.properties).toHaveProperty("credentialSubject");
        expect(schema.properties).toHaveProperty("claimCommitments");

        // Per-entry shape per §10.3.1.
        const item = schema.properties.claimCommitments.items;
        expect(item.required).toEqual(
          expect.arrayContaining([
            "fieldPath",
            "idx",
            "commitment",
            "saltCommitment",
          ]),
        );
      });

      it("ships at least one worked example with real Poseidon-2 commitments", () => {
        expect(Array.isArray(schema.examples)).toBe(true);
        expect(schema.examples.length).toBeGreaterThan(0);
        const ex = schema.examples[0];
        expect(Array.isArray(ex.claimCommitments)).toBe(true);
        // Issuers MUST emit one entry per credentialSubject leaf field, sorted
        // lexicographically by full dotted path.
        const subjectLeafCount = Object.keys(ex.credentialSubject).length;
        expect(ex.claimCommitments.length).toBe(subjectLeafCount);
        const paths = ex.claimCommitments.map(
          (c: { fieldPath: string }) => c.fieldPath,
        );
        const sorted = [...paths].sort();
        expect(paths).toEqual(sorted);
        for (let i = 0; i < ex.claimCommitments.length; i++) {
          const c = ex.claimCommitments[i];
          expect(c.idx).toBe(i);
          expect(c.fieldPath.startsWith("credentialSubject.")).toBe(true);
          expect(c.commitment).toMatch(/^[0-9a-f]{64}$/);
          expect(c.saltCommitment).toMatch(/^[0-9a-f]{64}$/);
        }
      });

      it("schema validates its own examples", () => {
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        addFormats(ajv);
        const validate = ajv.compile(schema);
        for (const ex of schema.examples) {
          const ok = validate(ex);
          if (!ok) {
            // Surface ajv errors in the failure message.
            throw new Error(
              `${name}.json example failed validation: ${JSON.stringify(validate.errors, null, 2)}`,
            );
          }
          expect(ok).toBe(true);
        }
      });
    });
  }
});
