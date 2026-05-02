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
/* createBankHandler                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Create a `BppHandler` that dispatches on `req.action` and returns
 * stub `not_implemented` failures for the five bank capabilities.
 *
 * Unknown actions return an `unknown_action` failure.
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

      // Check if action is one of the known capability keys
      if ((BANK_CAPABILITY_KEYS as readonly string[]).includes(action)) {
        const key = action as BankCapabilityKey;
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
