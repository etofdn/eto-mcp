/**
 * AgentCard fixture snapshots for the BPP e2e test suite (FN-082).
 *
 * Two snapshots:
 *   - `bapCardWithVerifiedHuman`    — carries a valid verified-human credential
 *   - `bapCardWithoutVerifiedHuman` — empty credential list (gate should deny)
 */

import type { AgentCardSnapshot } from "../../../keeper/templates/bpp/types.js";
import { mintVerifiedHumanCred } from "./credentials.js";

export const BAP_WITH_CRED_PUBKEY =
  "BapWithVerifiedHumanPubkey11111111111111111111";

export const BAP_WITHOUT_CRED_PUBKEY =
  "BapWithoutVerifiedHumanPubkey1111111111111111";

/**
 * BAP AgentCard that holds a valid `verified-human` credential.
 * The credential is issued by `FAKE_ISSUER` and has no validity window
 * (validFrom=0, validUntil=0) so it passes `isActiveAt` regardless of now().
 */
export const bapCardWithVerifiedHuman: AgentCardSnapshot = {
  authority: BAP_WITH_CRED_PUBKEY,
  credentials: [mintVerifiedHumanCred(BAP_WITH_CRED_PUBKEY)],
};

/**
 * BAP AgentCard that holds NO credentials.
 * The credential gate should deny any BPP that requires `verified-human`.
 */
export const bapCardWithoutVerifiedHuman: AgentCardSnapshot = {
  authority: BAP_WITHOUT_CRED_PUBKEY,
  credentials: [],
};
