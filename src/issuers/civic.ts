// Civic fallback issuer (T-1.4.1.3, FN-039).
//
// See `spec/issuers/civic-integration.md` for the full design and
// `spec/issuers/worldcoin-integration.md` (FN-037 / FN-038) for the
// Worldcoin-side mirror — Civic is a *fallback* issuer for the same
// `verified-human` credential schema:
//
//   schema = sha256("eto.beckn.schema.verified-human.v1")
//   PDA    = ["cred", subject, issuer, schema]
//
// The shapes deliberately mirror the Worldcoin issuer (`NullifierStore`,
// `ChainClient`, `IssueCredentialArgs`, etc. — see `civic.types.ts`)
// so a future refactor can collapse them into a shared module.
//
// Flow (mirrors Worldcoin §5 with a Civic verifier swap):
//
//   1. Validate the request (Zod-ish runtime checks).
//   2. Compute `civicNullifier = sha256("eto.civic.verified-human.v1"
//                                       || base58Decode(gatewayToken))`.
//   3. Verify the Ed25519 wallet-binding signature over
//      `sha256(nullifierBytes || agentCardPubkeyBytes)`.
//   4. Dedupe lookup: same card hit → return prior binding with
//      `idempotent: true`; different card hit → 409
//      `NULLIFIER_BOUND_TO_OTHER_CARD`.
//   5. Verify the gateway token via the injected `CivicVerifier`.
//   6. Build the VC envelope, pin off-chain, hash to `claim_hash`.
//   7. Submit `IssueCredential`; on success, write the binding to the
//      store and return.
//
// SECURITY: never log or echo back the raw `gatewayToken` or any
// issuer keypair material. The `civicPassLevel` is the only Civic-side
// metadata that enters logs.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

import { computeClaimCommitments } from "./claim-commitments.js";
import type {
  AgentCardSignatureVerifier,
  ChainClient,
  CivicConfig,
  CivicIssueRequest,
  CivicIssueResponse,
  CivicIssuerDeps,
  CivicVerifier,
  CivicVerifyResult,
  ClaimHasher,
  IpfsPinner,
  IssuerLogger,
  NullifierBinding,
  NullifierStore,
  VerifiedHumanVc,
} from "./civic.types.js";
import { CivicIssuerError } from "./civic.types.js";

export * from "./civic.types.js";

// ---------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------

const CIVIC_NULLIFIER_PREFIX = "eto.civic.verified-human.v1";

/** On-chain `verified-human` schema id. Identical to Worldcoin's. */
export const VERIFIED_HUMAN_SCHEMA_ID: string = sha256Hex(
  utf8("eto.beckn.schema.verified-human.v1"),
);

const VALID_UNTIL_NO_BOUND = 0n;

// ---------------------------------------------------------------------
// Base58 (decode-only — Solana pubkeys / signatures)
// ---------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i += 1) {
    m[BASE58_ALPHABET[i]!] = i;
  }
  return m;
})();

/** Decode a base58 string into raw bytes. Throws on invalid input. */
export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros += 1;

  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i += 1) {
    const c = s[i]!;
    const v = BASE58_LOOKUP[c];
    if (v === undefined) {
      throw new Error(`base58: invalid character ${JSON.stringify(c)}`);
    }
    let carry = v;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[zeros + i] = bytes[bytes.length - 1 - i]!;
  }
  return out;
}

// ---------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

