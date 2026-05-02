/**
 * CatalogCommit publisher for the bank-as-BPP keeper module
 * (FN-096 / T-3.9.1.2).
 *
 * Provides:
 *   - `CatalogCommitRecorder` — injectable interface for recording
 *     signed `CatalogCommitPayload`s.
 *   - `InMemoryCatalogCommitRecorder` — in-memory implementation used
 *     in tests, dev runs, and `main.ts` smoke checks.
 *   - `publishBankCatalog` — builds a commit, signs it, and invokes
 *     the recorder.
 *
 * ## On-chain integration
 *
 * TODO(FN-055): when on-chain `PublishCatalog` lands, replace
 * `InMemoryCatalogCommitRecorder` with an RPC adapter.  The
 * `CatalogCommitRecorder` interface boundary is the seam: downstream
 * tasks only need to provide a new `implements CatalogCommitRecorder`
 * class backed by the RPC client, without changing any call sites.
 */

import { canonicalCatalogJson, buildCatalogCommit } from "./catalog.js";
import type { BankCatalog, CatalogCommitPayload, Pubkey } from "./types.js";
import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Recorder interface                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Injectable interface for recording `CatalogCommitPayload`s.
 *
 * In tests and dev runs use `InMemoryCatalogCommitRecorder`.
 * TODO(FN-055): replace with an RPC adapter when `PublishCatalog`
 * on-chain instruction lands.
 */
export interface CatalogCommitRecorder {
  /**
   * Record a signed commit.
   *
   * @param commit - The `CatalogCommitPayload` to record.
   * @param signature - Hex-encoded signature over the canonical JSON.
   * @returns `{ commitHash, recordedAt }` where `commitHash` is the
   *   SHA-256 of the canonical JSON of `commit` (lowercase hex) and
   *   `recordedAt` is Unix seconds at recording time.
   */
  publish(
    commit: CatalogCommitPayload,
    signature: string,
  ): Promise<{ commitHash: string; recordedAt: number }>;
}

/* -------------------------------------------------------------------------- */
/* InMemoryCatalogCommitRecorder                                               */
/* -------------------------------------------------------------------------- */

/** Immutable record of a published commit (for test inspection). */
export interface PublishedCommitRecord {
  readonly commit: CatalogCommitPayload;
  readonly signature: string;
  readonly commitHash: string;
  readonly recordedAt: number;
}

/**
 * In-memory `CatalogCommitRecorder` that keeps an immutable history
 * of published commits.
 *
 * The `publishedCommits` array is exposed read-only to prevent
 * accidental mutation in tests.  Each call to `publish` appends one
 * entry.
 */
export class InMemoryCatalogCommitRecorder implements CatalogCommitRecorder {
  private readonly _records: PublishedCommitRecord[] = [];

  /**
   * Read-only view of all published commits in insertion order.
   * This array is a fresh copy — mutations do not affect the recorder.
   */
  get publishedCommits(): readonly PublishedCommitRecord[] {
    return [...this._records];
  }

  /** Total number of commits recorded so far. */
  get count(): number {
    return this._records.length;
  }

  public async publish(
    commit: CatalogCommitPayload,
    signature: string,
  ): Promise<{ commitHash: string; recordedAt: number }> {
    const commitHash = createHash("sha256")
      .update(JSON.stringify(commit), "utf8")
      .digest("hex");
    const recordedAt = Math.floor(Date.now() / 1000);
    this._records.push({ commit, signature, commitHash, recordedAt });
    return { commitHash, recordedAt };
  }
}

/* -------------------------------------------------------------------------- */
/* publishBankCatalog                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Signer type for `publishBankCatalog`.
 *
 * Matches the output of `makeStubSigner` from `chain-adapter.ts`
 * (`Promise<SignedEnvelope>` where `SignedEnvelope = { signature: string; pubkey: string }`).
 * The `signature` field is extracted and recorded; `pubkey` is returned
 * to the caller as part of the result bundle.
 */
export interface CatalogSigner {
  (msg: Uint8Array): Promise<{ signature: string; pubkey: string }>;
}

/** Result of `publishBankCatalog`. */
export interface PublishBankCatalogResult {
  readonly commit: CatalogCommitPayload;
  readonly commitHash: string;
  readonly signature: string;
  readonly signerPubkey: string;
}

/**
 * Build a `CatalogCommitPayload`, sign its canonical JSON, record the
 * result via the injected `recorder`, and return the full bundle.
 *
 * @param opts.catalog       - The `BankCatalog` to commit.
 * @param opts.networkPubkey - The IssuerNetwork authority pubkey.
 * @param opts.recorder      - Where to persist the signed commit.
 * @param opts.signer        - Async signer — use `makeStubSigner(seed)` in tests.
 */
export async function publishBankCatalog(opts: {
  readonly catalog: BankCatalog;
  readonly networkPubkey: Pubkey;
  readonly recorder: CatalogCommitRecorder;
  readonly signer: CatalogSigner;
}): Promise<PublishBankCatalogResult> {
  const commit = buildCatalogCommit(opts.catalog, opts.networkPubkey);

  // Sign the canonical JSON of the catalog (not the commit payload) so
  // the signature covers the complete catalogue data.
  const msg = new TextEncoder().encode(canonicalCatalogJson(opts.catalog));
  const { signature, pubkey: signerPubkey } = await opts.signer(msg);

  const { commitHash } = await opts.recorder.publish(commit, signature);

  return { commit, commitHash, signature, signerPubkey };
}
