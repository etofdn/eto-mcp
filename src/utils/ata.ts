// Solana-compatible PDA + Associated-Token-Account derivation in TypeScript.
// Mirrors `Pubkey::find_program_address(seeds, program_id)` from the Rust runtime
// (see runtime/src/programs/associated_token.rs).
import { sha256 } from "@noble/hashes/sha256";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";

// Constants pulled from runtime/src/programs/associated_token.rs and token.rs.
// Real-Solana addresses for parity with mainnet tooling.
export const ATA_PROGRAM_ID = new Uint8Array([
  0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d, 0x83,
  0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9, 0xf8, 0x59,
]);

export const TOKEN_PROGRAM_ID_BYTES = bs58.decode(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    // @noble/ed25519 throws when the point is not a valid curve point.
    ed.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Solana-style PDA derivation: try bumps 255..=0; for each, sha256 the seed
 * material concatenated with the bump and the program ID. If the resulting 32
 * bytes are NOT on the ed25519 curve they qualify as a valid PDA.
 */
export function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): { address: Uint8Array; bump: number } {
  if (programId.length !== 32) {
    throw new Error("programId must be 32 bytes");
  }
  for (const seed of seeds) {
    if (seed.length > 32) {
      throw new Error("max seed length is 32 bytes");
    }
  }

  for (let bump = 255; bump >= 0; bump--) {
    const parts: Uint8Array[] = [...seeds, new Uint8Array([bump]), programId, PDA_MARKER];
    let total = 0;
    for (const p of parts) total += p.length;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.length;
    }
    const hash = sha256(buf);
    if (!isOnCurve(hash)) {
      return { address: hash, bump };
    }
  }
  throw new Error("Unable to find a valid program address");
}

/**
 * SPL Associated Token Account derivation:
 * PDA([wallet, TOKEN_PROGRAM_ID, mint], ATA_PROGRAM_ID)
 */
export function deriveAta(walletBase58: string, mintBase58: string): { address: string; bump: number } {
  const wallet = bs58.decode(walletBase58);
  const mint = bs58.decode(mintBase58);
  if (wallet.length !== 32) throw new Error(`Invalid wallet pubkey length: ${wallet.length}`);
  if (mint.length !== 32) throw new Error(`Invalid mint pubkey length: ${mint.length}`);

  const { address, bump } = findProgramAddress(
    [wallet, TOKEN_PROGRAM_ID_BYTES, mint],
    ATA_PROGRAM_ID
  );
  return { address: bs58.encode(address), bump };
}

/**
 * Build an unsigned transaction that runs AtaProgram::CreateIdempotent for
 * (wallet, mint). Used to materialize the ATA before SPL MintTo / Transfer
 * (which require the destination token account to already exist).
 *
 * Account layout (from runtime/src/programs/associated_token.rs):
 *   0. [signer, writable] payer
 *   1. [writable]         ATA (derived)
 *   2. []                 wallet (owner of the ATA)
 *   3. []                 mint
 *   4. []                 system program (id = [0;32])
 *   5. []                 token program
 *
 * Borsh: AtaInstruction::CreateIdempotent is the second variant → tag = 1.
 */
const SYSTEM_PROGRAM_ID = new Uint8Array(32);

export function buildCreateAtaIdempotentTx(
  payerBase58: string,
  walletBase58: string,
  mintBase58: string,
  recentBlockhashBase58: string
): { txBytes: Uint8Array; ata: string } {
  const payer = bs58.decode(payerBase58);
  const wallet = bs58.decode(walletBase58);
  const mint = bs58.decode(mintBase58);
  const recentBlockhash = bs58.decode(recentBlockhashBase58);
  const ata = bs58.decode(deriveAta(walletBase58, mintBase58).address);

  // Message header: 1 signer (payer), 0 readonly signed, 4 readonly unsigned
  // (wallet, mint, system, token; the ATA is the only writable non-signer).
  const accountKeys = [payer, ata, wallet, mint, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID_BYTES, ATA_PROGRAM_ID];
  const programIdIndex = 6;
  const accountIndices = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const data = new Uint8Array([1]); // CreateIdempotent variant tag

  const sigCount = 1;
  const buf: number[] = [];
  // Header
  buf.push(sigCount, 0, 4);
  // Account keys (count + 32B each)
  pushU32(buf, accountKeys.length);
  for (const k of accountKeys) for (const b of k) buf.push(b);
  // Recent blockhash
  for (const b of recentBlockhash) buf.push(b);
  // Instructions (1)
  pushU32(buf, 1);
  buf.push(programIdIndex);
  pushU32(buf, accountIndices.length);
  for (const b of accountIndices) buf.push(b);
  pushU32(buf, data.length);
  for (const b of data) buf.push(b);

  // Wrap in transaction (sigCount + zeroed sig + message)
  const msg = new Uint8Array(buf);
  const tx = new Uint8Array(4 + sigCount * 64 + msg.length);
  pushU32Inplace(tx, 0, sigCount);
  // signature slots already zeroed
  tx.set(msg, 4 + sigCount * 64);
  return { txBytes: tx, ata: deriveAta(walletBase58, mintBase58).address };
}

function pushU32(buf: number[], n: number): void {
  buf.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}
function pushU32Inplace(arr: Uint8Array, off: number, n: number): void {
  arr[off] = n & 0xff;
  arr[off + 1] = (n >>> 8) & 0xff;
  arr[off + 2] = (n >>> 16) & 0xff;
  arr[off + 3] = (n >>> 24) & 0xff;
}
