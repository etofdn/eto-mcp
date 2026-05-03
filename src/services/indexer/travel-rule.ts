/**
 * Travel-rule report generator (T-3.13.1.4, FN-133).
 *
 * **Purpose.** Given an `AgentCard` authority, scans its `KytTrace`-derived
 * audit feed for cross-jurisdiction settlement events whose USD value
 * exceeds a configurable threshold (default $3,000) and emits a
 * deterministic FATF-style JSON-LD report listing originator (BAP) and
 * beneficiary (BPP) party records in an IVMS101-lite envelope.
 *
 * **JSON-LD shape.** The report is a `VerifiableCredential` of type
 * `["VerifiableCredential", "TravelRuleReport"]`. The `credentialSubject`
 * carries the filtered entries plus a summary of counters (total entries,
 * amounts, originated/beneficiary counts, distinct counterparties, and
 * skipped records). The `@context` array is
 * `[TRAVEL_RULE_CONTEXT_FATF, TRAVEL_RULE_CONTEXT_ETO]`.
 *
 * **FATF semantics.** Only `confirm`-stage KYT events are included (not
 * `init` or `rate`). Cross-jurisdiction is defined as originator and
 * beneficiary resolving to two different ISO-3166-1 α-2 jurisdictions via
 * the injected `PartyDirectory`. The threshold is strict `>` (so exactly
 * $3,000.00 is NOT reported; $3,000.01 is). Per spec §9.3: `parties[0]`
 * (BAP) is the originator; `parties[1]` (BPP) is the beneficiary.
 *
 * **IVMS101-lite party shape.** Party records carry `authority`
 * (base58 AgentCard pubkey), `accountNumber`, `name` (natural or legal),
 * `jurisdiction` (ISO-3166-1 α-2), optional `address` and `nationalId`.
 * These are sourced from the injected `PartyDirectory`; the report
 * generator itself has no knowledge of the underlying store.
 *
 * **Determinism guarantees.** Given identical event inputs, bounds, and
 * party/amount data, `buildReport` MUST produce a byte-identical document
 * apart from `issuanceDate` (injectable clock). Entries are sorted by
 * `(slot ascending, txSignature ascending)` — the same key as the audit
 * feed. The injectable `clock` defaults to `() => new Date()`; tests pin
 * it to a fixed timestamp for byte-stable assertions.
 *
 * **Signing.** Signing is opt-in via the injected `VcSigner`; the
 * default `NoOpVcSigner` preserves the historical unsigned shape (no
 * `proof` key in the emitted document). Set `AUDIT_SIGNING_KEY_PATH`
 * and pass `createVcSignerFromEnv({ issuerDid })` to emit an
 * `Ed25519Signature2020` proof block per W3C VC Data Integrity /
 * RFC 8785 (FN-084). The proof preimage is `sha256(JCS(vcWithoutProof))`
 * — the proof block is excluded from the hash input.
 *
 * **Spec §9.3 mapping.** `parties[0]` (BAP) is the originator; `parties[1]`
 * (BPP) is the beneficiary. When the audited authority is the BAP, we look
 * up `partyDirectory.lookup(authority)` for the originator and
 * `partyDirectory.lookup(counterparty.authority)` for the beneficiary. When
 * the audited authority is the BPP, the roles are reversed.
 */

import {
  AuditTrailIndexer,
  type AuditFeedKytEvent,
  type AuditLogger,
  type KytEventSource,
} from "./audit-trail.js";
import {
  NoOpVcSigner,
  type Ed25519Signature2020Proof,
  type VcSigner,
} from "./vc-signer.js";
import {
  type AmountResolverEntry,
  type Ivms101Party,
  type JurisdictionCode,
  amountResolverEntrySchema,
  ivms101PartySchema,
} from "./travel-rule.types.js";
export type {
  AmountResolverEntry,
  Ivms101GeographicAddress,
  Ivms101LegalName,
  Ivms101NationalIdentification,
  Ivms101NaturalName,
  Ivms101Party,
  Ivms101PartyName,
  JurisdictionCode,
} from "./travel-rule.types.js";
export {
  amountResolverEntrySchema,
  ivms101GeographicAddressSchema,
  ivms101LegalNameSchema,
  ivms101NationalIdentificationSchema,
  ivms101NaturalNameSchema,
  ivms101PartyNameSchema,
  ivms101PartySchema,
  jurisdictionCodeSchema,
  partyDirectoryEntrySchema,
} from "./travel-rule.types.js";

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

