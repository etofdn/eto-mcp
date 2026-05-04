/**
 * Type system for the Beckn Provider Platform (BPP) keeper template
 * (T-2.7.1.1 / FN-073).
 *
 * The shapes in this file are the public contract that downstream tasks
 * (FN-074 credential gate, FN-075–079 reference BPPs, FN-085, FN-179)
 * import from `@eto/mcp/keeper/templates/bpp`. They are kept minimal,
 * runtime-validatable (via Zod), and explicitly aligned with the
 * on-chain Rust definitions:
 *
 *  * `RequirementSpec` (Rust, `src/runtime/src/programs/beckn/network.rs`)
 *      — schema: [u8; 32], predicate_hash: [u8; 32], issuer_filter: Vec<Pubkey>.
 *  * `HeldCredential` (Rust, `src/runtime/src/credential.rs`)
 *      — schema, predicate_hash, issuer, valid_from, valid_until, revoked.
 *  * `AgentCard` (Rust, same file) — authority + credentials.
 *
 * The TypeScript types here are intentionally string-typed (hex / base58)
 * rather than byte-typed; on-chain parity is enforced where the values
 * cross the boundary (`register.ts`, `credential-gate.ts`).
 *
 * NOTE on `AgentConfig`: the broader ETO Keeper SDK (whose top-level
 * `runAgentLoop` will live in `eto-mcp/keeper/start.ts`) is being
 * scaffolded in parallel. To keep this template self-contained, we
 * define a minimal `AgentConfig` shape here with the fields the BPP
 * runtime actually consumes; once `start.ts` lands the import can be
 * unified without breaking BPP authors who type against this surface.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Primitive aliases                                                          */
/* -------------------------------------------------------------------------- */

/** Lowercase 32-byte hex digest, no `0x` prefix. */
export type Hex32 = string;

/** Opaque base58 / base64 pubkey string (Solana-style). */
export type Pubkey = string;

/**
 * Semantic version `MAJOR.MINOR.PATCH` (no pre-release / build suffixes
 * on the surface of capability tags — keep tags grep-friendly).
 */
export type SemVer = `${number}.${number}.${number}`;

