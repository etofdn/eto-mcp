// Audit-trail event indexer (T-3.13.1.1, FN-130).
//
// Off-chain service that, given an `AgentCard` authority, reads the
// chain's `KytTrace` and `RevocationRootUpdated` events for that card
// and emits a deterministic JSON-LD audit feed (a
// `VerifiableCredential`-shaped log of gated Beckn flows: `init` /
// `confirm` / `rate`, plus revocation root updates that cover the
// card's credentials).
//
// **Upstream sources.** v0 ingests events from an injectable
// `KytEventSource`. The production source will subscribe to
// `singularity:kyt:*` log lines via Solana JSON-RPC `logsSubscribe`
// (and to `singularity:revocation:root_updated` for revocation history)
// and parse them into the `KytTraceEvent` / `RevocationRootUpdatedEvent`
// wire shapes defined in `audit-trail.types.ts`. Tests inject the
// `InMemoryKytEventSource` reference implementation.
//
// **Output shape.** A JSON-LD `VerifiableCredential` of type
// `["VerifiableCredential", "AuditTrailFeed"]` whose `credentialSubject`
// carries the normalised event timeline plus a stage-by-stage summary.
// Fields are deterministically ordered by `(slot, txSignature)` so
// downstream consumers (FN-132 1099 issuer, FN-133 travel-rule
// generator) can hash the output for caching / diffing.
//
// **Signing.** Signing is opt-in via the injected `VcSigner`; the
// default `NoOpVcSigner` preserves the historical unsigned shape
// (no `proof` key in the emitted document). Set
// `AUDIT_SIGNING_KEY_PATH` and pass `createVcSignerFromEnv({ issuerDid })`
// to emit an `Ed25519Signature2020` proof block per W3C VC Data
// Integrity / RFC 8785 (FN-084). The proof preimage is
// `sha256(JCS(vcWithoutProof))` — the proof block is excluded from the
// hash input.
//
// **Determinism guarantees.** Given identical event inputs and bounds,
// `buildAuditFeed` MUST produce a byte-identical document apart from
// `issuanceDate` (which is sourced from an injectable clock — tests
// pin it to a fixed timestamp).

import {
  type KytTraceEvent,
  type RevocationRootUpdatedEvent,
  kytTraceEventSchema,
  revocationRootUpdatedEventSchema,
} from "./audit-trail.types.js";
import {
  NoOpVcSigner,
  type Ed25519Signature2020Proof,
  type VcSigner,
} from "./vc-signer.js";

export type {
  CounterpartyWire,
  KytStageWire,
  KytTraceEvent,
  PartyTraceWire,
  RevocationRootUpdatedEvent,
} from "./audit-trail.types.js";
export {
  counterpartyWireSchema,
  kytStageWireSchema,
  kytTraceEventSchema,
  partyTraceWireSchema,
  revocationRootUpdatedEventSchema,
} from "./audit-trail.types.js";

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export type AuditTrailIndexerErrorCode =
  | "INVALID_KYT_EVENT"
  | "INVALID_REVOCATION_EVENT"
  | "INVALID_AUTHORITY"
  | "INVALID_BOUNDS";

