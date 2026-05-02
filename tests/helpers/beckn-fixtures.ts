/**
 * Beckn v2.0 LTS fixture helpers for the bridge conformance suite (FN-092).
 *
 * # Type design
 *
 * `BecknContext.action` is narrowed to `BecknAction = "search" | "select" |
 * "init" | "confirm"` (the four forward actions). Beckn callback envelopes use
 * `"on_search" | "on_select" | "on_init" | "on_confirm"` which are NOT in that
 * union. To avoid TypeScript errors when loading callback fixtures we define a
 * separate `CallbackAction` union and a wider `AnyBecknEnvelope` type that the
 * forward helpers (loadFixture, freshContext, withMutation) accept for both
 * shapes.
 *
 * Source: https://developers.becknprotocol.io/docs/protocol-specifications/
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BecknAction, BecknContext, BecknRequest } from "../../src/gateway/beckn.js";

// ---------- Extended types ----------

/** The four Beckn callback (BPP→BAP) action strings. */
export type CallbackAction = "on_search" | "on_select" | "on_init" | "on_confirm";

/** Union of all eight supported action strings. */
export type AnyBecknAction = BecknAction | CallbackAction;

/**
 * Beckn context that allows both forward and callback action strings.
 * Structurally identical to BecknContext but with a wider `action` field.
 */
export type AnyBecknContext = Omit<BecknContext, "action"> & { action: AnyBecknAction };

/**
 * A Beckn envelope that covers both forward (`search`/`select`/`init`/`confirm`)
 * and callback (`on_*`) shapes. Use `BecknRequest` when the caller needs the
 * narrower forward-action type.
 */
export interface AnyBecknEnvelope {
  context: AnyBecknContext;
  message: unknown;
}

// ---------- File resolution ----------

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/beckn",
);

function fixturePath(name: string): string {
  // Accept either "search" or "search.json"
  const filename = name.endsWith(".json") ? name : `${name}.json`;
  return resolve(FIXTURE_DIR, filename);
}

// ---------- Public API ----------

/**
 * Load a named Beckn fixture from `tests/fixtures/beckn/`.
 *
 * @param name - Fixture name with or without `.json` extension.
 *   E.g. `"search"`, `"on_search"`, `"malformed-missing-context"`.
 * @returns The parsed envelope as `AnyBecknEnvelope`.
 *
 * Note: The JSON files include a `_source` and `_note` commentary field; these
 * are stripped from the returned object so callers receive a clean envelope.
 */
export function loadFixture(name: string): AnyBecknEnvelope {
  const raw = JSON.parse(readFileSync(fixturePath(name), "utf8")) as Record<
    string,
    unknown
  >;
  // Strip commentary keys
  const { _source: _s, _note: _n, ...envelope } = raw;
  return envelope as unknown as AnyBecknEnvelope;
}

/**
 * Build a fresh Beckn context object with newly generated UUIDs and the current
 * ISO-8601 timestamp. Suitable as the base for constructing test envelopes.
 *
 * @param action - Any supported Beckn action, including `"on_*"` callbacks.
 * @param overrides - Optional partial overrides merged into the returned context.
 */
export function freshContext(
  action: AnyBecknAction,
  overrides: Partial<AnyBecknContext> = {},
): AnyBecknContext {
  return {
    domain: "retail",
    action,
    version: "2.0.0",
    bap_id: "bap.example.com",
    bap_uri: "https://bap.example.com/beckn",
    transaction_id: randomUUID(),
    message_id: randomUUID(),
    timestamp: new Date().toISOString(),
    ttl: "PT30S",
    ...overrides,
  };
}

/**
 * Deep-merge `patch` into `envelope`, returning a new object without mutating
 * the original. The merge is recursive so nested objects (e.g. `context`) are
 * properly merged rather than replaced wholesale.
 *
 * Type safety: the return type widens to `AnyBecknEnvelope` to accommodate
 * both forward and callback envelopes and partial override shapes.
 */
export function withMutation(
  envelope: AnyBecknEnvelope,
  patch: DeepPartial<AnyBecknEnvelope>,
): AnyBecknEnvelope {
  return deepMerge(envelope, patch) as AnyBecknEnvelope;
}

// ---------- Internal helpers ----------

/** Recursive partial utility — mirrors lodash DeepPartial. */
type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Recursive deep merge. Arrays are replaced (not concatenated) to keep the
 * merge semantics simple and predictable for fixture overrides.
 */
function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    // If either is not a plain object, the source wins (or target if source is
    // undefined).
    return (source === undefined ? target : source) as T;
  }

  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const srcVal = (source as Record<string, unknown>)[key];
    const tgtVal = (target as Record<string, unknown>)[key];
    result[key] = isPlainObject(tgtVal) && isPlainObject(srcVal)
      ? deepMerge(tgtVal, srcVal as DeepPartial<typeof tgtVal>)
      : srcVal;
  }
  return result as T;
}

// ---------- Convenience re-export of forward-action builder ----------

/**
 * Build a minimal valid forward-action envelope (BAP→BPP direction) with a
 * fresh context. The `message` defaults to `{ intent: {} }` for `search`, or
 * `{ order: {} }` for the other three.
 */
export function freshEnvelope(
  action: BecknAction,
  contextOverrides: Partial<AnyBecknContext> = {},
  message?: unknown,
): BecknRequest {
  const ctx = freshContext(action, contextOverrides);
  const defaultMessage = action === "search" ? { intent: {} } : { order: {} };
  return {
    context: ctx as BecknContext,
    message: message ?? defaultMessage,
  };
}
