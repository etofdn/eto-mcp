/**
 * 1099 issuance flow — v0 sketch (T-3.13.1.3, FN-132).
 *
 * Manual-trigger entry point: `runTax1099Sketch(deps, request)`.
 *
 * Given a `(agentCardAuthority, taxYear, jurisdiction)` triple, the
 * function:
 *   1. Computes the Solana slot window covering `taxYear` (see
 *      `DEFAULT_SLOTS_PER_YEAR` / `defaultFirstSlotOfYear` — v0
 *      deterministic stubs; real chain↔wallclock oracle is a follow-up).
 *   2. Calls `AuditTrailIndexer.buildAuditFeed` to aggregate the year's
 *      on-chain events.
 *   3. Reduces the feed into `Tax1099Totals` via `reduceAuditFeedToTotals`.
 *      **v0 caveat:** monetary fields (`totalIncome`, etc.) are always
 *      `"0.00"` until FN-117 / FN-118 wire ledger amounts into the KYT
 *      event stream.
 *   4. Builds a `Tax1099VcEnvelope` (JSON-LD per FN-131 spec) via
 *      `buildTax1099Vc`.
 *   5. JCS-canonicalises the envelope (sans `proof`) — reusing
 *      `jcsCanonicalize` from `bank-mock` — and computes `claim_hash`.
 *   6. Pins the JCS bytes via the injected `VcPinner`.
 *   7. Submits an `IssueCredential` instruction via the injected
 *      `IssueCredentialClient` under the per-year schema id
 *      `sha256("eto.beckn.schema.tax.1099.<jurisdiction>.<year>.v1")`.
 *
 * **Unsigned v0:** the VC's `proof.proofValue` is the placeholder string
 * `"<unsigned-v0>"`. Real Ed25519 signing is a follow-up task.
 *
 * **No idempotency store:** v0 does not dedupe `(authority, jurisdiction,
 * taxYear)` pairs; every call issues a fresh credential. A dedupe /
 * idempotency store is a follow-up task.
 *
 * Schema-id rule:
 *   `sha256("eto.beckn.schema.tax.1099.<jurisdiction-lower>.<year>.v1")`
 *   where `jurisdiction-lower` is the ISO-3166-1 α-2 code forced to
 *   lowercase (e.g. `"us"`, `"gb"`).
 */

import { createHash } from "node:crypto";

import { jcsCanonicalize } from "../../../../src/issuers/bank-mock.js";
import type {
  AuditFeedJsonLd,
} from "../../../../src/services/indexer/audit-trail.js";

import type {
  Tax1099SketchDeps,
  Tax1099SketchRequest,
  Tax1099SketchResponse,
  Tax1099Totals,
  Tax1099VcEnvelope,
} from "./tax-1099-sketch.types.js";
export { Tax1099SketchError } from "./tax-1099-sketch.types.js";
export type {
  Tax1099SketchDeps,
  Tax1099SketchRequest,
  Tax1099SketchResponse,
  Tax1099SketchErrorKind,
  Tax1099Totals,
  Tax1099VcEnvelope,
  IssueCredentialClient,
  VcPinner,
  SlotClock,
} from "./tax-1099-sketch.types.js";

import { Tax1099SketchError } from "./tax-1099-sketch.types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Encode `bytes` in Bitcoin-alphabet base58 (no checksum).
 * Used for the `digestRootBase58` field only — no new runtime dependency.
 */
function base58Encode(bytes: Buffer): string {
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + bytes.toString("hex") || "0");
  const digits: number[] = [];
  const base = BigInt(58);
  while (num > 0n) {
    const rem = Number(num % base);
    digits.push(rem);
    num = num / base;
  }
  // Leading zero bytes → '1'
  let leadingOnes = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    leadingOnes += "1";
  }
  return leadingOnes + digits.reverse().map((d) => ALPHABET[d]).join("");
}

// ---------------------------------------------------------------------------
// Schema id
// ---------------------------------------------------------------------------