export class AuditTrailIndexerError extends Error {
  public override readonly name = "AuditTrailIndexerError";
  public readonly code: AuditTrailIndexerErrorCode;
  public readonly detail?: unknown;
  public constructor(
    code: AuditTrailIndexerErrorCode,
    message: string,
    detail?: unknown,
  ) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------
// Logger (intentionally redeclared — do NOT couple to civic.ts)
// ---------------------------------------------------------------------

/**
 * Minimal structured-log surface mirroring the `IssuerLogger` shape used
 * by the issuer modules. Redeclared (instead of imported) so the
 * audit-trail indexer has no compile-time dependency on civic / any
 * issuer module.
 */
export interface AuditLogger {
  info?(msg: string, fields?: Record<string, unknown>): void;
  warn?(msg: string, fields?: Record<string, unknown>): void;
  error?(msg: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------
// Event source abstraction
// ---------------------------------------------------------------------

export interface KytEventSourceQueryOpts {
  /** Inclusive lower bound on slot. */
  sinceSlot?: number;
  /** Exclusive upper bound on slot. */
  untilSlot?: number;
}

/**
 * Source of `KytTrace` and `RevocationRootUpdated` events.
 *
 * The production wiring will be backed by `EtoRpcClient.ethGetLogs`
 * (EVM) and Solana `logsSubscribe` parsing the `singularity:kyt:` /
 * `singularity:revocation:root_updated` log prefixes. v0 ships only
 * the in-memory reference implementation; the live transport is a
 * follow-up task.
 */
export interface KytEventSource {
  /**
   * Yield every `KytTraceEvent` involving `authority` (in either the
   * BAP or BPP slot) within the requested slot window, in ascending
   * `(slot, tx_signature)` order.
   */
  tracesForAuthority(
    authority: string,
    opts?: KytEventSourceQueryOpts,
  ): AsyncIterable<KytTraceEvent>;

  /**
   * Yield every `RevocationRootUpdatedEvent` whose `oracle` is in
   * `issuers` within the requested slot window, in ascending
   * `(slot, oracle, root)` order.
   */
  revocationsForCredentialIssuers(
    issuers: readonly string[],
    opts?: KytEventSourceQueryOpts,
  ): AsyncIterable<RevocationRootUpdatedEvent>;
}

// ---------------------------------------------------------------------
// In-memory reference event source
// ---------------------------------------------------------------------

export interface InMemoryKytEventSourceInit {
  traces: readonly KytTraceEvent[];
  revocations?: readonly RevocationRootUpdatedEvent[];
}

function compareTraces(a: KytTraceEvent, b: KytTraceEvent): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.tx_signature < b.tx_signature) return -1;
  if (a.tx_signature > b.tx_signature) return 1;
  return 0;
}

function compareRevocations(
  a: RevocationRootUpdatedEvent,
  b: RevocationRootUpdatedEvent,
): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.oracle !== b.oracle) return a.oracle < b.oracle ? -1 : 1;
  if (a.root !== b.root) return a.root < b.root ? -1 : 1;
  return 0;
}

function withinBounds(slot: number, opts?: KytEventSourceQueryOpts): boolean {
  if (opts?.sinceSlot !== undefined && slot < opts.sinceSlot) return false;
  if (opts?.untilSlot !== undefined && slot >= opts.untilSlot) return false;
  return true;
}

/**
 * Reference `KytEventSource` backed by an in-memory event array.
 * Used by tests and as the seed for the FN-132 / FN-133 fixtures.
 *
 * The instance validates every input event with the zod schemas from
 * `audit-trail.types.ts` at construction time and re-validates on each
 * yield as a defensive integrity check. Slot-window semantics:
 *
 *   - `sinceSlot` is **inclusive** on the lower bound.
 *   - `untilSlot` is **exclusive** on the upper bound.
 *   - Events are yielded in ascending `(slot, tx_signature)` order
 *     for traces and `(slot, oracle, root)` for revocations.
 */
export class InMemoryKytEventSource implements KytEventSource {
  private readonly traces: readonly KytTraceEvent[];
  private readonly revocations: readonly RevocationRootUpdatedEvent[];

  public constructor(init: InMemoryKytEventSourceInit) {
    const traces = [...init.traces].map((t) => {
      const parsed = kytTraceEventSchema.safeParse(t);
      if (!parsed.success) {
        throw new AuditTrailIndexerError(
          "INVALID_KYT_EVENT",
          `invalid KytTraceEvent: ${parsed.error.message}`,
          parsed.error.issues,
        );
      }
      return parsed.data;
    });
    traces.sort(compareTraces);

    const revs = [...(init.revocations ?? [])].map((r) => {
      const parsed = revocationRootUpdatedEventSchema.safeParse(r);
      if (!parsed.success) {
        throw new AuditTrailIndexerError(
          "INVALID_REVOCATION_EVENT",
          `invalid RevocationRootUpdatedEvent: ${parsed.error.message}`,
          parsed.error.issues,
        );
      }
      return parsed.data;
    });
    revs.sort(compareRevocations);

    this.traces = traces;
    this.revocations = revs;
  }

