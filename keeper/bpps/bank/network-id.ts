/**
 * Inlined copy of `BANK_NETWORK_LABEL` + `computeBankNetworkId` from
 * `apps/issuer-admin/src/bank/init-network.ts` (FN-095). The original lives
 * in the OUTER `eto/` repo; eto-mcp's CI checks out only this repo, so the
 * cross-repo import broke `tests/unit/bank-bpp.test.ts` and `catalog.ts`
 * with `Failed to load url ../../../../apps/issuer-admin/...`.
 *
 * Keep the values byte-identical with the source file. If the canonical
 * label or hash function ever changes, update both files in lockstep.
 */
import { blake3 } from "@noble/hashes/blake3.js";

export const BANK_NETWORK_LABEL = "bank.eto.us-test";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function computeBankNetworkId(
  label: string = BANK_NETWORK_LABEL,
): Uint8Array {
  const out = blake3(utf8(label));
  if (out.length !== 32) {
    throw new Error(
      `internal: blake3 output expected 32 bytes, got ${out.length}`,
    );
  }
  return out;
}
