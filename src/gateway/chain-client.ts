/**
 * FN-091 — Beckn gateway chain client.
 *
 * Replaces the inline `stubSubmit` in `inbound-bap.ts` / `inbound-bpp.ts`
 * with a swappable `ChainClient` so the bridge can submit real on-chain
 * `BecknProgram::{Search,Select,Init,Confirm}` instructions when an
 * `ETO_RPC_ENDPOINT` is configured.
 *
 * Default behaviour (no env): `StubChainClient` returns deterministic
 * `stub-<hex>` signatures so existing tests stay green.
 *
 * v0 SvmChainClient: serializes the args as JSON and submits via
 * `EtoRpcClient.sendTransaction`. Real Borsh-encoded instruction
 * data lands in a follow-up (FN-091 §details "Real Borsh encoding").
 * The wiring layer (this file + the dep injection) is what FN-091 asks
 * for; the encoding is a downstream task that can land without
 * touching the gateway again.
 */
import { createHash } from "node:crypto";
import { rpc as defaultRpc, EtoRpcClient } from "../read/rpc-client.js";
import type { BecknAction } from "./beckn.js";
import { config } from "../config.js";

export interface ChainSubmitResult {
  tx_signature: string;
  /** Slot at which the tx was accepted (best-effort; 0n for stub). */
  submitted_at_slot?: bigint;
}

/**
 * Chain action — narrow type for /search /select /init /confirm
 * (Beckn-side) plus the BPP-side completion calls.
 */
export type ChainAction = BecknAction | "CompleteTask" | "FailTask";

export interface ChainClient {
  submit(action: ChainAction, args: unknown): Promise<ChainSubmitResult>;
  submitSearch(args: unknown): Promise<ChainSubmitResult & { intent_pda?: string; deadline_slot?: bigint }>;
  submitSelect(args: unknown): Promise<ChainSubmitResult>;
  submitInit(args: unknown): Promise<ChainSubmitResult>;
  submitConfirm(args: unknown): Promise<ChainSubmitResult>;
}

/* -------------------------------------------------------------------------- */
/* StubChainClient — backward-compatible default                              */
/* -------------------------------------------------------------------------- */

/** Deterministic synthetic signature in the existing `stub-<hex>` shape. */
function stubSig(action: ChainAction, args: unknown): string {
  const h = createHash("sha256")
    .update(action)
    .update("|")
    .update(JSON.stringify(args ?? {}))
    .digest("hex")
    .slice(0, 32);
  return `stub-${h}`;
}

export class StubChainClient implements ChainClient {
  async submit(action: ChainAction, args: unknown): Promise<ChainSubmitResult> {
    return { tx_signature: stubSig(action, args), submitted_at_slot: 0n };
  }
  async submitSearch(args: unknown) {
    const r = await this.submit("search", args);
    // Stub-derived intent_pda for testability.
    const intent_pda = createHash("sha256")
      .update("intent_pda|stub|")
      .update(JSON.stringify(args ?? {}))
      .digest("hex");
    return { ...r, intent_pda, deadline_slot: 0n };
  }
  submitSelect(args: unknown) { return this.submit("select", args); }
  submitInit(args: unknown) { return this.submit("init", args); }
  submitConfirm(args: unknown) { return this.submit("confirm", args); }
}

/* -------------------------------------------------------------------------- */
/* SvmChainClient — real wiring (v0: JSON payload, real RPC)                  */
/* -------------------------------------------------------------------------- */

export interface SvmChainClientOpts {
  /** Defaults to the module-level `rpc` singleton from src/read/rpc-client.ts. */
  rpc?: EtoRpcClient;
}

export class SvmChainClient implements ChainClient {
  private rpc: EtoRpcClient;
  constructor(opts: SvmChainClientOpts = {}) {
    this.rpc = opts.rpc ?? defaultRpc;
  }

  async submit(action: ChainAction, args: unknown): Promise<ChainSubmitResult> {
    // v0 placeholder: serializes args as base64-encoded JSON instead of
    // Borsh-encoded instruction data. The runtime currently accepts
    // arbitrary opaque payloads on the BecknProgram entrypoint per the
    // FN-050 instruction frame; real Borsh encoding is the next task to
    // land on top of this wiring (see FN-091 follow-up note).
    const payload = Buffer.from(JSON.stringify({ action, args }), "utf8").toString("base64");
    const tx_signature = await this.rpc.sendTransaction(payload);
    let submitted_at_slot: bigint | undefined;
    try {
      submitted_at_slot = BigInt(await this.rpc.getSlot());
    } catch {
      // best-effort
    }
    return { tx_signature, submitted_at_slot };
  }

  async submitSearch(args: unknown) {
    const r = await this.submit("search", args);
    // intent_pda + deadline_slot will be derived by the runtime; the
    // bridge does not need to compute them here. Returned as undefined
    // until FN-050 surfaces them in the tx receipt.
    return r;
  }
  submitSelect(args: unknown) { return this.submit("select", args); }
  submitInit(args: unknown) { return this.submit("init", args); }
  submitConfirm(args: unknown) { return this.submit("confirm", args); }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Returns SvmChainClient when `ETO_RPC_ENDPOINT` is set in the environment,
 * else StubChainClient. Idempotent — safe to call from many places.
 */
export function createDefaultChainClient(): ChainClient {
  const endpoint = process.env.ETO_RPC_ENDPOINT?.trim();
  if (endpoint && endpoint.length > 0) {
    return new SvmChainClient();
  }
  // Also honour config.etoRpcUrl when explicitly set to a non-localhost
  // endpoint — covers production deployments that wire via config.
  const url = config?.etoRpcUrl?.trim?.();
  if (url && !/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url)) {
    return new SvmChainClient();
  }
  return new StubChainClient();
}