  public async *tracesForAuthority(
    authority: string,
    opts?: KytEventSourceQueryOpts,
  ): AsyncIterable<KytTraceEvent> {
    if (!authority) {
      throw new AuditTrailIndexerError(
        "INVALID_AUTHORITY",
        "authority must be a non-empty base58 string",
      );
    }
    for (const t of this.traces) {
      if (!withinBounds(t.slot, opts)) continue;
      const matches = t.parties.some((p) => p.authority === authority);
      if (!matches) continue;
      yield t;
    }
  }

  public async *revocationsForCredentialIssuers(
    issuers: readonly string[],
    opts?: KytEventSourceQueryOpts,
  ): AsyncIterable<RevocationRootUpdatedEvent> {
    const allow = new Set(issuers);
    for (const r of this.revocations) {
      if (!withinBounds(r.slot, opts)) continue;
      if (allow.size > 0 && !allow.has(r.oracle)) continue;
      yield r;
    }
  }
}

// ---------------------------------------------------------------------
// Audit feed (JSON-LD VerifiableCredential)
// ---------------------------------------------------------------------

export const AUDIT_TRAIL_CONTEXT_VC = "https://www.w3.org/2018/credentials/v1";
export const AUDIT_TRAIL_CONTEXT_ETO = "https://schema.eto.network/audit/v1";
export const AUDIT_TRAIL_ISSUER_DID = "did:eto:indexer:audit-trail:v0";
export const AUDIT_TRAIL_VC_TYPE = ["VerifiableCredential", "AuditTrailFeed"] as const;

export interface AuditFeedKytEvent {
  kind: "kyt";
  stage: "init" | "confirm" | "rate";
  txSignature: string;
  slot: number;
  /** ISO-8601 UTC string derived from the on-chain `timestamp` (seconds). */
  timestamp: string;
  /**
   * The *other* party's authority. For an audit feed scoped to a BAP
   * authority, this is the BPP authority on each event; for a BPP
   * authority, it is the BAP authority.
   */
  counterparty: {
    party: "bap" | "bpp";
    authority: string;
    credPointers: readonly string[];
  };
  /** Cred pointers presented by the audited party itself. */
  selfCredPointers: readonly string[];
}

export interface AuditFeedRevocationEvent {
  kind: "revocation";
  txSignature?: undefined;
  slot: number;
  oracle: string;
  network: string;
  root: string;
  leaves: number;
}

export type AuditFeedEvent = AuditFeedKytEvent | AuditFeedRevocationEvent;

export interface AuditFeedSummary {
  kytCount: number;
  initCount: number;
  confirmCount: number;
  rateCount: number;
  revocationCount: number;
}

export interface AuditFeedJsonLd {
  "@context": readonly [typeof AUDIT_TRAIL_CONTEXT_VC, typeof AUDIT_TRAIL_CONTEXT_ETO];
  id: string;
  type: readonly ["VerifiableCredential", "AuditTrailFeed"];
  // FN-084: widened from the literal `typeof AUDIT_TRAIL_ISSUER_DID` to
  // `string` so an injected `VcSigner` can override the placeholder DID.
  // The default value is still `AUDIT_TRAIL_ISSUER_DID`.
  issuer: string;
  issuanceDate: string;
  credentialSubject: {
    id: string;
    authority: string;
    bounds: { sinceSlot: number | "earliest"; untilSlot: number | "latest" };
    events: readonly AuditFeedEvent[];
    summary: AuditFeedSummary;
  };
  /** FN-084: optional Ed25519Signature2020 proof block. Absent when the
   *  default `NoOpVcSigner` is in use (preserves byte-stable v0 shape). */
  proof?: Ed25519Signature2020Proof;
}

