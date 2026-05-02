// Audit-trail indexer wire-format types (T-3.13.1.1, FN-130).
//
// These mirror the on-chain `KytTrace` / `RevocationRootUpdated` shapes
// (`src/runtime/src/programs/beckn/events.rs`, spec §9.3) as the
// JSON-friendly form an off-chain consumer would deserialize from
// `singularity:kyt:*` log lines or a JSON-RPC log payload.
//
// Off-chain encoding conventions:
//   - `tx_signature`: base58-encoded Solana signature (64 raw bytes).
//   - `authority`, `oracle`: base58 Solana pubkeys (32 raw bytes).
//   - `cred_pointer`: lowercase 64-char hex of
//        SHA256("eto.kyt.cred.v1" || schema || predicate_hash || issuer).
//   - `slot`: u64 chain slot (modeled as `number`; consumers MUST keep
//        slots within JS-safe-int range — Solana mainnet slot height
//        will not exceed 2^53 for the foreseeable future).
//   - `timestamp`: unix-seconds (`InitContext::now` / `ConfirmContext::now`).
//
// Validation lives alongside in zod schemas so the indexer can reject
// malformed events at ingest with a typed `AuditTrailIndexerError`.

import { z } from "zod";

// ---------------------------------------------------------------------
// Literal unions
// ---------------------------------------------------------------------

/** KYT lifecycle stage emitted by the on-chain Beckn handlers. */
export type KytStageWire = "init" | "confirm" | "rate";

/** Beckn counterparty role. BAP precedes BPP in the canonical trace. */
export type CounterpartyWire = "bap" | "bpp";

// ---------------------------------------------------------------------
// Validators (string shape primitives)
// ---------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RE = new RegExp(`^[${BASE58_ALPHABET}]+$`);
const HEX64_RE = /^[0-9a-f]{64}$/;

const base58String = z
  .string()
  .min(1)
  .refine((s) => BASE58_RE.test(s), { message: "expected base58 string" });

const credPointerHex = z
  .string()
  .refine((s) => HEX64_RE.test(s), {
    message: "expected lowercase 64-char hex (eto.kyt.cred.v1 pointer)",
  });

const slotNumber = z
  .number()
  .int()
  .nonnegative()
  .finite();

// ---------------------------------------------------------------------
// PartyTrace
// ---------------------------------------------------------------------

export const counterpartyWireSchema = z.union([
  z.literal("bap"),
  z.literal("bpp"),
]);

export const kytStageWireSchema = z.union([
  z.literal("init"),
  z.literal("confirm"),
  z.literal("rate"),
]);

export const partyTraceWireSchema = z.object({
  party: counterpartyWireSchema,
  authority: base58String,
  cred_pointers: z.array(credPointerHex),
});

export type PartyTraceWire = z.infer<typeof partyTraceWireSchema>;

// ---------------------------------------------------------------------
// KytTraceEvent
// ---------------------------------------------------------------------

export const kytTraceEventSchema = z
  .object({
    stage: kytStageWireSchema,
    tx_signature: base58String,
    slot: slotNumber,
    timestamp: z.number().int().nonnegative().finite(),
    parties: z
      .tuple([partyTraceWireSchema, partyTraceWireSchema])
      .refine(([a, b]) => a.party === "bap" && b.party === "bpp", {
        message: "parties MUST be ordered [bap, bpp] per spec §9.3",
      }),
  })
  .strict();

export type KytTraceEvent = z.infer<typeof kytTraceEventSchema>;

// ---------------------------------------------------------------------
// RevocationRootUpdatedEvent
// ---------------------------------------------------------------------

export const revocationRootUpdatedEventSchema = z
  .object({
    oracle: base58String,
    network: z.string().min(1),
    root: credPointerHex,
    leaves: z.number().int().nonnegative().finite(),
    slot: slotNumber,
  })
  .strict();

export type RevocationRootUpdatedEvent = z.infer<
  typeof revocationRootUpdatedEventSchema
>;