/** Default USD threshold: only events with amountUsd > 3000 are included. */
export const TRAVEL_RULE_DEFAULT_THRESHOLD_USD = 3000;

/** FATF travel-rule JSON-LD context URI. */
export const TRAVEL_RULE_CONTEXT_FATF =
  "https://www.fatf-gafi.org/travel-rule/v1";

/** ETO-specific extension context URI. */
export const TRAVEL_RULE_CONTEXT_ETO =
  "https://schema.eto.network/travel-rule/v1";

/** VC type tuple for travel-rule reports. */
export const TRAVEL_RULE_REPORT_TYPE = [
  "VerifiableCredential",
  "TravelRuleReport",
] as const;

/**
 * Placeholder issuer DID. The report is UNSIGNED in v0. Signing
 * (VC-JOSE / Ed25519) is a follow-up task.
 */
export const TRAVEL_RULE_ISSUER_DID = "did:eto:indexer:travel-rule:v0";

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export type TravelRuleErrorCode =
  | "INVALID_AUTHORITY"
  | "INVALID_BOUNDS"
  | "INVALID_THRESHOLD"
  | "INVALID_PARTY"
  | "INVALID_AMOUNT";

/** Error thrown by the travel-rule report generator on invalid inputs. */
export class TravelRuleError extends Error {
  public override readonly name = "TravelRuleError";
  public readonly code: TravelRuleErrorCode;
  public readonly detail?: unknown;

  public constructor(
    code: TravelRuleErrorCode,
    message: string,
    detail?: unknown,
  ) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------
// PartyDirectory abstraction
// ---------------------------------------------------------------------

export interface PartyDirectoryLookupOpts {
  /** Optional slot hint — production wiring may use this for point-in-time lookups. */
  atSlot?: number;
}

/**
 * Pluggable source of IVMS101-lite party records, keyed by base58
 * AgentCard authority. The production implementation will be backed by
 * the issuer registry; v0 ships only the in-memory reference impl.
 */
export interface PartyDirectory {
  lookup(
    authority: string,
    opts?: PartyDirectoryLookupOpts,
  ): Promise<Ivms101Party | undefined>;
}

// ---------------------------------------------------------------------
// InMemoryPartyDirectory
// ---------------------------------------------------------------------

/**
 * Reference `PartyDirectory` backed by an in-memory map.
 * Validates every entry through `ivms101PartySchema` at construction
 * time; throws `TravelRuleError("INVALID_PARTY", ...)` on failure.
 */
export class InMemoryPartyDirectory implements PartyDirectory {
  private readonly store: ReadonlyMap<string, Ivms101Party>;

  public constructor(entries: Record<string, Ivms101Party> | Map<string, Ivms101Party>) {
    const map = new Map<string, Ivms101Party>();
    const source = entries instanceof Map ? entries.entries() : Object.entries(entries);
    for (const [authority, party] of source) {
      const parsed = ivms101PartySchema.safeParse(party);
      if (!parsed.success) {
        throw new TravelRuleError(
          "INVALID_PARTY",
          `invalid Ivms101Party for authority ${authority}: ${parsed.error.message}`,
          parsed.error.issues,
        );
      }
      map.set(authority, parsed.data);
    }
    this.store = map;
  }

  public async lookup(
    authority: string,
    _opts?: PartyDirectoryLookupOpts,
  ): Promise<Ivms101Party | undefined> {
    return this.store.get(authority);
  }
}

// ---------------------------------------------------------------------
// AmountResolver abstraction
// ---------------------------------------------------------------------

/**
 * Pluggable resolver for USD-equivalent amounts associated with a
 * transaction. In production this will be backed by `EtoRpcClient`
 * decoded transaction lookups plus the asset issuer's published peg.
 */
export interface AmountResolver {
  lookup(
    txSignature: string,
  ): Promise<{ amountUsd: number; currency: string } | undefined>;
}

// ---------------------------------------------------------------------
// InMemoryAmountResolver
// ---------------------------------------------------------------------

/**
 * Reference `AmountResolver` backed by an in-memory map, keyed by
 * transaction signature. Validates every entry at construction time;
 * throws `TravelRuleError("INVALID_AMOUNT", ...)` on failure.
 */
export class InMemoryAmountResolver implements AmountResolver {
  private readonly store: ReadonlyMap<string, AmountResolverEntry>;

