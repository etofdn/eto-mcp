// Barrel re-export for the audit-trail indexer (T-3.13.1.1, FN-130),
// the Postgres-backed event source (FN-083),
// and the travel-rule report generator (T-3.13.1.4, FN-133).

export * from "./audit-trail.js";
export { PostgresKytEventSource, createKytEventSourceFromEnv } from "./postgres-event-source.js";
export type { PostgresKytEventSourceInit } from "./postgres-event-source.js";
export * from "./travel-rule.js";

// FN-084: Ed25519 VC signing for the audit-trail / travel-rule indexers.
export {
  Ed25519VcSigner,
  NoOpVcSigner,
  createVcSignerFromEnv,
  proofPreimage,
} from "./vc-signer.js";
export type {
  CreateVcSignerFromEnvOpts,
  Ed25519Signature2020Proof,
  Ed25519VcSignerFromKeyFileInit,
  Ed25519VcSignerInit,
  VcSigner,
} from "./vc-signer.js";
export {
  Ed25519VcSigner,
  NoOpVcSigner,
  createVcSignerFromEnv,
  proofPreimage,
} from "./vc-signer.js";
export type {
  CreateVcSignerFromEnvOpts,
  Ed25519Signature2020Proof,
  Ed25519VcSignerFromKeyFileInit,
  Ed25519VcSignerInit,
  VcSigner,
} from "./vc-signer.js";
