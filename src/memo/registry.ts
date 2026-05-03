/**
 * Runtime registry for memo payload schemas.
 *
 * Loads the JSON Schema files under `spec/memo-schemas/` at module init,
 * compiles them with a single Ajv 2020 instance (Draft 2020-12 + ajv-formats),
 * and exposes lookup helpers keyed by the `(schema, v)` tuple. See
 * `docs/memo-schema-registry.md` §5/§6.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Ajv ships its 2020-12 entry under `ajv/dist/2020.js`. Importing the default
// export keeps strict-mode validation aligned with the rest of the codebase
// (see `src/gateway/beckn-schemas.ts`).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

import { ENVELOPE_SCHEMA } from "./envelope.js";

// `ajv/dist/2020.js` exports a default class; the named import is needed for
// proper interop under Node ESM. Cast through `unknown` because ajv's CJS
// types don't model the dist entry.
const AjvCtor = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ??
  (Ajv2020 as unknown as new (opts: Record<string, unknown>) => InstanceType<typeof Ajv2020>);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv: any = new (AjvCtor as any)({ strict: true, allErrors: true });
addFormats(ajv);

export const envelopeValidator: ValidateFunction = ajv.compile(ENVELOPE_SCHEMA);

/**
 * Map of full schema label (e.g. `eto.memo.eval_score.v1`) → compiled
 * payload validator. Keyed by the canonical label string so lookup is O(1)
 * regardless of how many versions a single `type` accumulates over time.
 */
const validators = new Map<string, ValidateFunction>();

/**
 * Map of `<type>` → highest registered major version. Drives the §6
 * "unknown future v → opaque" rule.
 */
const highestVersion = new Map<string, number>();

function registerSchemaFile(file: string, label: string, type: string, v: number): void {
  // Source layout: src/memo/registry.ts → repo root → spec/memo-schemas/<file>
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const path = resolve(repoRoot, "spec", "memo-schemas", file);
  const raw = readFileSync(path, "utf8");
  const schema = JSON.parse(raw);
  const validate = ajv.compile(schema);
  validators.set(label, validate);
  const prev = highestVersion.get(type) ?? 0;
  if (v > prev) highestVersion.set(type, v);
}

// Register the v1 payload schemas. See §4 of the registry doc.
registerSchemaFile("eval_score.v1.json", "eto.memo.eval_score.v1", "eval_score", 1);
registerSchemaFile("payment.v1.json", "eto.memo.payment.v1", "payment", 1);
registerSchemaFile(
  "coordination_log.v1.json",
  "eto.memo.coordination_log.v1",
  "coordination_log",
  1,
);

/** Returns the compiled payload validator for `(schema, v)`, or undefined. */
export function getPayloadValidator(
  schema: string,
  v: number,
): ValidateFunction | undefined {
  // The label already encodes the version (`...v<N>`), so we mostly just
  // need to look it up. Defensive: also accept callers that pass the
  // version separately and match it against the suffix.
  const validator = validators.get(schema);
  if (!validator) return undefined;
  const suffix = schema.match(/\.v(\d+)$/);
  if (!suffix || Number(suffix[1]) !== v) return undefined;
  return validator;
}

/**
 * Highest known version for a `<type>` discriminator, or `undefined` if
 * the registry has no schema registered for that type at all.
 */
export function highestKnownVersion(type: string): number | undefined {
  return highestVersion.get(type);
}

/** Test-only: returns the set of registered schema labels. */
export function _registeredLabels(): string[] {
  return Array.from(validators.keys()).sort();
}
