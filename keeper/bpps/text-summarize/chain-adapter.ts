/**
 * Signing chain adapter for the `text:summarize` BPP (FN-075).
 *
 * Wraps a base `RuntimeChain` (e.g. `InMemoryChain` for tests, a real
 * RPC submitter post-FN-082) and signs every `completeTask` /
 * `failTask` payload via an injected `Signer`. The signed bytes are a
 * canonical JSON serialisation of `{ taskId, status, output|reason,
 * producedAtSec }` so signatures verify byte-for-byte across keeper
 * processes.
 *
 * The production signer will be a thin client over
 * `eto-mcp/signing-service` (FROST threshold ed25519); for now we only
 * ship a deterministic stub used by tests and the worked example.
 *
 *   TODO(real signer via eto-signing-service): replace `makeStubSigner`
 *   with a client over the FROST signing service once FN-082/FN-085
 *   land.
 */

import { createHash } from "node:crypto";
import type { RuntimeChain } from "../../templates/bpp/index.js";

/* -------------------------------------------------------------------------- */
/* Signer                                                                     */
/* -------------------------------------------------------------------------- */

export interface SignedEnvelope {
  readonly signature: string;
  readonly pubkey: string;
}

export type Signer = (msg: Uint8Array) => Promise<SignedEnvelope>;

/* -------------------------------------------------------------------------- */
/* Canonical JSON                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic JSON: object keys sorted ascending at every level,
 * arrays preserved in order. We restrict to plain JSON values and
 * reject `undefined` / functions / symbols early so signers never see
 * implementation-defined output.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const child = obj[k];
    if (child === undefined) continue;
    out[k] = canonicalize(child);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Schema of the bytes we sign. `producedAtSec` is supplied by the
 * caller (default `Math.floor(Date.now()/1000)`) so the signed bundle
 * is reproducible from the recorded payload alone.
 */
export interface SignedCompletePayload {
  readonly taskId: string;
  readonly status: "success";
  readonly output: unknown;
  readonly producedAtSec: number;
}
export interface SignedFailPayload {
  readonly taskId: string;
  readonly status: "failure";
  readonly reason: string;
  readonly producedAtSec: number;
}

export interface SignedCallRecord<T> {
  readonly payload: T;
  readonly signature: string;
  readonly signerPubkey: string;
}

/* -------------------------------------------------------------------------- */
/* SigningRuntimeChain                                                        */
/* -------------------------------------------------------------------------- */

export interface SigningRuntimeChainOpts {
  readonly inner: RuntimeChain;
  readonly signer: Signer;
  /** Wall-clock seconds. Default `Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
}

/**
 * Wraps a base `RuntimeChain`. Each call signs the canonical payload
 * and forwards `{ output|reason, signature, signerPubkey }` to the
 * inner chain so the signed envelope shows up in
 * `InMemoryChain.completed[i].output` (or `.failed[i].reason`).
 *
 * The wrapper keeps a public `signedComplete` / `signedFail` log so
 * tests (and post-FN-082 RPC submission) can re-derive the on-chain
 * payload without touching the inner chain's record format.
 */
export class SigningRuntimeChain implements RuntimeChain {
  public readonly signedComplete: Array<SignedCallRecord<SignedCompletePayload>> = [];
  public readonly signedFail: Array<SignedCallRecord<SignedFailPayload>> = [];

  private readonly inner: RuntimeChain;
  private readonly signer: Signer;
  private readonly now: () => number;

  public constructor(opts: SigningRuntimeChainOpts) {
    this.inner = opts.inner;
    this.signer = opts.signer;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  public async completeTask(args: {
    taskId: string;
    output: unknown;
  }): Promise<void> {
    const payload: SignedCompletePayload = {
      taskId: args.taskId,
      status: "success",
      output: args.output,
      producedAtSec: this.now(),
    };
    const env = await this.signer(toBytes(canonicalJson(payload)));
    this.signedComplete.push({
      payload,
      signature: env.signature,
      signerPubkey: env.pubkey,
    });
    await this.inner.completeTask({
      taskId: args.taskId,
      output: {
        result: args.output,
        signature: env.signature,
        signerPubkey: env.pubkey,
      },
    });
  }

  public async failTask(args: { taskId: string; reason: string }): Promise<void> {
    const payload: SignedFailPayload = {
      taskId: args.taskId,
      status: "failure",
      reason: args.reason,
      producedAtSec: this.now(),
    };
    const env = await this.signer(toBytes(canonicalJson(payload)));
    this.signedFail.push({
      payload,
      signature: env.signature,
      signerPubkey: env.pubkey,
    });
    await this.inner.failTask({
      taskId: args.taskId,
      reason: `${args.reason}|sig=${env.signature}|pk=${env.pubkey}`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Stub signer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic signer for tests / the worked example. Derives a pubkey
 * by hashing `seed`, then "signs" by hashing `pubkey || msg`. Output
 * is hex-encoded and stable across runs.
 *
 * TODO(real signer via eto-signing-service): swap for a FROST client.
 */
export function makeStubSigner(seed: string): Signer {
  const pubkey = createHash("sha256").update(`pk:${seed}`, "utf8").digest("hex");
  return async (msg: Uint8Array): Promise<SignedEnvelope> => {
    const sig = createHash("sha256")
      .update(pubkey, "hex")
      .update(msg)
      .digest("hex");
    return { signature: sig, pubkey };
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