/**
 * Returns the 64-char lowercase hex of
 * `sha256("eto.beckn.schema.tax.1099.<jurisdiction-lower>.<year>.v1")`.
 *
 * Exported so FN-134 (test) and FN-164 (dashboard) can reproduce the
 * expected schema id without re-implementing the derivation rule.
 */
export function tax1099SchemaIdHex(
  jurisdiction: string,
  taxYear: number,
): string {
  const slug = `eto.beckn.schema.tax.1099.${jurisdiction.toLowerCase()}.${taxYear}.v1`;
  return sha256Hex(slug);
}

// ---------------------------------------------------------------------------
// Slot window
// ---------------------------------------------------------------------------

/**
 * Default slots-per-year constant.
 *
 * Derived as: 365.25 days × 24 h × 60 min × 60 s × (1000 ms / 400 ms per
 * slot) = 78_840_000 slots.
 *
 * **Placeholder:** this is a deterministic stub. A real chain↔wallclock
 * oracle (mapping Unix timestamps to Solana slot heights) should replace
 * this before mainnet. File a follow-up task for the oracle work.
 */
export const DEFAULT_SLOTS_PER_YEAR: bigint = 78_840_000n;

/**
 * Returns the first slot of `year` using the v0 deterministic stub:
 * `BigInt(year - 2024) * DEFAULT_SLOTS_PER_YEAR`.
 *
 * Slot 0 is the genesis slot; year 2024 maps to slot 0.
 *
 * **Placeholder:** replace with a real oracle before mainnet.
 */
export function defaultFirstSlotOfYear(year: number): bigint {
  return BigInt(year - 2024) * DEFAULT_SLOTS_PER_YEAR;
}

// ---------------------------------------------------------------------------
// Totals reducer
// ---------------------------------------------------------------------------

/**
 * Reduce an `AuditFeedJsonLd` into per-year `Tax1099Totals`.
 *
 * **v0 sketch:** monetary fields (`totalIncome`, `totalFees`,
 * `totalInterestPaid`, `totalWithholding`) are always `"0.00"` because the
 * KYT event stream does not yet carry ledger amounts. FN-117 / FN-118 (eUSD
 * ledger) are the unblockers for real aggregation.
 *
 * `transactionCount` counts all KYT events (init + confirm + rate) from
 * `feed.credentialSubject.summary.kytCount`.
 *
 * `digestRootBase58` is the base58 encoding of
 * `sha256(JSON.stringify(feed.credentialSubject.events))` — deterministic
 * over the indexer's already-sorted events.
 *
 * Throws `Tax1099SketchError({ kind: "no_activity" })` when both
 * `kytCount === 0` and `revocationCount === 0`.
 */
export function reduceAuditFeedToTotals(
  feed: AuditFeedJsonLd,
  _opts: { currency: string },
): Tax1099Totals {
  const { kytCount, revocationCount } = feed.credentialSubject.summary;

  if (kytCount === 0 && revocationCount === 0) {
    throw new Tax1099SketchError({
      kind: "no_activity",
      message: "audit feed is empty for the requested period",
    });
  }

  // TODO(FN-117, FN-118): replace "0.00" with real ledger-amount sums
  // once the eUSD ledger wires amounts into the KYT event stream.
  const ZERO = "0.00";

  const digestRootBytes = createHash("sha256")
    .update(JSON.stringify(feed.credentialSubject.events), "utf8")
    .digest();

  return {
    totalIncome: ZERO,
    totalFees: ZERO,
    totalInterestPaid: ZERO,
    totalWithholding: ZERO,
    transactionCount: kytCount,
    digestRootBase58: base58Encode(digestRootBytes),
  };
}

// ---------------------------------------------------------------------------
// VC builder
// ---------------------------------------------------------------------------

interface BuildVcInput {
  readonly agentCardAuthority: string;
  readonly taxYear: number;
  readonly jurisdiction: string;
  readonly currency: string;
  readonly formVariant: string;
  readonly totals: Tax1099Totals;
  readonly issuerAuthorityPubkey: string;
  readonly networkPubkey: string;
  readonly nowUnix: number;
}

