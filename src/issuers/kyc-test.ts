// kyc.us-test mock issuer (T-1.4.2.1, FN-040).
//
// **This is a mock. It is not real KYC.** The credential it issues is
// labeled `kyc.us-test` precisely so an audit, a relying party, or a
// future you can tell at a glance that the holder did not pass any
// regulated identity verification. The demo wires it in so we can
// show the gating mechanism (a Beckn offer requiring `schema =
// kyc.us-test`) before integrating a real partner.
//
// Flow:
//
//   1. Wallet UI opens the bridge issuer page (`renderKycTestFormHtml`),
//      which renders a `name + DOB` form. The page also includes a
//      bridge-signed `formToken` that pins `flowStartedAtUnix` so the
//      30-second dwell can't be back-dated.
//   2. The user fills in the form. Client-side JS waits ≥ 30 seconds
//      before enabling the submit button (cosmetic dwell).
//   3. POST to the bridge with `{ fullName, dobIso, flowStartedAtUnix,
//      formTokenHmacHex, agentCardPubkey }`. Bridge:
//        a. validates the form fields,
//        b. verifies the HMAC tag,
//        c. enforces `now - flowStartedAtUnix >= 30s` server-side,
//        d. derives `nullifier = sha256(domain | normName | dob)`,
//        e. consults dedupe (idempotent same-card / 409 different-card),
//        f. builds the JCS-canonical VC, pins, submits IssueCredential,
//        g. persists the dedupe row only after a successful chain tx.
//
// On-chain semantics: the resulting `Credential` PDA sits at
// `["cred", subject, issuer, schema]` with
// `schema = sha256("eto.beckn.schema.kyc.us-test.v1")`. A relying
// party predicate of `schema = kyc.us-test` matches; nothing about
// this credential should be interpreted as real-world KYC.

import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

import {
  KYC_TEST_MIN_DWELL_SECONDS,
  KycTestAgentCardSignatureVerifier,
  KycTestFormSubmission,
  KycTestFormTokenSigner,
  KycTestIssueError,
  KycTestIssueRequest,
  KycTestIssueResponse,
  KycTestIssuerDeps,
} from "./kyc-test.types.js";

export {
  KYC_TEST_MIN_DWELL_SECONDS,
  KycTestIssueError,
} from "./kyc-test.types.js";
export type {
  KycTestAgentCardSignatureVerifier,
  KycTestDedupeRow,
  KycTestDedupeStore,
  KycTestFormSubmission,
  KycTestFormTokenSigner,
  KycTestIssueCredentialClient,
  KycTestIssueRequest,
  KycTestIssueResponse,
  KycTestIssuerDeps,
  KycTestSlotClock,
  KycTestVcPinner,
} from "./kyc-test.types.js";

// -- Domain constants -------------------------------------------------

/**
 * Domain tag for the dedupe nullifier. The `mock-v1` suffix makes
 * sure that if we ever turn this into a real `kyc.us` adapter the
 * old mock-issued nullifiers don't collide with real-issued ones —
 * they're in distinct namespaces by construction.
 */
const KYC_TEST_NULLIFIER_DOMAIN = "eto.kyc.us-test.mock-v1";

/**
 * On-chain schema id. Distinct from `verified-human` so a relying
 * party that wants "passed our mock KYC" can pin this exact schema.
 */
export const KYC_TEST_SCHEMA_ID_HEX = sha256Hex(
  "eto.beckn.schema.kyc.us-test.v1",
);

const VALID_UNTIL_NO_BOUND = 0n;

// Form-field bounds. Generous enough to accept Unicode names, tight
// enough to reject obviously-malformed garbage.
const MAX_NAME_LEN = 200;
const MIN_NAME_LEN = 1;
const DOB_REGEX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

// -- Public entry points ----------------------------------------------

