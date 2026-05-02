// Handlers barrel for the bank-as-BPP keeper module (FN-132 / T-3.13.1.3,
// FN-109 / T-3.10.2.4).
//
// Re-exports the public surface of all bank keeper handlers so downstream
// consumers can import from a single path:
//
//   import { runTax1099Sketch, tax1099SchemaIdHex, Tax1099SketchError }
//     from "@eto/mcp/keeper/bpps/bank/handlers";
//
//   import { oneBipFee, ONE_BIP_DIVISOR, BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
//             stubRemitToTreasury, type RemitToTreasury }
//     from "@eto/mcp/keeper/bpps/bank/handlers";

// FN-109: 1-pip fee math and treasury remittance
export {
  ONE_BIP_DIVISOR,
  BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
  oneBipFee,
  stubRemitToTreasury,
} from "./fee.js";
export type { RemitToTreasury, RemitArgs } from "./fee.js";

// FN-125: Issue Card BPP handler (v0 stub, T-3.12.1.2)
export {
  issueCard,
  stubs as issueCardStubs,
  IssueCardRejected,
  REQUIRED_SCHEMAS as ISSUE_CARD_REQUIRED_SCHEMAS,
} from "./issue-card.js";
export type {
  IssueCardRequest,
  IssueCardResult,
  IssueCardDeps,
  IssueCardRejectedReason,
  CardDebitCredentialBody,
  IssueCardCredential,
} from "./issue-card.js";

export {
  runTax1099Sketch,
  buildTax1099Vc,
  reduceAuditFeedToTotals,
  tax1099SchemaIdHex,
  Tax1099SketchError,
  defaultFirstSlotOfYear,
  DEFAULT_SLOTS_PER_YEAR,
} from "./tax-1099-sketch.js";
export type {
  Tax1099SketchDeps,
  Tax1099SketchRequest,
  Tax1099SketchResponse,
  Tax1099SketchErrorKind,
  Tax1099Totals,
  Tax1099VcEnvelope,
  IssueCredentialClient,
  VcPinner,
  SlotClock,
} from "./tax-1099-sketch.js";