function sha256Hex(...parts: Uint8Array[]): string {
  return Buffer.from(sha256(...parts)).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex: odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------
// Civic nullifier
// ---------------------------------------------------------------------

/**
 * `civicNullifier = sha256("eto.civic.verified-human.v1" || base58Decode(gatewayToken))`.
 *
 * NOTE: the preimage is bound to the gateway token *only* — NOT to the
 * AgentCard. A single Civic Pass holder presenting the same gateway
 * token against two different cards must produce the *same* nullifier
 * so the dedupe store detects the cross-wallet replay (§6 of the spec).
 *
 * Returns 64-character lowercase hex.
 */
export function civicNullifierFromGatewayToken(gatewayToken: string): string {
  const tokBytes = base58Decode(gatewayToken);
  return sha256Hex(utf8(CIVIC_NULLIFIER_PREFIX), tokBytes);
}

// ---------------------------------------------------------------------
// Wallet-binding signature verifier (Ed25519)
// ---------------------------------------------------------------------

/**
 * Default `AgentCardSignatureVerifier` implementation backed by Node's
 * built-in WebCrypto Ed25519 (Node 18+). Resolves `false` on any
 * cryptographic or decoding error.
 */
export const ed25519SignatureVerifier: AgentCardSignatureVerifier = {
  async verify({ nullifier, agentCardPubkey, signature }) {
    try {
      const nullifierBytes = hexToBytes(nullifier);
      if (nullifierBytes.length !== 32) return false;
      const cardBytes = base58Decode(agentCardPubkey);
      if (cardBytes.length !== 32) return false;
      const sigBytes = Buffer.from(signature, "base64");
      if (sigBytes.length !== 64) return false;
      const message = sha256(nullifierBytes, cardBytes);
      // RFC 8410 Ed25519 SubjectPublicKeyInfo = 0x302a300506032b6570032100 || pubkey
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(cardBytes),
      ]);
      const key = createPublicKey({
        key: spki,
        format: "der",
        type: "spki",
      });
      return cryptoVerify(null, Buffer.from(message), key, sigBytes);
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------
// In-memory NullifierStore
// ---------------------------------------------------------------------

export class InMemoryNullifierStore implements NullifierStore {
  private readonly rows = new Map<string, NullifierBinding>();

  async get(nullifier: string): Promise<NullifierBinding | undefined> {
    return this.rows.get(nullifier);
  }

  async put(binding: NullifierBinding): Promise<void> {
    const existing = this.rows.get(binding.nullifier);
    if (existing && existing.agentCardPubkey !== binding.agentCardPubkey) {
      throw new CivicIssuerError(
        "NULLIFIER_BOUND_TO_OTHER_CARD",
        "nullifier already bound to a different AgentCard",
        409,
      );
    }
    this.rows.set(binding.nullifier, binding);
  }
}

// ---------------------------------------------------------------------
// Stub Civic verifier (tests only)
// ---------------------------------------------------------------------

export class StubCivicVerifier implements CivicVerifier {
  public calls: Array<{
    gatewayToken: string;
    expectedGatekeeperNetwork: string;
    expectedOwner: string;
  }> = [];

  public constructor(
    private readonly outcome: CivicVerifyResult | CivicIssuerError,
  ) {}

  async verifyGatewayToken(input: {
    gatewayToken: string;
    expectedGatekeeperNetwork: string;
    expectedOwner: string;
  }): Promise<CivicVerifyResult> {
    this.calls.push(input);
    if (this.outcome instanceof CivicIssuerError) throw this.outcome;
    return this.outcome;
  }
}

// ---------------------------------------------------------------------
// Default ClaimHasher (sha256(JCS(vc)))
// ---------------------------------------------------------------------

export const defaultClaimHasher: ClaimHasher = {
  hash(vcWithoutProof: Record<string, unknown>): string {
    const jcs = jcsCanonicalize(vcWithoutProof);
    return sha256Hex(utf8(jcs));
  },
};

/**
 * Minimal JCS (RFC 8785) canonicalisation sufficient for the VC shapes
 * this issuer emits: lexicographic key ordering over UTF-16 code units,
 * preserved array order, no insignificant whitespace, integers-only.
 */
export function jcsCanonicalize(value: unknown): string {
  return jcsStringify(value);
}

function jcsStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("jcsCanonicalize: non-finite number");
    }
    if (!Number.isInteger(value)) {
      throw new Error("jcsCanonicalize: non-integer numbers not supported");
    }
    return value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(jcsStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(jcsCompareUtf16);
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${jcsStringify(obj[k])}`,
    );
    return `{${parts.join(",")}}`;
  }
  throw new Error(`jcsCanonicalize: unsupported type ${typeof value}`);
}

function jcsCompareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------
// VC envelope
// ---------------------------------------------------------------------

interface BuildVcInput {
  readonly agentCardPubkey: string;
  readonly issuerAuthorityPubkey: string;
  readonly civicVerifyResult: CivicVerifyResult;
  readonly civicNullifier: string;
  readonly issuanceDate: string;
}

export function buildVerifiedHumanVc(input: BuildVcInput): VerifiedHumanVc {
  const evidenceEntry: Record<string, unknown> = {
    type: "CivicGatewayToken",
    tokenAddress: input.civicVerifyResult.tokenAddress,
    gatekeeperNetwork: input.civicVerifyResult.gatekeeperNetwork,
  };
  if (input.civicVerifyResult.civicPassLevel !== undefined) {
    evidenceEntry.civicPassLevel = input.civicVerifyResult.civicPassLevel;
  }
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/verified-human/v1",
    ],
    type: ["VerifiableCredential", "VerifiedHumanCredential"],
    issuer: "did:eto:civic",
    issuanceDate: input.issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.agentCardPubkey}`,
      type: "VerifiedHuman",
    },
    evidence: [evidenceEntry],
    issuerAuthority: input.issuerAuthorityPubkey,
    bridgeNullifier: input.civicNullifier,
  };
}

// ---------------------------------------------------------------------
// PDA derivation (mirrors Worldcoin)
// ---------------------------------------------------------------------