/**
 * Issue a `kyc.us-test` credential for a name+DOB form submission.
 *
 * Idempotent for `(nullifier, agent_card_pubkey)` repeats; throws
 * `KycTestIssueError("replay_conflict")` for a same-identity,
 * different-card collision.
 */
export async function issueKycTest(
  deps: KycTestIssuerDeps,
  request: KycTestIssueRequest,
): Promise<KycTestIssueResponse> {
  const { submission, agentCardPubkey, agentCardSignature } = request;
  if (agentCardPubkey.length === 0) {
    throw new KycTestIssueError(
      "invalid_form",
      "agentCardPubkey is empty",
      "empty_card",
    );
  }
  if (
    typeof agentCardSignature !== "string" ||
    agentCardSignature.length === 0
  ) {
    // Treat a missing signature as a wallet-binding failure so the
    // attacker doesn't get a free 400 — callers MUST prove control
    // of `agentCardPubkey`. Mirrors civic's behavior.
    throw new KycTestIssueError(
      "invalid_agent_card_signature",
      "agentCardSignature must be a non-empty base64 string",
      "empty_signature",
    );
  }

  // Step 1 — validate form fields.
  const normalized = validateAndNormalizeSubmission(submission);

  // Step 2 — verify the form HMAC. The token binds (name, dob,
  // flowStartedAtUnix); changing any of them invalidates the tag.
  // NOTE: the form HMAC does NOT bind `agentCardPubkey` (the form
  // is rendered before the wallet picks a card). The wallet-binding
  // is enforced separately by the Ed25519 `agentCardSignature`
  // check in Step 4 — see FN-057.
  const tokenOk = deps.tokenSigner.verify({
    fullName: submission.fullName,
    dobIso: submission.dobIso,
    flowStartedAtUnix: submission.flowStartedAtUnix,
    tag: submission.formTokenHmacHex,
  });
  if (!tokenOk) {
    throw new KycTestIssueError(
      "invalid_token",
      "form-token HMAC verification failed",
    );
  }

  // Step 3 — enforce the mock dwell.
  const minDwell = deps.minDwellSeconds ?? KYC_TEST_MIN_DWELL_SECONDS;
  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  const dwell = nowUnix - submission.flowStartedAtUnix;
  if (dwell < 0) {
    throw new KycTestIssueError(
      "dwell_in_future",
      "flowStartedAtUnix is in the future",
      `now=${nowUnix} started=${submission.flowStartedAtUnix}`,
    );
  }
  if (dwell < minDwell) {
    throw new KycTestIssueError(
      "dwell_too_short",
      `submission inside the ${minDwell}s mock dwell window`,
      `dwell=${dwell}`,
    );
  }

  // Step 4 — derive nullifier and verify the wallet-binding signature
  // BEFORE the dedupe lookup (FN-057). Without this, an attacker can
  // POST a victim's `agentCardPubkey` and burn the victim's
  // (nullifier, card) slot in the dedupe store, denying the rightful
  // owner of that identity any future issuance on their real card.
  const nullifier = deriveNullifier(normalized.normName, normalized.dobIso);

  const sigOk = await deps.signatureVerifier.verify({
    nullifier,
    agentCardPubkey,
    signature: agentCardSignature,
  });
  if (!sigOk) {
    throw new KycTestIssueError(
      "invalid_agent_card_signature",
      "agent card signature does not validate over sha256(nullifier || pubkey)",
    );
  }

  const existing = await deps.dedupe.get(nullifier);
  if (existing !== undefined) {
    if (existing.agentCardPubkey === agentCardPubkey) {
      return {
        status: "idempotent",
        credentialPda: existing.credentialPda,
        txSignature: existing.txSignature,
        claimUri: existing.claimUri,
        nullifier,
      };
    }
    throw new KycTestIssueError(
      "replay_conflict",
      "kyc.us-test identity already bound to a different AgentCard",
      `bound_card=${existing.agentCardPubkey}`,
    );
  }

  // Step 5 — build VC, pin, submit on-chain IssueCredential.
  const slot = await deps.clock.currentSlot();

  const vc = buildKycTestVc({
    agentCardPubkey,
    issuerAuthorityPubkey: deps.issuerAuthorityPubkey,
    name_hash: sha256Hex(normalized.normName),
    dob_hash: sha256Hex(normalized.dobIso),
    nullifier,
    issuanceDate: new Date(nowUnix * 1000).toISOString(),
  });
  const claimJcs = jcsCanonicalize(vc);
  const claimHashHex = sha256Hex(claimJcs);

  const { uri: claimUri } = await deps.pinner.pin(claimJcs);

  let chainResult;
  try {
    chainResult = await deps.chain.issueCredential({
      subjectAgentCardPubkey: agentCardPubkey,
      schemaIdHex: KYC_TEST_SCHEMA_ID_HEX,
      claimUri,
      claimHashHex,
      validFromSlot: slot,
      validUntilSlot: VALID_UNTIL_NO_BOUND,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KycTestIssueError(
      "chain_failed",
      `IssueCredential tx failed: ${message}`,
    );
  }

  // Step 6 — persist dedupe row (put-if-absent for concurrent retries).
  const winner = await deps.dedupe.putIfAbsent({
    nullifier,
    agentCardPubkey,
    credentialPda: chainResult.credentialPda,
    txSignature: chainResult.txSignature,
    claimUri,
    issuedAtUnix: nowUnix,
  });

  if (winner.agentCardPubkey !== agentCardPubkey) {
    throw new KycTestIssueError(
      "replay_conflict",
      "kyc.us-test identity bound to a different AgentCard during issuance",
      `bound_card=${winner.agentCardPubkey}`,
    );
  }

  if (winner.credentialPda !== chainResult.credentialPda) {
    return {
      status: "idempotent",
      credentialPda: winner.credentialPda,
      txSignature: winner.txSignature,
      claimUri: winner.claimUri,
      nullifier,
    };
  }

  return {
    status: "issued",
    credentialPda: chainResult.credentialPda,
    txSignature: chainResult.txSignature,
    claimUri,
    claimHashHex,
    nullifier,
  };
}

// -- Form rendering ---------------------------------------------------

/**
 * Render the issuer's HTML form. Returned as a string so the bridge
 * gateway (or a Next-style router) can serve it directly without
 * pulling in a templating dep. The page:
 *
 *   - tells the user, in plain language, that this is a **mock** issuer,
 *   - posts to `actionUrl` with `{ fullName, dobIso, flowStartedAtUnix,
 *     formTokenHmacHex }`,
 *   - includes a 30-second client-side dwell (the submit button is
 *     disabled and shows a countdown until ≥ 30s have elapsed),
 *   - prefills `flowStartedAtUnix` and the matching HMAC tag.
 *
 * Server-side validation is still authoritative — the client dwell is
 * UX, the HMAC + dwell check in `issueKycTest` is the gate.
 */
export function renderKycTestFormHtml(input: {
  readonly actionUrl: string;
  readonly tokenSigner: KycTestFormTokenSigner;
  readonly nowUnix?: () => number;
  readonly minDwellSeconds?: number;
}): string {
  const flowStartedAtUnix = (input.nowUnix ?? defaultNowUnix)();
  const minDwell = input.minDwellSeconds ?? KYC_TEST_MIN_DWELL_SECONDS;

  // We sign the empty-name/dob payload at render time so the page can
  // show *some* tag; the real per-submission signing happens just
  // before POST in `prepareSubmissionFromForm`. The render-time tag
  // is over `("","",flowStartedAtUnix)` and is thrown away by the
  // client. Including `flowStartedAtUnix` and a bound-tag baseline
  // means a script blocker / no-JS submission still has the right
  // wire format.
  const baselineTag = input.tokenSigner.sign({
    fullName: "",
    dobIso: "",
    flowStartedAtUnix,
  });

  const safeAction = escapeHtml(input.actionUrl);
  const safeStart = String(flowStartedAtUnix);
  const safeTag = escapeHtml(baselineTag);
  const safeDwell = String(minDwell);

  // Single-file, self-contained HTML — no external assets. The form
  // is intentionally plain so it's auditable; we don't want anyone
  // mistaking a slick UI for real KYC.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>kyc.us-test — mock KYC issuer (DEMO ONLY)</title>
  <meta name="robots" content="noindex" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 38rem; margin: 2rem auto; padding: 0 1rem; }
    .warn { background: #fff3cd; border: 1px solid #ffeeba; padding: 0.75rem 1rem; border-radius: 4px; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
    button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; font-size: 1rem; }
    button[disabled] { opacity: 0.6; cursor: not-allowed; }
    .countdown { color: #666; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>kyc.us-test issuer</h1>
  <div class="warn">
    <strong>This is a mock issuer.</strong> It does not perform any
    real identity verification. Credentials it issues are labeled
    <code>kyc.us-test</code> so they cannot be confused with real
    KYC. Use it only for demos and integration tests.
  </div>
  <form id="kyc-test-form" method="post" action="${safeAction}">
    <label>Full name<input name="fullName" required maxlength="${String(MAX_NAME_LEN)}" /></label>
    <label>Date of birth (YYYY-MM-DD)<input name="dobIso" required pattern="\\d{4}-\\d{2}-\\d{2}" placeholder="1990-01-31" /></label>
    <input type="hidden" name="flowStartedAtUnix" value="${safeStart}" />
    <input type="hidden" name="formTokenHmacHex" value="${safeTag}" />
    <button id="submit-btn" type="submit" disabled>
      Issue kyc.us-test credential
    </button>
    <div class="countdown" id="countdown">Please wait <span id="seconds">${safeDwell}</span>s before submitting…</div>
  </form>
  <script>
    (function () {
      var minDwell = ${safeDwell};
      var startedAt = ${safeStart};
      var btn = document.getElementById('submit-btn');
      var seconds = document.getElementById('seconds');
      var cd = document.getElementById('countdown');
      function tick() {
        var remaining = Math.max(0, minDwell - (Math.floor(Date.now() / 1000) - startedAt));
        if (seconds) { seconds.textContent = String(remaining); }
        if (remaining <= 0) {
          if (btn) { btn.disabled = false; }
          if (cd) { cd.style.display = 'none'; }
          return;
        }
        setTimeout(tick, 250);
      }
      tick();
    })();
  </script>
</body>
</html>
`;
}

// -- Reference token signer ------------------------------------------

/**
 * Default HMAC-SHA256 form-token signer keyed by an in-memory secret.
 * Production should swap in a key-management-backed signer; this
 * exists so the bridge has a working default and the tests have a
 * single canonical implementation to assert against.
 */
export class HmacKycTestFormTokenSigner implements KycTestFormTokenSigner {
  public constructor(private readonly secret: Buffer) {
    if (secret.length < 16) {
      // 128 bits is the floor for HMAC-SHA256 keying; we never want
      // a demo dropping below it even though the credential is mock.
      throw new Error("HmacKycTestFormTokenSigner: secret too short");
    }
  }

  public sign(payload: {
    fullName: string;
    dobIso: string;
    flowStartedAtUnix: number;
  }): string {
    return createHmac("sha256", this.secret)
      .update(this.canonical(payload), "utf8")
      .digest("hex");
  }

  public verify(payload: {
    fullName: string;
    dobIso: string;
    flowStartedAtUnix: number;
    tag: string;
  }): boolean {
    const expected = this.sign(payload);
    if (expected.length !== payload.tag.length) return false;
    try {
      return timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(payload.tag, "hex"),
      );
    } catch {
      return false;
    }
  }

  private canonical(payload: {
    fullName: string;
    dobIso: string;
    flowStartedAtUnix: number;
  }): string {
    // Field separator is `\x1f` (US, "unit separator") so it cannot
    // collide with any character a user types into the form.
    return `${payload.fullName}\x1f${payload.dobIso}\x1f${payload.flowStartedAtUnix}`;
  }
}

// -- Default Ed25519 wallet-binding verifier (FN-057) -----------------

/**
 * Default `KycTestAgentCardSignatureVerifier` backed by Node's
 * built-in Ed25519 (Node 18+). Mirrors `ed25519SignatureVerifier`
 * in `civic.ts` so the kyc.us-test issuer enforces the same
 * wallet-binding contract.
 *
 * Resolves `false` on any cryptographic / decoding error — the
 * caller surfaces the typed `invalid_agent_card_signature` error.
 */
export const ed25519KycTestSignatureVerifier: KycTestAgentCardSignatureVerifier =
  {
    async verify({ nullifier, agentCardPubkey, signature }) {
      try {
        const nullifierBytes = hexToBytes(nullifier);
        if (nullifierBytes.length !== 32) return false;
        const cardBytes = base58Decode(agentCardPubkey);
        if (cardBytes.length !== 32) return false;
        const sigBytes = Buffer.from(signature, "base64");
        if (sigBytes.length !== 64) return false;
        const message = createHash("sha256")
          .update(nullifierBytes)
          .update(cardBytes)
          .digest();
        // RFC 8410 Ed25519 SubjectPublicKeyInfo prefix.
        const spki = Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(cardBytes),
        ]);
        const key = createPublicKey({ key: spki, format: "der", type: "spki" });
        return cryptoVerify(null, Buffer.from(message), key, sigBytes);
      } catch {
        return false;
      }
    },
  };

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex: odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Local base58 decoder (Solana alphabet) — inlined so kyc-test stays
// independently versionable (no cross-issuer import). Mirrors the
// implementation in `civic.ts`.
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i += 1) {
    m[BASE58_ALPHABET[i]!] = i;
  }
  return m;
})();

function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i += 1) {
    const c = s[i]!;
    const v = BASE58_LOOKUP[c];
    if (v === undefined) {
      throw new Error(`base58: invalid character ${JSON.stringify(c)}`);
    }
    let carry = v;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[zeros + i] = bytes[bytes.length - 1 - i]!;
  }
  return out;
}

// -- Helpers ----------------------------------------------------------

interface NormalizedSubmission {
  readonly normName: string;
  readonly dobIso: string;
}

function validateAndNormalizeSubmission(
  submission: KycTestFormSubmission,
): NormalizedSubmission {
  if (typeof submission.fullName !== "string") {
    throw new KycTestIssueError(
      "invalid_form",
      "fullName must be a string",
      "type_name",
    );
  }
  if (typeof submission.dobIso !== "string") {
    throw new KycTestIssueError(
      "invalid_form",
      "dobIso must be a string",
      "type_dob",
    );
  }
  if (typeof submission.flowStartedAtUnix !== "number") {
    throw new KycTestIssueError(
      "invalid_form",
      "flowStartedAtUnix must be a number",
      "type_started",
    );
  }
  if (
    !Number.isFinite(submission.flowStartedAtUnix) ||
    !Number.isInteger(submission.flowStartedAtUnix)
  ) {
    throw new KycTestIssueError(
      "invalid_form",
      "flowStartedAtUnix must be an integer Unix timestamp",
      "shape_started",
    );
  }
  if (typeof submission.formTokenHmacHex !== "string") {
    throw new KycTestIssueError(
      "invalid_form",
      "formTokenHmacHex must be a string",
      "type_tag",
    );
  }

  const normName = normalizeName(submission.fullName);
  if (normName.length < MIN_NAME_LEN || normName.length > MAX_NAME_LEN) {
    throw new KycTestIssueError(
      "invalid_form",
      `fullName length out of range (${MIN_NAME_LEN}..${MAX_NAME_LEN})`,
      "len_name",
    );
  }
  if (!DOB_REGEX.test(submission.dobIso)) {
    throw new KycTestIssueError(
      "invalid_form",
      "dobIso must match YYYY-MM-DD",
      "shape_dob",
    );
  }
  if (!isPlausibleGregorianDate(submission.dobIso)) {
    throw new KycTestIssueError(
      "invalid_form",
      "dobIso is not a real Gregorian date",
      "value_dob",
    );
  }

  return { normName, dobIso: submission.dobIso };
}

/**
 * Stable name normalization: NFC, lowercased, internal whitespace
 * collapsed, leading/trailing whitespace trimmed. Two sensible
 * variants of the same name (`"  Ada Lovelace "`, `"ada  lovelace"`)
 * dedupe to the same nullifier — which is exactly what we want
 * for a mock that only has name+DOB to work with.
 */
export function normalizeName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function isPlausibleGregorianDate(iso: string): boolean {
  // We already know it's `YYYY-MM-DD` shape.
  const year = Number.parseInt(iso.slice(0, 4), 10);
  const month = Number.parseInt(iso.slice(5, 7), 10);
  const day = Number.parseInt(iso.slice(8, 10), 10);
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // `Date.UTC` will silently roll over (e.g. Feb 30 → Mar 2); detect
  // by round-tripping.
  const t = Date.UTC(year, month - 1, day);
  const d = new Date(t);
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Bridge-internal nullifier. Domain-separated so a future real
 * `kyc.us` issuer cannot collide with the mock's namespace.
 */
export function deriveNullifier(normName: string, dobIso: string): string {
  return sha256Hex(`${KYC_TEST_NULLIFIER_DOMAIN}|${normName}|${dobIso}`);
}

interface VcInput {
  agentCardPubkey: string;
  issuerAuthorityPubkey: string;
  name_hash: string;
  dob_hash: string;
  nullifier: string;
  issuanceDate: string;
}

/**
 * Build the off-chain VC. The `kycLevel` field is fixed to
 * `"mock-test"` — a relying party that ignores the schema id and
 * naively reads the VC still gets a clear "this is a test" signal.
 */
export function buildKycTestVc(input: VcInput): Record<string, unknown> {
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/kyc-test/v1",
    ],
    type: ["VerifiableCredential", "KycUsTestCredential"],
    issuer: "did:eto:kyc-us-test",
    issuanceDate: input.issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.agentCardPubkey}`,
      kycLevel: "mock-test",
      kycJurisdiction: "us-test",
      name_hash: input.name_hash,
      dob_hash: input.dob_hash,
      bridgeNullifier: input.nullifier,
    },
    issuerAuthority: input.issuerAuthorityPubkey,
  };
}

/**
 * Minimal RFC 8785 (JCS) canonicalization — same shape as the Civic
 * adapter. Inlined here so the file is a single-unit-of-review per
 * the PROMPT scope; if a third issuer adopts JCS we lift this into
 * a shared module.
 */
export function jcsCanonicalize(value: unknown): string {
  return jcsStringify(value);
}

function jcsStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("jcsCanonicalize: non-finite number");
    }
    if (!Number.isInteger(value)) {
      throw new Error("jcsCanonicalize: non-integer numbers not supported");
    }
    return value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => jcsStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(jcsCompareUtf16);
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${jcsStringify(obj[k])}`,
    );
    return `{${parts.join(",")}}`;
  }
  throw new Error(`jcsCanonicalize: unsupported type ${typeof value}`);
}

function jcsCompareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function defaultNowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Conservative HTML-attribute escaper for the form renderer. We
 * never interpolate untrusted user input into the form (the only
 * dynamic values are `actionUrl` from config, the integer
 * `flowStartedAtUnix`, and a hex tag), but escape anyway so a
 * misconfigured `actionUrl` can't break out of the attribute.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
