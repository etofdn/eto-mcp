/**
 * Bank-as-BPP handler (FN-096 / T-3.9.1.2).
 *
 * The `BankHandler` dispatches on `req.action`.  If the action matches one
 * of the five `BANK_CAPABILITY_KEYS` (`bank.checking`, `bank.savings`,
 * `bank.fiat-ramp`, `bank.card`, `bank.wire`), it returns a stub failure
 * response referencing the downstream task that will implement the real
 * logic.  Unknown actions return an `unknown_action` failure.
 *
 * ## Downstream task mapping
 *
 *   bank.checking  → FN-097 (issuer service) + FN-115 (open-checking flow)
 *   bank.savings   → FN-121 (open-savings flow)
 *   bank.fiat-ramp → FN-107 (onramp) + FN-145 (offramp)
 *   bank.card      → FN-125 (issue-card flow)
 *   bank.wire      → FN-119 (wire transfer flow)
 *
 * ## Extension points (TODOs for downstream tasks)
 *
 * Each per-capability stub has a `// TODO(FN-NNN)` comment pointing at
 * the task that will replace it with real logic.  When a downstream task
 * lands it should:
 *   1. Import the real adapter (e.g. `IssuerServiceClient`, `LedgerAdapter`).
 *   2. Add the adapter to `BankHandlerDeps`.
 *   3. Remove the stub return and call the real implementation.
 */

import type { BppHandler, TaskRequest, TaskResult } from "../../templates/bpp/index.js";
import { UNAUTHORIZED_CALLER_REASON } from "./auth.js";
import { BANK_CAPABILITY_KEYS } from "./catalog.js";
import type { BankCapabilityKey } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Handler deps                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Dependency injection surface for `createBankHandler`.
 *
 * All adapters are `optional` here so tests can construct the handler
 * without wiring real dependencies.  Each downstream task adds its
 * own adapter to this interface.
 *
 * TODO(FN-097, FN-115): add `issuerServiceClient: IssuerServiceClient`
 *   for the bank.checking flow.
 * TODO(FN-121): add `savingsAdapter` for the bank.savings flow.
 * TODO(FN-107, FN-145): add `rampAdapter` for the bank.fiat-ramp flow.
 * TODO(FN-125): add `cardAdapter` for the bank.card flow.
 * TODO(FN-119): add `wireAdapter` for the bank.wire flow.
 */
export interface BankHandlerDeps {
  /**
   * Wall-clock seconds supplier.  Defaults to `Math.floor(Date.now()/1000)`.
   * Override in tests for deterministic timestamps.
   */
  readonly now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Stub responses                                                              */
/* -------------------------------------------------------------------------- */

type StubMap = Record<BankCapabilityKey, string>;

/**
 * Canonical stub failure reasons, one per capability.
 * Each reason includes the downstream task ID so readers can quickly
 * find the follow-up work.
 */
const STUB_REASONS: StubMap = {
  "bank.checking":
    "not_implemented: bank.checking — see FN-097, FN-115",
  "bank.savings":
    "not_implemented: bank.savings — see FN-121",
  "bank.fiat-ramp":
    "not_implemented: bank.fiat-ramp — see FN-107, FN-145",
  "bank.card":
    "not_implemented: bank.card — see FN-125",
  "bank.wire":
    "not_implemented: bank.wire — see FN-119",
};

/* -------------------------------------------------------------------------- */
/* Caller-pubkey extraction (FN-015)                                          */
/* -------------------------------------------------------------------------- */

/**
 * TODO(gateway-auth, FN-015): bank-BPP caller-authentication contract.
 *
 * Per-capability handlers in `./handlers/` (e.g. `issueCard`, `openChecking`)
 * accept an `AuthenticatedRequest<T>` envelope carrying a verified
 * `callerPubkey` produced by gateway-level BAP signature verification.
 *
 * The dispatcher MUST:
 *   1. Extract the verified caller pubkey from the inbound `TaskRequest`
 *      via {@link extractCallerPubkey}.
 *   2. Wrap the per-handler input in `{ callerPubkey, body: req.input }`
 *      before invoking the per-capability handler.
 *   3. Fail-closed with reason `"unauthorized_caller"` if `callerPubkey`
 *      is missing — this matches the per-handler gate in
 *      `assertCallerEquals` and surfaces a single canonical reason to the
 *      BAP regardless of which layer rejected the request.
 *
 * Today the per-capability handlers are still stubs (see `STUB_REASONS`),
 * and the BPP runtime's `TaskRequest` shape does NOT yet carry a
 * gateway-verified `callerPubkey` field — `req.bapPubkey` is informational
 * only until FN-073 / FN-075 wire BAP-signature verification at the
 * gateway. {@link extractCallerPubkey} therefore returns `undefined` for
 * every real request, and the dispatcher continues to short-circuit via
 * `STUB_REASONS` so existing flows are not broken pre-gateway-plumbing.
 *
 * @see FN-073 / FN-075 — gateway BAP-signature plumbing that will populate
 *   the verified caller pubkey on `TaskRequest`.
 * @see FN-034 — apply this contract to wire / offramp / onramp /
 *   open-savings handlers once the envelope is wired through here.
 */
export function extractCallerPubkey(
  req: TaskRequest<unknown>,
): string | undefined {
  // FN-073 / FN-075 will extend `TaskRequest` (or a sibling envelope) with
  // a verified `callerPubkey` field. Until then we read it defensively so
  // that test fixtures and future gateway plumbing can populate it without
  // requiring a synchronised type change here.
  const candidate = (req as { readonly callerPubkey?: unknown }).callerPubkey;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* createBankHandler                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Create a `BppHandler` that dispatches on `req.action` and returns
 * stub `not_implemented` failures for the five bank capabilities.
 *
 * Unknown actions return an `unknown_action` failure.
 *
 * See {@link extractCallerPubkey} and the FN-015 caller-authentication
 * contract for how this dispatcher will thread `callerPubkey` to
 * per-capability handlers once FN-073 / FN-075 land.
 */
export function createBankHandler(
  deps: BankHandlerDeps = {},
): BppHandler<unknown, unknown> {
  const _now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // Ensure _now is used (avoids unused-variable lint errors once real logic lands)
  void _now;

  return {
    async handleTask(
      req: TaskRequest<unknown>,
    ): Promise<TaskResult<unknown>> {
      const action = req.action;
      const callerPubkey = extractCallerPubkey(req);

      // Check if action is one of the known capability keys
      if ((BANK_CAPABILITY_KEYS as readonly string[]).includes(action)) {
        const key = action as BankCapabilityKey;
        // TODO(gateway-auth, FN-015): once per-capability handlers replace
        // their stub returns, wrap `req.input` as
        //   { callerPubkey, body: req.input }
        // and invoke the real handler. If `callerPubkey` is `undefined`
        // here, fail-closed with `UNAUTHORIZED_CALLER_REASON` BEFORE
        // calling the handler — the per-handler `assertCallerEquals`
        // gate is the second line of defence, not the first.
        void callerPubkey;
        return {
          status: "failure",
          reason: STUB_REASONS[key],
        };
      }

      // Unknown action
      return {
        status: "failure",
        reason: `unknown_action: ${action}`,
      };
    },
  };
}

// Re-export so downstream callers / tests can reference the canonical
// reason without reaching into `./auth.js` directly.
export { UNAUTHORIZED_CALLER_REASON };