/**
 * Build the off-chain `Tax1099VcEnvelope` JSON-LD document conforming to
 * `spec/banking/credentials/tax-1099.json`.
 *
 * Field order exactly matches the spec template. Monetary fields are
 * decimal strings (`/^\d+\.\d{2}$/`) as mandated by FN-131.
 *
 * The `proof.proofValue` is the placeholder literal `"<unsigned-v0>"`.
 * Real Ed25519 signing (via `Ed25519Signature2020`) is a follow-up task.
 *
 * The VC is always emitted WITHOUT the `proof` block so that
 * `jcsCanonicalize(vc)` produces the canonical bytes for `claim_hash`.
 * The returned object includes the `proof` key for completeness; callers
 * must strip it before hashing — see `runTax1099Sketch`.
 */
export function buildTax1099Vc(input: BuildVcInput): Tax1099VcEnvelope {
  const issuanceDate = new Date(input.nowUnix * 1000).toISOString();
  const year = input.taxYear;
  const periodStart = `${year}-01-01T00:00:00Z`;
  const periodEnd = `${year}-12-31T23:59:59Z`;

  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/banking/tax-1099/v1",
    ],
    type: ["VerifiableCredential", "Tax1099Credential"],
    issuer: "did:eto:bank:eto-reference",
    issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.agentCardAuthority}`,
      type: "Tax1099Statement",
      taxYear: year,
      jurisdiction: input.jurisdiction,
      currency: input.currency,
      formVariant: input.formVariant,
      totalIncome: input.totals.totalIncome,
      totalFees: input.totals.totalFees,
      totalInterestPaid: input.totals.totalInterestPaid,
      totalWithholding: input.totals.totalWithholding,
      transactionCount: input.totals.transactionCount,
      periodStart,
      periodEnd,
    },
    evidence: [
      {
        type: "EtoChainEventDigest",
        network: input.networkPubkey,
        digestRoot: input.totals.digestRootBase58,
        digestAlgorithm: "sha256",
      },
    ],
    issuerAuthority: input.issuerAuthorityPubkey,
    proof: {
      type: "Ed25519Signature2020",
      verificationMethod: "did:eto:bank:eto-reference#issuer-authority",
      // v0 unsigned placeholder — real Ed25519 signing is a follow-up task.
      proofValue: "<unsigned-v0>",
    },
  };
}

// ---------------------------------------------------------------------------
// Manual-trigger entry point
// ---------------------------------------------------------------------------

const JURISDICTION_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ALLOWED_FORM_VARIANTS = new Set([
  "1099-INT",
  "1099-MISC",
  "1099-NEC",
  "1099-K",
]);

function defaultNowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Manually trigger a 1099 issuance for one `(agentCardAuthority, taxYear,
 * jurisdiction)` period.
 *
 * **No idempotency store in v0.** Every call issues a fresh `IssueCredential`
 * tx. TODO(FN-132 follow-up): add dedupe by `(authority, jurisdiction, taxYear)`
 * mirroring `BankMockStore`.
 *
 * `validUntilSlot: 0n` means "no upper bound" per L1 §5.1; explicit
 * revocation is used to invalidate a credential.
 */
export async function runTax1099Sketch(
  deps: Tax1099SketchDeps,
  request: Tax1099SketchRequest,
): Promise<Tax1099SketchResponse> {
  // --- Input validation -------------------------------------------------------

  const { agentCardAuthority, taxYear, issuerAuthorityPubkey, networkPubkey } =
    request;
  const currency = request.currency ?? "USD";
  const formVariant = request.formVariant ?? "1099-MISC";
  const jurisdiction = request.jurisdiction;

  if (!agentCardAuthority) {
    throw new Tax1099SketchError({
      kind: "invalid_request",
      message: "agentCardAuthority is empty",
      reason: "empty_authority",
    });
  }
  if (!Number.isInteger(taxYear) || taxYear < 2024) {
    throw new Tax1099SketchError({
      kind: "invalid_request",
      message: `taxYear must be an integer >= 2024, got: ${taxYear}`,
      reason: "invalid_tax_year",
    });
  }
  if (!JURISDICTION_RE.test(jurisdiction)) {
    throw new Tax1099SketchError({
      kind: "invalid_request",
      message: `jurisdiction must match /^[A-Z]{2}$/, got: "${jurisdiction}"`,
      reason: "invalid_jurisdiction",
    });
  }
  if (!CURRENCY_RE.test(currency)) {
    throw new Tax1099SketchError({
      kind: "invalid_request",
      message: `currency must match /^[A-Z]{3}$/, got: "${currency}"`,
      reason: "invalid_currency",
    });
  }
  if (!ALLOWED_FORM_VARIANTS.has(formVariant)) {
    throw new Tax1099SketchError({
      kind: "invalid_request",
      message: `formVariant must be one of ${[...ALLOWED_FORM_VARIANTS].join(", ")}, got: "${formVariant}"`,
      reason: "invalid_form_variant",
    });
  }

  // --- Slot window ------------------------------------------------------------

  const firstSlotOfYear =
    deps.firstSlotOfYear ?? defaultFirstSlotOfYear;
  const slotsPerYear = deps.slotsPerYear ?? DEFAULT_SLOTS_PER_YEAR;

  const sinceSlotBig = firstSlotOfYear(taxYear);
  const untilSlotBig = sinceSlotBig + slotsPerYear;
  const sinceSlot = Number(sinceSlotBig);
  const untilSlot = Number(untilSlotBig);

  // --- Audit feed -------------------------------------------------------------

  let feed: AuditFeedJsonLd;
  try {
    feed = await deps.indexer.buildAuditFeed(agentCardAuthority, {
      sinceSlot,
      untilSlot,
      issuerAllowlist: [issuerAuthorityPubkey],
    });
  } catch (err) {
    throw new Tax1099SketchError({
      kind: "indexer_failed",
      message: `AuditTrailIndexer threw: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }

  // --- Totals -----------------------------------------------------------------

  // May throw Tax1099SketchError({ kind: "no_activity" })
  const totals = reduceAuditFeedToTotals(feed, { currency });

  // --- Build VC ---------------------------------------------------------------

  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  const vc = buildTax1099Vc({
    agentCardAuthority,
    taxYear,
    jurisdiction,
    currency,
    formVariant,
    totals,
    issuerAuthorityPubkey,
    networkPubkey,
    nowUnix,
  });

  // Compute claim_hash over the VC WITHOUT the proof block.
  const vcWithoutProof: Record<string, unknown> = Object.fromEntries(
    Object.entries(vc as Record<string, unknown>).filter(
      ([k]) => k !== "proof",
    ),
  );
  const claimJcs = jcsCanonicalize(vcWithoutProof);
  const claimHashHex = sha256Hex(claimJcs);

  // --- Pin VC -----------------------------------------------------------------

  let claimUri: string;
  try {
    const pinResult = await deps.pinner.pin(claimJcs);
    claimUri = pinResult.uri;
  } catch (err) {
    throw new Tax1099SketchError({
      kind: "pin_failed",
      message: `VcPinner threw: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }

  // --- IssueCredential --------------------------------------------------------

  const schemaIdHex = tax1099SchemaIdHex(jurisdiction, taxYear);

  let chainResult: { credentialPda: string; txSignature: string };
  try {
    chainResult = await deps.chain.issueCredential({
      subjectAgentCardPubkey: agentCardAuthority,
      schemaIdHex,
      claimUri,
      claimHashHex,
      validFromSlot: untilSlotBig,
      // validUntilSlot: 0n = "no upper bound" per L1 §5.1. Explicit
      // revocation is used to invalidate the credential.
      validUntilSlot: 0n,
    });
  } catch (err) {
    throw new Tax1099SketchError({
      kind: "chain_failed",
      message: `IssueCredential tx failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }

  return {
    status: "issued",
    credentialPda: chainResult.credentialPda,
    txSignature: chainResult.txSignature,
    claimUri,
    claimHashHex,
    schemaIdHex,
    vc,
    totals,
  };
}
