#!/usr/bin/env node
// FN-200: rewrite spec/banking/credentials/*.json to add the §10.3.1
// `claimCommitments` block (schema + worked example) using real Poseidon-2
// outputs from FN-082's eto-zk-cli.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const fixtures = JSON.parse(
  fs.readFileSync(path.join(ROOT, "spec/banking/credentials/_fixtures.json"), "utf8")
);

const META = {
  "account-checking": {
    typeName: "CheckingAccountCredential",
    issuer: "did:eto:bank:eto-reference",
    issuanceDate: "2026-04-30T00:00:00.000Z",
    contextV1: "https://schema.eto.dev/banking/account-checking/v1",
  },
  "account-savings": {
    typeName: "SavingsAccountCredential",
    issuer: "did:eto:bank:eto-reference",
    issuanceDate: "2026-04-30T00:00:00.000Z",
    contextV1: "https://schema.eto.dev/banking/account-savings/v1",
  },
  "card-debit": {
    typeName: "CardDebitCredential",
    issuer: "did:eto:bank:eto-reference",
    issuanceDate: "2026-04-30T00:00:00.000Z",
    contextV1: "https://schema.eto.dev/banking/card-debit/v1",
  },
  "tax-1099": {
    typeName: "Tax1099Credential",
    issuer: "did:eto:bank:eto-reference",
    issuanceDate: "2027-01-31T00:00:00.000Z",
    contextV1: "https://schema.eto.dev/banking/tax-1099/v1",
  },
};

// Stable, ETO-issuer-shaped 32-byte hex placeholders for the example envelope.
const EXAMPLE_ISSUER_AUTHORITY =
  "abadcafeabadcafeabadcafeabadcafeabadcafeabadcafeabadcafeabadcafe";
const EXAMPLE_CLAIM_HASH =
  "0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de";

const claimCommitmentsSchema = {
  type: "array",
  description:
    "Per-attribute Poseidon-2 commitments over every leaf field of credentialSubject, per spec/SINGULARITY-LAYER-1.md §10.3.1. Issuers MUST emit one entry for every leaf field (sorted lexicographically by fieldPath) before computing claim_hash. Required by FN-077 (selective-disclosure ZK proofs); produced by FN-082's `eto-zk-cli commit`.",
  minItems: 1,
  items: {
    type: "object",
    required: ["fieldPath", "idx", "commitment", "saltCommitment"],
    additionalProperties: false,
    properties: {
      fieldPath: {
        type: "string",
        description:
          "Dot-separated JSON path from the VC root, e.g. 'credentialSubject.account_pda'. Leaf fields only.",
        pattern: "^credentialSubject\\.",
      },
      idx: {
        type: "integer",
        minimum: 0,
        description:
          "Zero-based position of this fieldPath in the lexicographically sorted leaf-path list. MUST equal the field_index public input (slot 6) when constructing a verify_credential_predicate proof for this attribute.",
      },
      commitment: {
        type: "string",
        pattern: "^[0-9a-fA-F]{64}$",
        description:
          "Poseidon2_t3([value_field, salt_field, idx_field])[0] — 32-byte little-endian hex.",
      },
      saltCommitment: {
        type: "string",
        pattern: "^[0-9a-fA-F]{64}$",
        description:
          "Poseidon2_t3([salt_field, Fr::ZERO, idx_field])[0] — 32-byte little-endian hex. Pins the salt domain without revealing salt.",
      },
    },
  },
};

function buildExample(name) {
  const meta = META[name];
  const fx = fixtures[name];
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      meta.contextV1,
    ],
    type: ["VerifiableCredential", meta.typeName],
    issuer: meta.issuer,
    issuanceDate: meta.issuanceDate,
    credentialSubject: fx.subject,
    issuerAuthority: EXAMPLE_ISSUER_AUTHORITY,
    claimCommitments: fx.claimCommitments,
    claim_hash: EXAMPLE_CLAIM_HASH,
  };
}

for (const [name] of Object.entries(META)) {
  const file = path.join(ROOT, "spec/banking/credentials", `${name}.json`);
  const schema = JSON.parse(fs.readFileSync(file, "utf8"));

  // Inject claimCommitments into properties + required.
  schema.properties.claimCommitments = claimCommitmentsSchema;
  if (!schema.required.includes("claimCommitments")) {
    // Insert before claim_hash so claim_hash sits at the end of required.
    const idx = schema.required.indexOf("issuerAuthority");
    if (idx >= 0) {
      schema.required.splice(idx + 1, 0, "claimCommitments");
    } else {
      schema.required.push("claimCommitments");
    }
  }

  // Update $comment to mention FN-200 / FN-082.
  if (typeof schema.$comment === "string" && !schema.$comment.includes("FN-200")) {
    schema.$comment +=
      " FN-200 added the §10.3.1 `claimCommitments` block; example commitments computed via FN-082's eto-zk-cli (Poseidon-2 over BN254 Fr, t=3).";
  }

  // Replace examples with the worked envelope.
  schema.examples = [buildExample(name)];

  fs.writeFileSync(file, JSON.stringify(schema, null, 2) + "\n");
  console.log(`wrote ${file}`);
}