// ---------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------

export interface BuildAuditFeedOpts {
  sinceSlot?: number;
  untilSlot?: number;
  /**
   * If set, restrict revocation events to oracles in the allowlist.
   * Downstream consumers (FN-132 1099, FN-133 travel-rule) use this to
   * scope the feed to one issuer's view.
   */
  issuerAllowlist?: readonly string[];
}

export interface AuditTrailIndexerDeps {
  source: KytEventSource;
  logger?: AuditLogger;
  /** Defaults to `() => new Date()`. Tests inject a fixed clock. */
  clock?: () => Date;
  /**
   * FN-084: optional VC signer. Defaults to `NoOpVcSigner(AUDIT_TRAIL_ISSUER_DID)`
   * which produces a byte-stable unsigned document (no `proof` key).
   */
  signer?: VcSigner;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function assertAuthority(authority: string): void {
  if (!authority || !BASE58_RE.test(authority)) {
    throw new AuditTrailIndexerError(
      "INVALID_AUTHORITY",
      "authority must be a non-empty base58 string",
      { authority },
    );
  }
}

function assertBounds(opts?: BuildAuditFeedOpts): void {
  if (opts?.sinceSlot !== undefined) {
    if (!Number.isInteger(opts.sinceSlot) || opts.sinceSlot < 0) {
      throw new AuditTrailIndexerError(
        "INVALID_BOUNDS",
        "sinceSlot must be a non-negative integer",
      );
    }
  }
  if (opts?.untilSlot !== undefined) {
    if (!Number.isInteger(opts.untilSlot) || opts.untilSlot < 0) {
      throw new AuditTrailIndexerError(
        "INVALID_BOUNDS",
        "untilSlot must be a non-negative integer",
      );
    }
  }
  if (
    opts?.sinceSlot !== undefined &&
    opts?.untilSlot !== undefined &&
    opts.sinceSlot > opts.untilSlot
  ) {
    throw new AuditTrailIndexerError(
      "INVALID_BOUNDS",
      "sinceSlot must be <= untilSlot",
    );
  }
}

function unixSecondsToIso(seconds: number): string {
  // The on-chain timestamp is unix seconds; convert without losing
  // precision for the JS-safe range.
  return new Date(seconds * 1000).toISOString();
}

function feedUrn(
  authority: string,
  sinceSlot: number | undefined,
  untilSlot: number | undefined,
): string {
  const lo = sinceSlot ?? 0;
  const hi = untilSlot === undefined ? "latest" : String(untilSlot);
  return `urn:eto:audit:${authority}:${lo}:${hi}`;
}

/**
 * Audit-trail indexer. Wraps a `KytEventSource` and produces the
 * JSON-LD audit feed for a given AgentCard authority.
 */
export class AuditTrailIndexer {
  private readonly source: KytEventSource;
  private readonly logger?: AuditLogger;
  private readonly clock: () => Date;
  private readonly signer: VcSigner;

  public constructor(deps: AuditTrailIndexerDeps) {
    this.source = deps.source;
    if (deps.logger) this.logger = deps.logger;
    this.clock = deps.clock ?? (() => new Date());
    this.signer = deps.signer ?? new NoOpVcSigner(AUDIT_TRAIL_ISSUER_DID);
  }

