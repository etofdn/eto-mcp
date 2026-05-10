// Travel-rule report generator wire-format types (T-3.13.1.4, FN-133).
//
// IVMS101-lite shapes used by the FATF-style JSON-LD report generator.
// Field names are lowerCamelCase to match the rest of the package (NOT
// IVMS101's PascalCase XML idiom). Jurisdiction codes follow ISO-3166-1
// α-2 uppercase convention (as used in banking-credentials schema).

import { z } from "zod";

// ---------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------

// Redeclare base58 regex locally — do NOT re-export or import from
// audit-trail.types.ts to keep modules decoupled.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

const base58String = z
  .string()
  .min(1)
  .refine((s) => BASE58_RE.test(s), { message: "expected base58 string" });

// ISO-3166-1 α-2 uppercase jurisdiction code (e.g. "US", "DE", "SG").
const JURISDICTION_RE = /^[A-Z]{2}$/;

/**
 * Branded ISO-3166-1 α-2 uppercase string (e.g. `"US"`, `"DE"`).
 * Validated by zod as exactly two uppercase ASCII letters.
 */
export type JurisdictionCode = string & { __brand: "JurisdictionCode" };

export const jurisdictionCodeSchema = z
  .string()
  .refine((s) => JURISDICTION_RE.test(s), {
    message: "expected ISO-3166-1 α-2 uppercase code (e.g. US)",
  })
  .transform((s) => s as JurisdictionCode);

// ---------------------------------------------------------------------
// Party name
// ---------------------------------------------------------------------

export const ivms101NaturalNameSchema = z.object({
  kind: z.literal("natural"),
  primary: z.string().min(1),
  secondary: z.string().min(1).optional(),
});

export type Ivms101NaturalName = z.infer<typeof ivms101NaturalNameSchema>;

export const ivms101LegalNameSchema = z.object({
  kind: z.literal("legal"),
  name: z.string().min(1),
});

export type Ivms101LegalName = z.infer<typeof ivms101LegalNameSchema>;

/**
 * Discriminated union of human (`"natural"`) and corporate (`"legal"`)
 * name shapes, keyed on `kind`.
 */
export const ivms101PartyNameSchema = z.discriminatedUnion("kind", [
  ivms101NaturalNameSchema,
  ivms101LegalNameSchema,
]);

export type Ivms101PartyName = z.infer<typeof ivms101PartyNameSchema>;

// ---------------------------------------------------------------------
// Geographic address
// ---------------------------------------------------------------------

export const ivms101GeographicAddressSchema = z.object({
  country: jurisdictionCodeSchema,
  addressLine: z.string().min(1).optional(),
  townName: z.string().min(1).optional(),
  postCode: z.string().min(1).optional(),
});

export type Ivms101GeographicAddress = z.infer<
  typeof ivms101GeographicAddressSchema
>;

// ---------------------------------------------------------------------
// National identification
// ---------------------------------------------------------------------

export const ivms101NationalIdentificationSchema = z.object({
  idType: z.enum(["passport", "driverLicense", "nationalId", "tin", "other"]),
  idNumber: z.string().min(1),
  issuingCountry: jurisdictionCodeSchema,
});

export type Ivms101NationalIdentification = z.infer<
  typeof ivms101NationalIdentificationSchema
>;

// ---------------------------------------------------------------------
// Party record
// ---------------------------------------------------------------------

/**
 * IVMS101-lite party record. The `authority` field is the base58
 * AgentCard authority pubkey — it joins the record back to the on-chain
 * event. `accountNumber` is a VASP-internal account reference (free-form
 * string; production wiring will supply the actual account id).
 */
export const ivms101PartySchema = z.object({
  /** Base58 AgentCard authority — links back to the on-chain event. */
  authority: base58String,
  /** VASP-internal account identifier (free-form). */
  accountNumber: z.string().min(1),
  name: ivms101PartyNameSchema,
  jurisdiction: jurisdictionCodeSchema,
  address: ivms101GeographicAddressSchema.optional(),
  nationalId: ivms101NationalIdentificationSchema.optional(),
});

export type Ivms101Party = z.infer<typeof ivms101PartySchema>;

// ---------------------------------------------------------------------
// Directory / resolver entry schemas (used for in-memory validation)
// ---------------------------------------------------------------------

/**
 * Schema for a single entry in an `InMemoryPartyDirectory` initialiser.
 * Keys are base58 authority strings; values are `Ivms101Party` records.
 */
export const partyDirectoryEntrySchema = ivms101PartySchema;

export const amountResolverEntrySchema = z.object({
  amountUsd: z.number().nonnegative().finite(),
  /**
   * On-chain settlement asset symbol (e.g. `"eUSD"`, `"USDC"`). Non-empty
   * string; mixed case is allowed to support tokens like `"eUSD"` whose
   * standard ticker has a lowercase prefix.
   */
  currency: z.string().min(1),
});

export type AmountResolverEntry = z.infer<typeof amountResolverEntrySchema>;
