/**
 * BPP end-to-end test suite (FN-082, T-2.7.3.3).
 *
 * Exercises each of the five reference BPPs through one Beckn round-trip:
 *   credential gate → handler.handleTask → chain.completeTask
 *
 * Runs in-memory by default (hermetic CI). With `ETO_E2E=1` and
 * `mesh/start.sh` already running, the harness additionally connects to
 * the local testnet at `ETO_RPC_URL` (default `http://localhost:8899`).
 *
 * Usage:
 *   npm test -- tests/bpps/e2e.test.ts            # in-memory (CI)
 *   ETO_E2E=1 npm test -- tests/bpps/e2e.test.ts  # testnet variant
 */

import { describe, expect, it } from "vitest";
import {
  bapCardWithVerifiedHuman,
  bapCardWithoutVerifiedHuman,
} from "./fixtures/agent-cards.js";
import { VERIFIED_HUMAN_SCHEMA_HASH_HEX } from "./fixtures/credentials.js";
import { INIT_EVENTS, BPP_NAMES, type BppName } from "./fixtures/intents.js";
import { InMemoryChain } from "../../keeper/templates/bpp/runtime.js";
import { roundTripBpp } from "./harness.js";

/* -------------------------------------------------------------------------- */
/* Test timeout                                                               */
/* -------------------------------------------------------------------------- */

/** Per-test timeout: 30 s (the harness awaits runBpp which may spin stubs). */
const TEST_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Prefix of the verified-human schema hash used in gate denial reasons. */
const SCHEMA_PREFIX = VERIFIED_HUMAN_SCHEMA_HASH_HEX.slice(0, 8);

/* -------------------------------------------------------------------------- */
/* Positive round-trip: each BPP completes one task                          */
/* -------------------------------------------------------------------------- */

describe(
  "BPP e2e — each BPP completes one task",
  () => {
    it.each(BPP_NAMES)(
      "%s — positive round-trip (credential gate pass → completeTask)",
      async (bppName: BppName) => {
        const initEvent = INIT_EVENTS[bppName];

        const { chain, gateSpy } = await roundTripBpp({
          bppName,
          bapCard: bapCardWithVerifiedHuman,
        });

        // The chain should record exactly one successful completion.
        expect(chain.completed).toHaveLength(1);
        expect(chain.completed[0]!.taskId).toBe(initEvent.taskId);
        expect(chain.failed).toHaveLength(0);

        // The gate spy should have been called with the BAP pubkey from the event.
        expect(gateSpy).toHaveBeenCalledWith(initEvent.bapPubkey);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Negative case: credential gate denies a BAP without verified-human        */
/* -------------------------------------------------------------------------- */

describe(
  "BPP e2e — credential gate: deny BAP without verified-human credential",
  () => {
    it(
      "text-summarize — gate denial routes to failTask with correct reason",
      async () => {
        const { chain, gateSpy } = await roundTripBpp({
          bppName: "text-summarize",
          bapCard: bapCardWithoutVerifiedHuman,
        });

        // Gate denied → no completeTask call.
        expect(chain.completed).toHaveLength(0);

        // failTask should be called once with the denial reason.
        expect(chain.failed).toHaveLength(1);

        const failEntry = chain.failed[0]!;
        // Matches "credential_gate_denied: missing 1 required credential(s): <prefix>"
        expect(failEntry.reason).toMatch(/^credential_gate_denied: missing 1 /);
        // The schema truncation produces SCHEMA_PREFIX (first 8 hex chars).
        expect(failEntry.reason).toContain(SCHEMA_PREFIX);

        // The gate spy was still invoked with the BAP pubkey.
        const initEvent = INIT_EVENTS["text-summarize"];
        expect(gateSpy).toHaveBeenCalledWith(initEvent.bapPubkey);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Idempotency: duplicate Init event should be de-duped (TODO: FN-073)       */
/* -------------------------------------------------------------------------- */

describe(
  "BPP e2e — idempotency: duplicate Init event",
  () => {
    it.todo(
      "text-summarize — replaying the same Init event twice results in exactly one completeTask call" +
        " // TODO(FN-073): the FN-073 template does not yet de-dupe by task PDA; un-skip once it does",
    );
  },
);

/* -------------------------------------------------------------------------- */
/* ETO_E2E=1 guard                                                           */
/* -------------------------------------------------------------------------- */

// When ETO_E2E=1 is set but the RPC is unreachable we skip gracefully.
// The harness checks this flag inside roundTripBpp and adds the on-chain
// assertion branch. The in-memory variant above always runs.
if (process.env["ETO_E2E"] === "1") {
  describe("BPP e2e — testnet mode (ETO_E2E=1)", () => {
    it("note: on-chain CompleteTask tx assertion pending FN-073 RPC submitter", () => {
      // TODO(FN-073): wire RealChain adapter so the 5-account ordering
      // (auth, task, escrow, receiver_wallet, receiver_card) is asserted
      // per buildCompleteTaskTx in FN-080.
      console.log(
        "ETO_E2E=1 detected. Testnet assertions pending FN-073 real-RPC chain adapter.",
      );
      expect(true).toBe(true); // placeholder
    });
  });
}