  public async buildAuditFeed(
    authority: string,
    opts?: BuildAuditFeedOpts,
  ): Promise<AuditFeedJsonLd> {
    assertAuthority(authority);
    assertBounds(opts);

    const sinceSlot = opts?.sinceSlot;
    const untilSlot = opts?.untilSlot;
    const sourceOpts: KytEventSourceQueryOpts = {};
    if (sinceSlot !== undefined) sourceOpts.sinceSlot = sinceSlot;
    if (untilSlot !== undefined) sourceOpts.untilSlot = untilSlot;

    // ---- Pull and validate KYT traces. ----
    const kytEvents: AuditFeedKytEvent[] = [];
    let initCount = 0;
    let confirmCount = 0;
    let rateCount = 0;

    for await (const raw of this.source.tracesForAuthority(
      authority,
      sourceOpts,
    )) {
      const parsed = kytTraceEventSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AuditTrailIndexerError(
          "INVALID_KYT_EVENT",
          `event source yielded an invalid KytTraceEvent: ${parsed.error.message}`,
          parsed.error.issues,
        );
      }
      const ev = parsed.data;

      // Determine which side the audited authority is on; the
      // counterparty is the other side.
      const selfIdx = ev.parties.findIndex((p) => p.authority === authority);
      if (selfIdx < 0) {
        // Defensive: a KytEventSource that yields a trace not involving
        // `authority` is buggy. Skip it but log a warning.
        this.logger?.warn?.(
          "audit-trail: dropped trace not involving authority",
          { authority, tx_signature: ev.tx_signature },
        );
        continue;
      }
      const otherIdx = selfIdx === 0 ? 1 : 0;
      const self = ev.parties[selfIdx]!;
      const other = ev.parties[otherIdx]!;

      switch (ev.stage) {
        case "init":
          initCount += 1;
          break;
        case "confirm":
          confirmCount += 1;
          break;
        case "rate":
          rateCount += 1;
          break;
      }

      kytEvents.push({
        kind: "kyt",
        stage: ev.stage,
        txSignature: ev.tx_signature,
        slot: ev.slot,
        timestamp: unixSecondsToIso(ev.timestamp),
        counterparty: {
          party: other.party,
          authority: other.authority,
          credPointers: [...other.cred_pointers],
        },
        selfCredPointers: [...self.cred_pointers],
      });
    }

    // ---- Pull and validate revocation events. ----
    const revEvents: AuditFeedRevocationEvent[] = [];
    const issuerSet =
      opts?.issuerAllowlist !== undefined
        ? [...opts.issuerAllowlist]
        : undefined;

    if (issuerSet === undefined || issuerSet.length > 0) {
      const issuers = issuerSet ?? [];
      for await (const raw of this.source.revocationsForCredentialIssuers(
        issuers,
        sourceOpts,
      )) {
        const parsed = revocationRootUpdatedEventSchema.safeParse(raw);
        if (!parsed.success) {
          throw new AuditTrailIndexerError(
            "INVALID_REVOCATION_EVENT",
            `event source yielded an invalid RevocationRootUpdatedEvent: ${parsed.error.message}`,
            parsed.error.issues,
          );
        }
        const r = parsed.data;
        if (issuerSet !== undefined && !issuerSet.includes(r.oracle)) {
          // The source already filters, but enforce locally as the
          // contract is "yield only oracles in `issuers`" and we want
          // a defensive boundary against a buggy source.
          continue;
        }
        revEvents.push({
          kind: "revocation",
          slot: r.slot,
          oracle: r.oracle,
          network: r.network,
          root: r.root,
          leaves: r.leaves,
        });
      }
    }