/**
 * Local PDA derivation: `["cred", subject, issuer, schema]` hashed
 * deterministically. Re-implemented here (no cross-import) so the
 * issuers stay independently versionable. The chain client returns
 * the authoritative PDA from the on-chain program; this helper is
 * used only for log lines / spec parity.
 */
export function deriveCredentialPda(
  subject: string,
  issuer: string,
  schemaHex: string,
): string {
  return sha256Hex(
    utf8("cred"),
    base58Decode(subject),
    base58Decode(issuer),
    hexToBytes(schemaHex),
  );
}

// ---------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------

function validateRequest(req: CivicIssueRequest): void {
  if (typeof req !== "object" || req === null) {
    throw new CivicIssuerError(
      "INVALID_AGENT_CARD_SIGNATURE",
      "request body is not an object",
      400,
    );
  }
  const failBadField = (msg: string): never => {
    throw new CivicIssuerError("INVALID_AGENT_CARD_SIGNATURE", msg, 400);
  };
  if (typeof req.gatewayToken !== "string" || req.gatewayToken.length === 0) {
    failBadField("gatewayToken must be a non-empty base58 string");
  }
  if (
    typeof req.agentCardPubkey !== "string" ||
    req.agentCardPubkey.length === 0
  ) {
    failBadField("agentCardPubkey must be a non-empty base58 string");
  }
  if (
    typeof req.agentCardSignature !== "string" ||
    req.agentCardSignature.length === 0
  ) {
    failBadField("agentCardSignature must be a non-empty base64 string");
  }
  // Sanity-check shapes early (length-bounded base58/base64).
  try {
    const card = base58Decode(req.agentCardPubkey);
    if (card.length !== 32) {
      failBadField("agentCardPubkey must decode to 32 bytes");
    }
    const sig = Buffer.from(req.agentCardSignature, "base64");
    if (sig.length !== 64) {
      failBadField("agentCardSignature must decode to 64 bytes");
    }
    base58Decode(req.gatewayToken); // throws on bad chars
  } catch (e) {
    if (e instanceof CivicIssuerError) throw e;
    throw new CivicIssuerError(
      "INVALID_AGENT_CARD_SIGNATURE",
      `request fields failed shape check: ${(e as Error).message}`,
      400,
    );
  }
  if (
    req.expectedGatekeeperNetwork !== undefined &&
    (typeof req.expectedGatekeeperNetwork !== "string" ||
      req.expectedGatekeeperNetwork.length === 0)
  ) {
    failBadField(
      "expectedGatekeeperNetwork, if present, must be non-empty base58",
    );
  }
}

// ---------------------------------------------------------------------
// CivicIssuer
// ---------------------------------------------------------------------

export class CivicIssuer {
  private readonly config: { readonly civic: CivicConfig };
  private readonly store: NullifierStore;
  private readonly chainClient: ChainClient;
  private readonly civicVerifier: CivicVerifier;
  private readonly signatureVerifier: AgentCardSignatureVerifier;
  private readonly ipfsPinner: IpfsPinner;
  private readonly claimHasher: ClaimHasher;
  private readonly issuerAuthorityPubkey: string;
  private readonly logger: IssuerLogger;
  private readonly nowUnix: () => number;
  private readonly randomBytes: ((len: number) => Uint8Array) | undefined;

  public constructor(deps: CivicIssuerDeps) {
    if (deps.config.civic.enabled === false) {
      throw new CivicIssuerError(
        "UPSTREAM_OUTAGE",
        "civic issuer disabled: set CIVIC_GATEKEEPER_NETWORK and CIVIC_ISSUER_KEYPAIR_PATH",
        503,
      );
    }
    this.config = deps.config;
    this.store = deps.store;
    this.chainClient = deps.chainClient;
    this.civicVerifier = deps.civicVerifier;
    this.signatureVerifier = deps.signatureVerifier;
    this.ipfsPinner = deps.ipfsPinner;
    this.claimHasher = deps.claimHasher;
    this.issuerAuthorityPubkey = deps.issuerAuthorityPubkey;
    this.logger = deps.logger ?? defaultLogger();
    this.nowUnix = deps.nowUnix ?? (() => Math.floor(Date.now() / 1000));
    this.randomBytes = deps.randomBytes;
  }