const HEX32_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Currencies the BPP catalogue accepts as price denominations. */
export const SUPPORTED_CURRENCIES = ["ETO", "EUSD", "USD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/* -------------------------------------------------------------------------- */
/* Required credentials                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Off-chain mirror of the on-chain `RequirementSpec` (FN-019).
 *
 * `schema` is the lowercase hex of the 32-byte schema tag. `issuerSet`
 * is the list of permitted issuer pubkeys (empty ⇒ any issuer); this
 * mirrors `RequirementSpec.issuer_filter`. `mustBeActive` and
 * `notExpiredWithinSec` are template-side ergonomics: full parity with
 * `HeldCredential::is_active_at` lands in FN-074 (see TODO in
 * `credential-gate.ts`).
 */
export interface RequiredCredential {
  /** `sha256("eto.beckn.schema...")` lowercase hex, 64 chars. */
  readonly schema: Hex32;
  /** Allowed issuer pubkeys (empty array ⇒ any issuer permitted). */
  readonly issuerSet: readonly Pubkey[];
  /** If true, gate rejects revoked / out-of-window credentials. */
  readonly mustBeActive: boolean;
  /**
   * If set, gate additionally rejects credentials whose `valid_until`
   * is within this many seconds of `now`. Useful for "must be valid
   * for at least N seconds into the future" SLOs. `0` / undefined ⇒
   * no margin enforced.
   */
  readonly notExpiredWithinSec?: number;
}

/* -------------------------------------------------------------------------- */
/* Capability tags                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Capability tags advertised by a BPP and pinned into its
 * AgentCard's `metadata_uri`.
 *
 * The five reference BPPs (FN-075–079) populate this struct directly;
 * the bank BPP (FN-096) extends with its own `domain` namespace.
 * `description` is a short human-readable blurb; long descriptions
 * push the JSON over the inline `data:` URL budget and force the
 * registration path through a `MetadataPinner`.
 */
export interface CapabilityTags {
  /** Top-level domain, e.g. `text`, `code`, `web`, `image`, `data`. */
  readonly domain: string;
  /** Action within the domain, e.g. `summarize`, `audit:solidity`. */
  readonly action: string;
  /** Semver — bumped on breaking handler-input/output contract changes. */
  readonly version: SemVer;
  /** Quoted price per task. `amount` is a decimal string; on-chain settlement is integer minor units. */
  readonly price: {
    readonly amount: string;
    readonly currency: Currency;
  };
  /** Credentials the BAP must present at Beckn `init` time. */
  readonly requiredCredentials: readonly RequiredCredential[];
  /** Short prose, ≤ 512 chars. */
  readonly description: string;
}

/* -------------------------------------------------------------------------- */
/* Beckn lifecycle types                                                      */
/* -------------------------------------------------------------------------- */

/** A Beckn `Init` event delivered by the eventSource to the BPP runtime. */
export interface BeckonInitEvent<TInput = unknown> {
  /** Unique task id (Beckn `transaction_id`). */
  readonly taskId: string;
  /** BAP that originated the request. */
  readonly bapPubkey: Pubkey;
  /** BPP this event is addressed to. */
  readonly bppPubkey: Pubkey;
  /** Network (Beckn `domain`) the task runs in. */
  readonly networkPubkey: Pubkey;
  /** Capability action this event targets, e.g. `text:summarize`. */
  readonly action: string;
  /** Caller-provided typed payload. */
  readonly input: TInput;
  /** Unix seconds at which the event was observed. */
  readonly observedAt: number;
  /**
   * Gateway-verified BAP caller pubkey (FN-073).
   *
   * Set by the gateway layer when it has successfully verified the
   * BAP-signature on the inbound Beckn request (Ed25519 over the request
   * body, presented in the `Authorization` header). Absent / undefined when
   * the gateway could not verify a signature — handlers MUST treat absence
   * as `unauthorized_caller` for any money-binding capability.
   *
   * The value is the lowercase hex-encoded ed25519 public key of the BAP
   * whose signature was verified.
   */
  readonly callerPubkey?: string;
}

/** Inbound task (mirror of BeckonInitEvent at the handler layer). */
export interface TaskRequest<TInput = unknown> {
  readonly taskId: string;
  readonly bapPubkey: Pubkey;
  readonly bppPubkey: Pubkey;
  readonly networkPubkey: Pubkey;
  readonly action: string;
  readonly input: TInput;
  /**
   * Gateway-verified BAP caller pubkey (FN-073).
   *
   * Threaded from `BeckonInitEvent.callerPubkey` by the BPP runtime.
   * Per-capability handlers use {@link extractCallerPubkey} (from
   * `keeper/bpps/bank/handler.ts`) to read this field and `assertCallerEquals`
   * (from `keeper/bpps/bank/auth.ts`) to bind it to the request subject.
   * Absent / undefined means the gateway did not verify a caller — handlers
   * MUST fail-closed with `unauthorized_caller` for any money-binding action.
   */
  readonly callerPubkey?: string;
}

/**
 * Outcome from a handler. `success` is committed via `chain.completeTask`;
 * `failure` is committed via `chain.failTask` with `reason` surfaced
 * to the BAP.
 */
export type TaskResult<TOutput = unknown> =
  | { readonly status: "success"; readonly output: TOutput }
  | { readonly status: "failure"; readonly reason: string };

/** Side-effect surface available to a handler. */
export interface BppContext {
  readonly logger: Logger;
  readonly agent: { readonly authority: Pubkey; readonly name: string };
  /** Wall-clock seconds, injected for determinism in tests. */
  readonly now: () => number;
}

/** Minimal logger shape — matches `start.ts` `logAgent` signature. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The single extension point a BPP author implements. Maps the Beckn
 * `select → init → confirm → status` lifecycle onto one async callback;
 * the runtime takes care of credential gating, on-chain `CompleteTask` /
 * `FailTask`, and structured logging around every invocation.
 */
export interface BppHandler<TInput = unknown, TOutput = unknown> {
  handleTask(
    req: TaskRequest<TInput>,
    ctx: BppContext,
  ): Promise<TaskResult<TOutput>>;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Minimal `AgentConfig` shape consumed by the BPP runtime.
 *
 * Mirrors the keeper-side `AgentConfig` that will land alongside
 * `eto-mcp/keeper/start.ts`. Defined locally here so this template
 * does not transitively pull in the rest of the Keeper SDK; once
 * `start.ts` ships, this can become `extends import("../start.js").AgentConfig`
 * without breaking BPP authors.
 */
export interface AgentConfig {
  /** Human-readable name (also written into AgentCard `name`). */
  readonly name: string;
  /** Anthropic / model identifier; opaque to the runtime. */
  readonly modelId: string;
  /** Authority pubkey controlling the BPP's AgentCard. */
  readonly authority: Pubkey;
  /** Directory for per-agent log files. */
  readonly logDir?: string;
}

/** Full BPP configuration: an `AgentConfig` plus capability + gating. */
export interface BppConfig extends AgentConfig {
  readonly capabilityTags: CapabilityTags;
  /**
   * Credentials a BAP must hold to invoke this BPP. Typically the same
   * list as `capabilityTags.requiredCredentials`; the duplicated field
   * lets a BPP advertise stricter on-chain gating than its public
   * catalogue claims (or vice versa) without fork-pinning.
   */
  readonly requiredBapCredentials: readonly RequiredCredential[];
  /** Per-task wall-clock budget, in seconds. Defaults to 60 if omitted. */
  readonly handlerTimeoutSec?: number;
}

/* -------------------------------------------------------------------------- */
/* Zod schemas                                                                */
/* -------------------------------------------------------------------------- */

const zHex32 = z
  .string()
  .regex(HEX32_RE, "must be 64 lowercase hex chars (32 bytes)");

const zSemver = z
  .string()
  .regex(SEMVER_RE, "must be MAJOR.MINOR.PATCH semver");

const zPubkey = z.string().min(32).max(64);

export const zRequiredCredential = z
  .object({
    schema: zHex32,
    issuerSet: z.array(zPubkey),
    mustBeActive: z.boolean(),
    notExpiredWithinSec: z.number().int().nonnegative().optional(),
  })
  .strict();

export const zCapabilityTags = z
  .object({
    domain: z.string().min(1).max(64),
    action: z.string().min(1).max(128),
    version: zSemver,
    price: z
      .object({
        amount: z.string().regex(/^\d+(\.\d+)?$/, "decimal amount string"),
        currency: z.enum(SUPPORTED_CURRENCIES),
      })
      .strict(),
    requiredCredentials: z.array(zRequiredCredential),
    description: z.string().max(512),
  })
  .strict();

export const zAgentConfig = z
  .object({
    name: z.string().min(1).max(64),
    modelId: z.string().min(1),
    authority: zPubkey,
    logDir: z.string().min(1).optional(),
  })
  .strict();

export const zBppConfig = zAgentConfig.extend({
  capabilityTags: zCapabilityTags,
  requiredBapCredentials: z.array(zRequiredCredential),
  handlerTimeoutSec: z.number().int().positive().optional(),
});

/* -------------------------------------------------------------------------- */
/* AgentCard snapshot (gating input)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Off-chain projection of the on-chain `AgentCard` plus its
 * `HeldCredential` list. The credential-gate consumes this; full
 * `AgentCard` parity (controller_authority, kya_score, refs) lands
 * in FN-074 once the on-chain reader is wired.
 */
export interface AgentCardSnapshot {
  readonly authority: Pubkey;
  readonly credentials: readonly HeldCredentialSnapshot[];
}

/** Off-chain mirror of `HeldCredential`. */
export interface HeldCredentialSnapshot {
  readonly schema: Hex32;
  readonly predicateHash: Hex32;
  readonly issuer: Pubkey;
  /** Unix seconds; `0` ⇒ no lower bound. */
  readonly validFrom: number;
  /** Unix seconds; `0` ⇒ no upper bound. */
  readonly validUntil: number;
  readonly revoked: boolean;
}
