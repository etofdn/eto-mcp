/**
 * Catalog projection helper for BPP capability tags (ADR-0001, FN-103).
 *
 * `projectCapabilityTags(tags)` converts a `CapabilityTags` object into a
 * `CatalogEntry` — the wire shape emitted in Beckn catalog/search responses.
 * It surfaces `tags.price.cents` in the response and, in dev/test mode,
 * asserts the invariant that `Number(amount) * 100 === cents` for 2-decimal
 * currencies (`ETO`, `EUSD`, `USD`).
 *
 * The assertion is guarded by `NODE_ENV !== "production"` so it fires during
 * unit tests and local runs but never blocks production traffic.
 */

import type { CapabilityTags } from "./types.js";

/** Two-decimal currencies where the minor-unit assertion applies. */
const TWO_DECIMAL_CURRENCIES = new Set(["ETO", "EUSD", "USD"]);

/**
 * Wire shape for a Beckn catalog/search item.  Extends the BPP-internal
 * `CapabilityTags` shape with an explicit `priceCents` integer field so
 * callers never have to parse the `amount` decimal themselves.
 */
export interface CatalogEntry {
  readonly domain: string;
  readonly action: string;
  readonly version: string;
  readonly price: {
    readonly amount: string;
    readonly currency: string;
    readonly cents: number;
  };
  readonly requiredCredentials: CapabilityTags["requiredCredentials"];
  readonly description: string;
}

/**
 * Project `CapabilityTags` → `CatalogEntry`.
 *
 * In non-production environments, asserts the dev-mode invariant:
 *   `Math.round(Number(amount) * 100) === cents`
 * for 2-decimal currencies (`ETO`, `EUSD`, `USD`) when both `amount` and
 * `cents` are present in `tags.price`.
 *
 * @throws {Error} In non-production if the invariant is violated.
 */
export function projectCapabilityTags(tags: CapabilityTags): CatalogEntry {
  const { price } = tags;

  if (process.env["NODE_ENV"] !== "production") {
    if (
      TWO_DECIMAL_CURRENCIES.has(price.currency) &&
      price.cents !== undefined
    ) {
      const derived = Math.round(Number(price.amount) * 100);
      if (derived !== price.cents) {
        throw new Error(
          `ADR-0001 invariant violated for ${tags.domain}:${tags.action}: ` +
          `Number("${price.amount}") * 100 = ${derived}, expected cents = ${price.cents}`,
        );
      }
    }
  }

  return {
    domain: tags.domain,
    action: tags.action,
    version: tags.version,
    price: {
      amount: price.amount,
      currency: price.currency,
      cents: price.cents,
    },
    requiredCredentials: tags.requiredCredentials,
    description: tags.description,
  };
}