  public async issue(req: CivicIssueRequest): Promise<CivicIssueResponse> {
    // 1. Validate the request shape.
    validateRequest(req);

    // 2. Compute civic nullifier.
    const civicNullifier = civicNullifierFromGatewayToken(req.gatewayToken);

    // 3. Verify wallet-binding signature.
    const sigOk = await this.signatureVerifier.verify({
      nullifier: civicNullifier,
      agentCardPubkey: req.agentCardPubkey,
      signature: req.agentCardSignature,
    });
    if (!sigOk) {
      this.logger.warn({
        msg: "civic.issue.invalid_signature",
        agentCardPubkey: req.agentCardPubkey,
        civicNullifier,
      });
      throw new CivicIssuerError(
        "INVALID_AGENT_CARD_SIGNATURE",
        "agent card signature does not validate over sha256(nullifier || pubkey)",
        401,
      );
    }

    // 4. Dedupe lookup BEFORE hitting the third-party verifier — this
    //    short-circuits both idempotent re-issues and cross-wallet replays
    //    without leaking traffic to the upstream service.
    const existing = await this.store.get(civicNullifier);
    if (existing !== undefined) {
      if (existing.agentCardPubkey === req.agentCardPubkey) {
        this.logger.info({
          msg: "civic.issue.idempotent",
          civicNullifier,
          agentCardPubkey: req.agentCardPubkey,
        });
        return {
          credentialPda: existing.credentialPda,
          txSignature: existing.txSignature,
          claimUri: existing.claimUri,
          claimHash: existing.claimHash,
          idempotent: true,
        };
      }
      this.logger.warn({
        msg: "civic.issue.replay_conflict",
        civicNullifier,
        boundCard: existing.agentCardPubkey,
        requestedCard: req.agentCardPubkey,
      });
      throw new CivicIssuerError(
        "NULLIFIER_BOUND_TO_OTHER_CARD",
        "civic nullifier already bound to a different AgentCard",
        409,
      );
    }

    // 5. Verify gateway token via injected CivicVerifier.
    //    The verifier throws CivicIssuerError directly on any
    //    GATEWAY_TOKEN_* / UPSTREAM_OUTAGE failure.
    const verifyResult = await this.civicVerifier.verifyGatewayToken({
      gatewayToken: req.gatewayToken,
      expectedGatekeeperNetwork:
        req.expectedGatekeeperNetwork ?? this.config.civic.gatekeeperNetwork,
      expectedOwner: req.agentCardPubkey,
    });

    // 6. Build VC, embed §10.3.1 claimCommitments, pin, hash.
    const issuanceDate = new Date(this.nowUnix() * 1000).toISOString();
    const baseVc = buildVerifiedHumanVc({
      agentCardPubkey: req.agentCardPubkey,
      issuerAuthorityPubkey: this.issuerAuthorityPubkey,
      civicVerifyResult: verifyResult,
      civicNullifier,
      issuanceDate,
    });
    const claimCommitments = computeClaimCommitments(
      baseVc.credentialSubject as Record<string, unknown>,
      { randomBytes: this.randomBytes },
    );
    const vc = { ...baseVc, claimCommitments } as VerifiedHumanVc & {
      claimCommitments: typeof claimCommitments;
    };
    const claimHash = this.claimHasher.hash(vc);
    const claimJcs = jcsCanonicalize(vc);
    const { uri: claimUri } = await this.ipfsPinner.pin(claimJcs);

    // 7. Submit IssueCredential.
    const validFromSlot = (await this.chainClient.currentSlot?.()) ?? 0n;
    let chainResult;
    try {
      chainResult = await this.chainClient.issueCredential({
        subjectAgentCard: req.agentCardPubkey,
        schema: VERIFIED_HUMAN_SCHEMA_ID,
        claimUri,
        claimHash,
        validFromSlot,
        validUntilSlot: VALID_UNTIL_NO_BOUND,
        idempotencyKey: `civic:${civicNullifier}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({
        msg: "civic.issue.chain_failed",
        civicNullifier,
        agentCardPubkey: req.agentCardPubkey,
        error: message,
      });
      throw new CivicIssuerError(
        "CHAIN_TX_FAILED",
        `IssueCredential tx failed: ${message}`,
        502,
      );
    }

    const binding: NullifierBinding = {
      nullifier: civicNullifier,
      agentCardPubkey: req.agentCardPubkey,
      credentialPda: chainResult.credentialPda,
      txSignature: chainResult.txSignature,
      claimUri,
      claimHash,
    };
    await this.store.put(binding);

    this.logger.info({
      msg: "civic.issue.success",
      civicNullifier,
      agentCardPubkey: req.agentCardPubkey,
      credentialPda: chainResult.credentialPda,
      civicPassLevel: verifyResult.civicPassLevel,
    });

    return {
      credentialPda: chainResult.credentialPda,
      txSignature: chainResult.txSignature,
      claimUri,
      claimHash,
      idempotent: false,
    };
  }
}

function defaultLogger(): IssuerLogger {
  return {
    info: (r) => console.log(JSON.stringify({ level: "info", ...r })),
    warn: (r) => console.warn(JSON.stringify({ level: "warn", ...r })),
    error: (r) => console.error(JSON.stringify({ level: "error", ...r })),
  };
}