  public constructor(
    entries:
      | Record<string, { amountUsd: number; currency: string }>
      | Map<string, { amountUsd: number; currency: string }>,
  ) {
    const map = new Map<string, AmountResolverEntry>();
    const source = entries instanceof Map ? entries.entries() : Object.entries(entries);
    for (const [txSig, entry] of source) {
      const parsed = amountResolverEntrySchema.safeParse(entry);
      if (!parsed.success) {
        throw new TravelRuleError(
          "INVALID_AMOUNT",
          `invalid amount entry for txSignature ${txSig}: ${parsed.error.message}`,
          parsed.error.issues,
        );
      }
      map.set(txSig, parsed.data);
    }
    this.store = map;
  }

  public async lookup(
    txSignature: string,
  ): Promise<{ amountUsd: number; currency: string } | undefined> {
    return this.store.get(txSignature);
  }
}

// ---------------------------------------------------------------------
// Cross-jurisdiction & threshold filters
// ---------------------------------------------------------------------

/**
 * Returns `true` iff the originator and beneficiary resolve to two
 * distinct ISO-3166-1 α-2 jurisdictions.
 */
export function isCrossJurisdiction(
  originator: Ivms101Party,
  beneficiary: Ivms101Party,
): boolean {
  return originator.jurisdiction !== beneficiary.jurisdiction;
}

/**
 * Returns `true` iff `amountUsd` strictly exceeds `threshold`.
 * Setting `threshold = 0` admits every transaction.
 * Per FATF convention the comparison is strict `>` (exactly $3,000.00
 * is NOT included; $3,000.01 is).
 */
export function meetsThreshold(amountUsd: number, threshold: number): boolean {
  return amountUsd > threshold;
}

export interface ShouldReportResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Structural filter that decides whether a single `AuditFeedKytEvent`
 * should be included in the travel-rule report.
 *
 * An event is eligible iff:
 *   1. `stage === "confirm"` (settlement stage only),
 *   2. the parties resolve to different jurisdictions (cross-border),
 *   3. `amountUsd > threshold` (strict `>`).
 *
 * The returned `reasons` array documents why the event was included,
 * enabling test assertions and future audit trails.
 */
export function shouldReport(
  event: AuditFeedKytEvent,
  originator: Ivms101Party,
  beneficiary: Ivms101Party,
  amountUsd: number,
  threshold: number,
): ShouldReportResult {
  const reasons: string[] = [];

  if (event.stage !== "confirm") {
    return { eligible: false, reasons };
  }
  reasons.push("stage:confirm");

  const crossJurisdiction = isCrossJurisdiction(originator, beneficiary);
  if (!crossJurisdiction) {
    return { eligible: false, reasons };
  }
  reasons.push(
    `cross-jurisdiction:${originator.jurisdiction}->${beneficiary.jurisdiction}`,
  );

  const thresholdMet = meetsThreshold(amountUsd, threshold);
  if (!thresholdMet) {
    return { eligible: false, reasons };
  }
  reasons.push(`amount:${amountUsd}>${threshold}`);

  return { eligible: true, reasons };
}

// ---------------------------------------------------------------------
// Report JSON-LD types
// ---------------------------------------------------------------------

export interface TravelRuleEntry {
  txSignature: string;
  slot: number;
  /** ISO-8601 UTC timestamp derived from the KYT event's on-chain timestamp. */
  timestamp: string;
  amountUsd: number;
  currency: string;
  originator: Ivms101Party;
  beneficiary: Ivms101Party;
  /** Human-readable reasons explaining why this entry was included. */
  readonly reasons: readonly string[];
  /** On-chain credential pointer sets for each party. */
  kytPointers: {
    originator: readonly string[];
    beneficiary: readonly string[];
  };
}

export interface TravelRuleReportJsonLd {
  "@context": readonly [
    typeof TRAVEL_RULE_CONTEXT_FATF,
    typeof TRAVEL_RULE_CONTEXT_ETO,
  ];
  id: string;
  type: typeof TRAVEL_RULE_REPORT_TYPE;
  // FN-084: widened from the literal `typeof TRAVEL_RULE_ISSUER_DID` to
  // `string` so an injected `VcSigner` can override the placeholder DID.
  issuer: string;
  issuanceDate: string;
  /** FN-084: optional Ed25519Signature2020 proof block. Absent when the
   *  default `NoOpVcSigner` is in use (preserves byte-stable v0 shape). */
  proof?: Ed25519Signature2020Proof;
  credentialSubject: {
    id: string;
    authority: string;
    thresholdUsd: number;
    bounds: {
      sinceSlot: number | "earliest";
      untilSlot: number | "latest";
    };
    entries: readonly TravelRuleEntry[];
    summary: {
      totalEntries: number;
      totalAmountUsd: number;
      originatedCount: number;
      beneficiaryCount: number;
      distinctCounterparties: number;
      skippedMissingParty: number;
      skippedMissingAmount: number;
    };
  };
}

// ---------------------------------------------------------------------
// Local validation helpers (mirroring audit-trail.ts — NOT exported)
// ---------------------------------------------------------------------

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function assertAuthority(authority: string): void {
  if (!authority || !BASE58_RE.test(authority)) {
    throw new TravelRuleError(
      "INVALID_AUTHORITY",
      "authority must be a non-empty base58 string",
      { authority },
    );
  }
}

export interface BuildReportOpts {
  sinceSlot?: number;
  untilSlot?: number;
  thresholdUsd?: number;
  issuerAllowlist?: readonly string[];
}

function assertBounds(opts?: BuildReportOpts): void {
  if (opts?.sinceSlot !== undefined) {
    if (
      !Number.isInteger(opts.sinceSlot) ||
      opts.sinceSlot < 0 ||
      !Number.isSafeInteger(opts.sinceSlot)
    ) {
      throw new TravelRuleError(
        "INVALID_BOUNDS",
        "sinceSlot must be a non-negative safe integer",
      );
    }
  }
  if (opts?.untilSlot !== undefined) {
    if (
      !Number.isInteger(opts.untilSlot) ||
      opts.untilSlot < 0 ||
      !Number.isSafeInteger(opts.untilSlot)
    ) {
      throw new TravelRuleError(
        "INVALID_BOUNDS",
        "untilSlot must be a non-negative safe integer",
      );
    }
  }
  if (
    opts?.sinceSlot !== undefined &&
    opts?.untilSlot !== undefined &&
    opts.sinceSlot > opts.untilSlot
  ) {
    throw new TravelRuleError(
      "INVALID_BOUNDS",
      "sinceSlot must be <= untilSlot",
    );
  }
}

function assertThreshold(thresholdUsd: number | undefined): void {
  if (thresholdUsd === undefined) return;
  if (!Number.isFinite(thresholdUsd) || thresholdUsd < 0) {
    throw new TravelRuleError(
      "INVALID_THRESHOLD",
      "thresholdUsd must be a finite non-negative number",
      { thresholdUsd },
    );
  }
}

function reportUrn(
  authority: string,
  sinceSlot: number | undefined,
  untilSlot: number | undefined,
): string {
  const lo = sinceSlot ?? 0;
  const hi = untilSlot === undefined ? "latest" : String(untilSlot);
  return `urn:eto:travel-rule:${authority}:${lo}:${hi}`;
}

/**
 * Round a USD amount to 2 decimal places to avoid floating-point drift
 * in the `totalAmountUsd` summary field. Rule: `Math.round(x * 100) / 100`.
 */
function roundUsd(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------
// TravelRuleReportGenerator
// ---------------------------------------------------------------------

export interface TravelRuleReportGeneratorDeps {
  /** KytEventSource or AuditTrailIndexer — if a KytEventSource is provided,
   *  it is wrapped in a fresh AuditTrailIndexer internally. */
  source: KytEventSource | AuditTrailIndexer;
  partyDirectory: PartyDirectory;
  amountResolver: AmountResolver;
  logger?: AuditLogger;
  /** Defaults to `() => new Date()`. Tests inject a fixed clock. */
  clock?: () => Date;
  /**
   * FN-084: optional VC signer. Defaults to
   * `NoOpVcSigner(TRAVEL_RULE_ISSUER_DID)` which produces a byte-stable
   * unsigned document (no `proof` key).
   */
  signer?: VcSigner;
}

/**
 * Generates deterministic FATF-style travel-rule reports for a given
 * `AgentCard` authority by consuming FN-130's audit feed and resolving
 * originator/beneficiary party records and USD amounts from injected
 * abstractions.
 */
export class TravelRuleReportGenerator {
  private readonly indexer: AuditTrailIndexer;
  private readonly partyDirectory: PartyDirectory;
  private readonly amountResolver: AmountResolver;
  private readonly logger?: AuditLogger;
  private readonly clock: () => Date;
  private readonly signer: VcSigner;

  public constructor(deps: TravelRuleReportGeneratorDeps) {
    // If source is already an AuditTrailIndexer, reuse it; otherwise wrap.
    this.indexer =
      deps.source instanceof AuditTrailIndexer
        ? deps.source
        : new AuditTrailIndexer({
            source: deps.source,
            logger: deps.logger,
            clock: deps.clock,
          });
    this.partyDirectory = deps.partyDirectory;
    this.amountResolver = deps.amountResolver;
    if (deps.logger) this.logger = deps.logger;
    this.clock = deps.clock ?? (() => new Date());
    this.signer = deps.signer ?? new NoOpVcSigner(TRAVEL_RULE_ISSUER_DID);
  }

  public async buildReport(
    authority: string,
    opts?: BuildReportOpts,
  ): Promise<TravelRuleReportJsonLd> {
    assertAuthority(authority);
    assertBounds(opts);
    const threshold = opts?.thresholdUsd ?? TRAVEL_RULE_DEFAULT_THRESHOLD_USD;
    assertThreshold(threshold);

    const sinceSlot = opts?.sinceSlot;
    const untilSlot = opts?.untilSlot;

    // Build the audit feed via AuditTrailIndexer to inherit determinism.
    const feed = await this.indexer.buildAuditFeed(authority, {
      sinceSlot,
      untilSlot,
      issuerAllowlist: opts?.issuerAllowlist ? [...opts.issuerAllowlist] : undefined,
    });

    // Filter to KYT events only (revocation events are not relevant here).
    const kytEvents = feed.credentialSubject.events.filter(
      (e): e is AuditFeedKytEvent => e.kind === "kyt",
    );

    const entries: TravelRuleEntry[] = [];
    let skippedMissingParty = 0;
    let skippedMissingAmount = 0;
    let originatedCount = 0;
    let beneficiaryCount = 0;
    const counterpartySet = new Set<string>();

    for (const event of kytEvents) {
      // Only process confirm-stage events (settlement, not catalog browse / rating).
      if (event.stage !== "confirm") continue;

      // Determine originator/beneficiary based on which side the audited
      // authority occupies. Per spec §9.3:
      //   parties[0] (BAP) = originator
      //   parties[1] (BPP) = beneficiary
      //
      // AuditFeedKytEvent.counterparty.party is the role of the OTHER party.
      // So if counterparty.party === "bpp", the audited authority IS the BAP
      // (originator); if counterparty.party === "bap", it IS the BPP (beneficiary).
      const auditedIsBap = event.counterparty.party === "bpp";

      const originatorAuthority = auditedIsBap ? authority : event.counterparty.authority;
      const beneficiaryAuthority = auditedIsBap ? event.counterparty.authority : authority;

      // Resolve originator party record.
      const originator = await this.partyDirectory.lookup(originatorAuthority, {
        atSlot: event.slot,
      });
      if (originator === undefined) {
        this.logger?.warn?.(
          "travel-rule: skipping event — originator party not found",
          { txSignature: event.txSignature, authority: originatorAuthority },
        );
        skippedMissingParty += 1;
        continue;
      }

      // Resolve beneficiary party record.
      const beneficiary = await this.partyDirectory.lookup(beneficiaryAuthority, {
        atSlot: event.slot,
      });
      if (beneficiary === undefined) {
        this.logger?.warn?.(
          "travel-rule: skipping event — beneficiary party not found",
          { txSignature: event.txSignature, authority: beneficiaryAuthority },
        );
        skippedMissingParty += 1;
        continue;
      }

      // Resolve USD amount for this transaction.
      const amountEntry = await this.amountResolver.lookup(event.txSignature);
      if (amountEntry === undefined) {
        this.logger?.warn?.(
          "travel-rule: skipping event — amount not found",
          { txSignature: event.txSignature },
        );
        skippedMissingAmount += 1;
        continue;
      }

      // Apply cross-jurisdiction + threshold filters.
      const result = shouldReport(
        event,
        originator,
        beneficiary,
        amountEntry.amountUsd,
        threshold,
      );

      if (!result.eligible) continue;

      // Determine the cred pointer ordering: originator's then beneficiary's.
      const originatorPointers = auditedIsBap
        ? event.selfCredPointers
        : event.counterparty.credPointers;
      const beneficiaryPointers = auditedIsBap
        ? event.counterparty.credPointers
        : event.selfCredPointers;

      entries.push({
        txSignature: event.txSignature,
        slot: event.slot,
        timestamp: event.timestamp,
        amountUsd: amountEntry.amountUsd,
        currency: amountEntry.currency,
        originator,
        beneficiary,
        reasons: result.reasons,
        kytPointers: {
          originator: originatorPointers,
          beneficiary: beneficiaryPointers,
        },
      });

      // Update summary counters.
      if (auditedIsBap) {
        originatedCount += 1;
        counterpartySet.add(beneficiaryAuthority);
      } else {
        beneficiaryCount += 1;
        counterpartySet.add(originatorAuthority);
      }
    }

    // Deterministic sort: slot ascending, txSignature ascending.
    entries.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot - b.slot;
      if (a.txSignature < b.txSignature) return -1;
      if (a.txSignature > b.txSignature) return 1;
      return 0;
    });

    const totalAmountUsd = roundUsd(
      entries.reduce((sum, e) => sum + e.amountUsd, 0),
    );

    const issuerDid =
      this.signer.issuerDid !== TRAVEL_RULE_ISSUER_DID
        ? this.signer.issuerDid
        : TRAVEL_RULE_ISSUER_DID;

    const report: TravelRuleReportJsonLd = {
      "@context": [TRAVEL_RULE_CONTEXT_FATF, TRAVEL_RULE_CONTEXT_ETO],
      id: reportUrn(authority, sinceSlot, untilSlot),
      type: TRAVEL_RULE_REPORT_TYPE,
      issuer: issuerDid,
      issuanceDate: this.clock().toISOString(),
      credentialSubject: {
        id: `did:eto:agent:${authority}`,
        authority,
        thresholdUsd: threshold,
        bounds: {
          sinceSlot: sinceSlot ?? "earliest",
          untilSlot: untilSlot ?? "latest",
        },
        entries,
        summary: {
          totalEntries: entries.length,
          totalAmountUsd,
          originatedCount,
          beneficiaryCount,
          distinctCounterparties: counterpartySet.size,
          skippedMissingParty,
          skippedMissingAmount,
        },
      },
    };

    // FN-084: sign the proof-less document and attach proof iff non-empty.
    // Pass a shallow copy so the signer never observes the `proof` key
    // (W3C VC Data Integrity §11.4 excludes proof from the JCS preimage).
    const proof = await this.signer.sign({ ...report });
    if (proof.proofValue !== "") {
      report.proof = proof;
    }

    this.logger?.info?.("travel-rule: built report", {
      authority,
      entries: entries.length,
      skippedMissingParty,
      skippedMissingAmount,
      signed: proof.proofValue !== "",
    });

    return report;
  }
}

// ---------------------------------------------------------------------
// Free-function wrapper
// ---------------------------------------------------------------------

/**
 * Free-function wrapper around `TravelRuleReportGenerator.buildReport`
 * for callers that don't need a long-lived generator instance.
 */
export async function buildTravelRuleReport(
  deps: TravelRuleReportGeneratorDeps,
  authority: string,
  opts?: BuildReportOpts,
): Promise<TravelRuleReportJsonLd> {
  return new TravelRuleReportGenerator(deps).buildReport(authority, opts);
}
