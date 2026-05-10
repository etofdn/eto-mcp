#!/usr/bin/env node
// FN-200: build example claimCommitments arrays for each banking credential
// schema by invoking the FN-082 eto-zk-cli (Poseidon-2 over BN254 Fr, t=3).
//
// Output: writes JSON to stdout with shape:
//   { [credName]: { example: <vc body>, claimCommitments: [...entries] } }
//
// Salts are deterministic test salts of the form `byte(i+1) repeated 32x`,
// where i is the lexicographic index of the field. Real issuers MUST sample
// salts from a CSPRNG and never reuse them.

import { execFileSync } from "node:child_process";

const CLI = process.env.ETO_ZK_CLI ?? "/home/naman/eto/target/release/eto-zk-cli";

// Example credentialSubject objects. These mirror the schema-required fields
// and use obviously-fake test values. Numeric fields are Number, strings are
// strings — value-encoding auto-detect in `eto-zk-cli commit` handles both.
const examples = {
  "account-checking": {
    id: "did:eto:agentcard:0000000000000000000000000000000000000000000000000000000000000001",
    account_pda: "cafef00dcafef00dcafef00dcafef00dcafef00dcafef00dcafef00dcafef00d",
    holder: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    opened_slot: 1234567,
    currency: "eUSD",
    opening_balance: 1000000000,
  },
  "account-savings": {
    id: "did:eto:agentcard:0000000000000000000000000000000000000000000000000000000000000002",
    account_pda: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    holder: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    opened_slot: 1234567,
    currency: "eUSD",
    opening_balance: 5000000000,
    apy_bps: 400,
  },
  "card-debit": {
    id: "did:eto:agentcard:0000000000000000000000000000000000000000000000000000000000000003",
    card_id_hash: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    holder: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    linked_account_pda: "cafef00dcafef00dcafef00dcafef00dcafef00dcafef00dcafef00dcafef00d",
    jurisdiction: "us",
    issued_slot: 1234567,
    spending_limit_per_day: 5000000000,
    network_brand: "visa",
    tier: "standard",
  },
  "tax-1099": {
    id: "did:eto:agentcard:0000000000000000000000000000000000000000000000000000000000000004",
    year: 2026,
    interest_income_atomic: 123456789,
    fees_atomic: 4200,
    withholding_atomic: 0,
    currency: "eUSD",
  },
};

// Sort leaf field paths lexicographically (UTF-8 byte order — JS default `<`
// on strings already does this for ASCII paths).
function sortedPaths(subject) {
  return Object.keys(subject)
    .map((k) => `credentialSubject.${k}`)
    .sort();
}

function saltFor(idx) {
  // 32 bytes of (idx+1) — deterministic + obviously test-only
  const byte = ((idx + 1) & 0xff).toString(16).padStart(2, "0");
  return byte.repeat(32);
}

function commit({ fieldPath, value, idx, salt }) {
  // Strip "credentialSubject." prefix for the --field arg label, but the
  // §10.3.1 ABI uses the full dotted path. The CLI only emits this label
  // verbatim back as `fieldPath`, so we pass the full path.
  const out = execFileSync(CLI, [
    "commit",
    "--field", fieldPath,
    "--value", String(value),
    "--idx", String(idx),
    "--salt", salt,
  ], { encoding: "utf8" });
  return JSON.parse(out);
}

const result = {};
for (const [name, subject] of Object.entries(examples)) {
  const paths = sortedPaths(subject);
  const claimCommitments = paths.map((fieldPath, idx) => {
    const key = fieldPath.replace(/^credentialSubject\./, "");
    const value = subject[key];
    const salt = saltFor(idx);
    const out = commit({ fieldPath, value, idx, salt });
    return out;
  });
  result[name] = { subject, claimCommitments };
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