    // ---- Deterministic ordering across the merged stream. ----
    const allEvents: AuditFeedEvent[] = [...kytEvents, ...revEvents];
    allEvents.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot - b.slot;
      const aSig = a.kind === "kyt" ? a.txSignature : `~rev:${a.oracle}:${a.root}`;
      const bSig = b.kind === "kyt" ? b.txSignature : `~rev:${b.oracle}:${b.root}`;
      if (aSig < bSig) return -1;
      if (aSig > bSig) return 1;
      return 0;
    });

    const summary: AuditFeedSummary = {
      kytCount: kytEvents.length,
      initCount,
      confirmCount,
      rateCount,
      revocationCount: revEvents.length,
    };

    const issuerDid =
      this.signer.issuerDid !== AUDIT_TRAIL_ISSUER_DID
        ? this.signer.issuerDid
        : AUDIT_TRAIL_ISSUER_DID;

    const feed: AuditFeedJsonLd = {
      "@context": [AUDIT_TRAIL_CONTEXT_VC, AUDIT_TRAIL_CONTEXT_ETO],
      id: feedUrn(authority, sinceSlot, untilSlot),
      type: AUDIT_TRAIL_VC_TYPE,
      issuer: issuerDid,
      issuanceDate: this.clock().toISOString(),
      credentialSubject: {
        id: `did:eto:agent:${authority}`,
        authority,
        bounds: {
          sinceSlot: sinceSlot ?? "earliest",
          untilSlot: untilSlot ?? "latest",
        },
        events: allEvents,
        summary,
      },
    };

    // FN-084: sign the proof-less document and attach the proof block
    // iff the signer produced a non-empty proofValue. The NoOp path
    // returns proofValue === "", which we map to no `proof` key so the
    // v0 unsigned wire shape stays byte-identical.
    // Pass a shallow copy so the signer cannot observe (or be passed)
    // a `proof` field. The proof block is excluded from the JCS
    // preimage per W3C VC Data Integrity §11.4.
    const proof = await this.signer.sign({ ...feed });
    if (proof.proofValue !== "") {
      feed.proof = proof;
    }

    this.logger?.info?.("audit-trail: built feed", {
      authority,
      kytCount: summary.kytCount,
      revocationCount: summary.revocationCount,
      signed: proof.proofValue !== "",
    });

    return feed;
  }
}

/**
 * Free-function wrapper around `AuditTrailIndexer.buildAuditFeed` for
 * callers that don't need a long-lived indexer instance.
 */
export async function buildAuditFeed(
  deps: AuditTrailIndexerDeps,
  authority: string,
  opts?: BuildAuditFeedOpts,
): Promise<AuditFeedJsonLd> {
  return new AuditTrailIndexer(deps).buildAuditFeed(authority, opts);
}

// ---------------------------------------------------------------------------
// JOSE proof suite (FN-030)
// ---------------------------------------------------------------------------
//
// Minimal compact-JWS wrapper for the `jose` proof suite registered in
// `AuditFeedProofSuite`. Signs any JSON-serialisable payload with an
// Ed25519 private key and returns a 3-part compact JWS string:
//
//   base64url(header) + "." + base64url(payload) + "." + base64url(sig)
//
// Header: `{ alg: "EdDSA", typ: "JWT" }` (RFC 7515 / RFC 8037).
// Signing input: ASCII bytes of `headerPart + "." + payloadPart`.
//
// This is dependency-free — it uses the `@noble/ed25519` and `@noble/hashes`
// packages already in the dependency graph rather than the `jose` npm package.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Configure synchronous sha512 required by @noble/ed25519 v2 (idempotent).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Sign `payload` with an Ed25519 `privateKey` and return a compact JWS.
 *
 * Header is `{ alg: "EdDSA", typ: "JWT" }`. To include a `kid` for key
 * rotation (FN-028), use `signWithKid` from `src/signing/key-rotation.ts`.
 *
 * @param payload     Any JSON-serialisable value.
 * @param privateKey  Raw 32-byte Ed25519 private key (seed).
 * @returns Compact JWS: `<header>.<payload>.<sig>`, all parts base64url.
 */
export async function signWithJose(
  payload: unknown,
  privateKey: Uint8Array,
): Promise<string> {
  const enc = new TextEncoder();
  const headerPart = b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const payloadPart = b64url(enc.encode(JSON.stringify(payload)));
  const signingInput = enc.encode(`${headerPart}.${payloadPart}`);
  const sig = await ed.signAsync(signingInput, privateKey);
  return `${headerPart}.${payloadPart}.${b64url(sig)}`;
}
