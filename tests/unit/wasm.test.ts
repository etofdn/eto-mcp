import { describe, test, expect } from "bun:test";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  buildTransferTx,
  buildCreateAccountTx,
  buildTokenTransferTx,
  findPda,
  generateKeypair,
} from "../../src/wasm/index.js";

// Configure ed25519 sync sha512
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// Known valid base58 pubkeys for testing
const FROM = "11111111111111111111111111111112"; // bs58 of [0..0,1]
const TO   = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"; // arbitrary valid

function makeValidPubkey(): string {
  const key = ed.utils.randomPrivateKey();
  const pub = ed.getPublicKey(key);
  return bs58.encode(pub);
}

const BLOCKHASH = "11111111111111111111111111111112";

// Parse a serialized unsigned transaction:
// [u32 LE sigCount] [sigCount*64 bytes] [message bytes]
// message: [3 header bytes] [u32 LE accountKeyCount] [accountKeyCount*32 bytes]
//          [32 bytes blockhash] [u32 LE ixCount] [instructions...]
function parseTransaction(tx: Uint8Array) {
  let offset = 0;
  const view = new DataView(tx.buffer, tx.byteOffset, tx.byteLength);

  const sigCount = view.getUint32(offset, true);
  offset += 4;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < sigCount; i++) {
    signatures.push(tx.slice(offset, offset + 64));
    offset += 64;
  }

  // Message header
  const numRequiredSignatures = tx[offset++];
  const numReadonlySigned = tx[offset++];
  const numReadonlyUnsigned = tx[offset++];

  // Account keys
  const accountKeyCount = view.getUint32(offset, true);
  offset += 4;
  const accountKeys: Uint8Array[] = [];
  for (let i = 0; i < accountKeyCount; i++) {
    accountKeys.push(tx.slice(offset, offset + 32));
    offset += 32;
  }

  // Blockhash
  const blockhash = tx.slice(offset, offset + 32);
  offset += 32;

  // Instructions
  const ixCount = view.getUint32(offset, true);
  offset += 4;
  const instructions = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = tx[offset++];
    const accountsLen = view.getUint32(offset, true);
    offset += 4;
    const accounts = tx.slice(offset, offset + accountsLen);
    offset += accountsLen;
    const dataLen = view.getUint32(offset, true);
    offset += 4;
    const data = tx.slice(offset, offset + dataLen);
    offset += dataLen;
    instructions.push({ programIdIndex, accounts, data });
  }

  return { sigCount, signatures, numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned, accountKeys, blockhash, instructions };
}

describe("buildTransferTx", () => {
  test("returns Uint8Array with valid Borsh encoding", () => {
    const from = makeValidPubkey();
    const to = makeValidPubkey();
    const tx = buildTransferTx(from, to, 1_000_000n, BLOCKHASH);
    expect(tx).toBeInstanceOf(Uint8Array);
    expect(tx.length).toBeGreaterThan(0);
  });

  test("has 1 signature slot (zeroed)", () => {
    const from = makeValidPubkey();
    const to = makeValidPubkey();
    const tx = buildTransferTx(from, to, 1_000_000n, BLOCKHASH);
    const parsed = parseTransaction(tx);
    expect(parsed.sigCount).toBe(1);
    expect(parsed.signatures[0].every(b => b === 0)).toBe(true);
  });

  test("message header has numRequiredSignatures=1", () => {
    const from = makeValidPubkey();
    const to = makeValidPubkey();
    const tx = buildTransferTx(from, to, 1_000_000n, BLOCKHASH);
    const parsed = parseTransaction(tx);
    expect(parsed.numRequiredSignatures).toBe(1);
  });

  test("instruction data starts with u32 LE = 2 (transfer discriminator)", () => {
    const from = makeValidPubkey();
    const to = makeValidPubkey();
    const tx = buildTransferTx(from, to, 5_000n, BLOCKHASH);
    const parsed = parseTransaction(tx);
    const data = parsed.instructions[0].data;
    // First 4 bytes: u32 LE = 2
    const discriminator = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    expect(discriminator).toBe(2);
  });

  test("instruction data encodes lamports correctly as u64 LE", () => {
    const from = makeValidPubkey();
    const to = makeValidPubkey();
    const lamports = 123_456_789n;
    const tx = buildTransferTx(from, to, lamports, BLOCKHASH);
    const parsed = parseTransaction(tx);
    const data = parsed.instructions[0].data;
    // bytes 4..12 are u64 LE lamports
    let val = 0n;
    for (let i = 0; i < 8; i++) {
      val |= BigInt(data[4 + i]) << BigInt(8 * i);
    }
    expect(val).toBe(lamports);
  });

  test("has 3 account keys: from, to, system program", () => {
    const from = makeValidPubkey();
    const to = makeValidPubkey();
    const tx = buildTransferTx(from, to, 1n, BLOCKHASH);
    const parsed = parseTransaction(tx);
    expect(parsed.accountKeys.length).toBe(3);
    // Third key is system program (all zeros)
    expect(parsed.accountKeys[2].every(b => b === 0)).toBe(true);
  });
});

describe("buildCreateAccountTx", () => {
  test("returns Uint8Array", () => {
    const payer = makeValidPubkey();
    const newAcc = makeValidPubkey();
    const owner = makeValidPubkey();
    const tx = buildCreateAccountTx(payer, newAcc, 1_000_000n, 165n, owner, BLOCKHASH);
    expect(tx).toBeInstanceOf(Uint8Array);
  });

  test("has numRequiredSignatures=2 in message header (payer + newAccount)", () => {
    const payer = makeValidPubkey();
    const newAcc = makeValidPubkey();
    const owner = makeValidPubkey();
    const tx = buildCreateAccountTx(payer, newAcc, 1_000_000n, 165n, owner, BLOCKHASH);
    const parsed = parseTransaction(tx);
    // The serialized transaction has 1 placeholder sig slot but the message header
    // encodes numRequiredSignatures=2 (payer + newAccount must both sign)
    expect(parsed.numRequiredSignatures).toBe(2);
  });

  test("instruction data starts with u32 LE = 0 (createAccount discriminator)", () => {
    const payer = makeValidPubkey();
    const newAcc = makeValidPubkey();
    const owner = makeValidPubkey();
    const tx = buildCreateAccountTx(payer, newAcc, 1_000_000n, 165n, owner, BLOCKHASH);
    const parsed = parseTransaction(tx);
    const data = parsed.instructions[0].data;
    const discriminator = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    expect(discriminator).toBe(0);
  });

  test("instruction data encodes space correctly", () => {
    const payer = makeValidPubkey();
    const newAcc = makeValidPubkey();
    const owner = makeValidPubkey();
    const space = 256n;
    const tx = buildCreateAccountTx(payer, newAcc, 1_000_000n, space, owner, BLOCKHASH);
    const parsed = parseTransaction(tx);
    const data = parsed.instructions[0].data;
    // bytes 12..20 are u64 LE space
    let val = 0n;
    for (let i = 0; i < 8; i++) {
      val |= BigInt(data[12 + i]) << BigInt(8 * i);
    }
    expect(val).toBe(space);
  });

  test("uses system program (index 2 account key, all zeros)", () => {
    const payer = makeValidPubkey();
    const newAcc = makeValidPubkey();
    const owner = makeValidPubkey();
    const tx = buildCreateAccountTx(payer, newAcc, 1_000_000n, 165n, owner, BLOCKHASH);
    const parsed = parseTransaction(tx);
    expect(parsed.accountKeys[2].every(b => b === 0)).toBe(true);
  });
});

describe("buildTokenTransferTx", () => {
  test("returns Uint8Array", () => {
    const auth = makeValidPubkey();
    const src = makeValidPubkey();
    const dst = makeValidPubkey();
    const tx = buildTokenTransferTx(auth, src, dst, 1_000n, 9, BLOCKHASH);
    expect(tx).toBeInstanceOf(Uint8Array);
  });

  test("instruction data first byte is 12 (TransferChecked discriminator)", () => {
    const auth = makeValidPubkey();
    const src = makeValidPubkey();
    const dst = makeValidPubkey();
    const tx = buildTokenTransferTx(auth, src, dst, 1_000n, 9, BLOCKHASH);
    const parsed = parseTransaction(tx);
    expect(parsed.instructions[0].data[0]).toBe(12);
  });

  test("instruction data encodes amount correctly as u64 LE", () => {
    const auth = makeValidPubkey();
    const src = makeValidPubkey();
    const dst = makeValidPubkey();
    const amount = 999_888_777n;
    const tx = buildTokenTransferTx(auth, src, dst, amount, 6, BLOCKHASH);
    const parsed = parseTransaction(tx);
    const data = parsed.instructions[0].data;
    // bytes 1..9 are u64 LE amount
    let val = 0n;
    for (let i = 0; i < 8; i++) {
      val |= BigInt(data[1 + i]) << BigInt(8 * i);
    }
    expect(val).toBe(amount);
  });

  test("instruction data encodes decimals correctly", () => {
    const auth = makeValidPubkey();
    const src = makeValidPubkey();
    const dst = makeValidPubkey();
    const decimals = 6;
    const tx = buildTokenTransferTx(auth, src, dst, 1n, decimals, BLOCKHASH);
    const parsed = parseTransaction(tx);
    const data = parsed.instructions[0].data;
    // byte 9 is decimals
    expect(data[9]).toBe(decimals);
  });

  test("uses token program as last account key", () => {
    const auth = makeValidPubkey();
    const src = makeValidPubkey();
    const dst = makeValidPubkey();
    const tx = buildTokenTransferTx(auth, src, dst, 1n, 9, BLOCKHASH);
    const parsed = parseTransaction(tx);
    // Token program ID known bytes
    const TOKEN_PROGRAM_ID = new Uint8Array([
      6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
      28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
    ]);
    const lastKey = parsed.accountKeys[parsed.accountKeys.length - 1];
    expect(lastKey).toEqual(TOKEN_PROGRAM_ID);
  });
});

describe("findPda", () => {
  test("returns deterministic address for known seed input", () => {
    const programId = makeValidPubkey();
    const seed = new TextEncoder().encode("test-seed");
    const result1 = findPda([seed], programId);
    const result2 = findPda([seed], programId);
    expect(result1.address).toBe(result2.address);
    expect(result1.bump).toBe(result2.bump);
  });

  test("result address is not on Ed25519 curve", () => {
    const programId = makeValidPubkey();
    const seed = new TextEncoder().encode("my-pda-seed");
    const { address } = findPda([seed], programId);
    const bytes = bs58.decode(address);
    let isOnCurve = true;
    try {
      ed.ExtendedPoint.fromHex(bytes);
    } catch {
      isOnCurve = false;
    }
    expect(isOnCurve).toBe(false);
  });

  test("returns valid base58 address of 32 bytes", () => {
    const programId = makeValidPubkey();
    const seed = new TextEncoder().encode("another-seed");
    const { address } = findPda([seed], programId);
    const bytes = bs58.decode(address);
    expect(bytes.length).toBe(32);
  });

  test("bump is between 0 and 255", () => {
    const programId = makeValidPubkey();
    const seed = new TextEncoder().encode("bump-seed");
    const { bump } = findPda([seed], programId);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  test("different seeds produce different addresses", () => {
    const programId = makeValidPubkey();
    const seed1 = new TextEncoder().encode("seed-alpha");
    const seed2 = new TextEncoder().encode("seed-beta");
    const r1 = findPda([seed1], programId);
    const r2 = findPda([seed2], programId);
    expect(r1.address).not.toBe(r2.address);
  });
});

describe("generateKeypair", () => {
  test("returns object with publicKey and secretKey", () => {
    const kp = generateKeypair();
    expect(kp).toHaveProperty("publicKey");
    expect(kp).toHaveProperty("secretKey");
  });

  test("publicKey decodes to 32 bytes", () => {
    const kp = generateKeypair();
    const bytes = bs58.decode(kp.publicKey);
    expect(bytes.length).toBe(32);
  });

  test("secretKey is 64-char hex string", () => {
    const kp = generateKeypair();
    expect(kp.secretKey.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(kp.secretKey)).toBe(true);
  });

  test("each call generates different keypair", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.secretKey).not.toBe(kp2.secretKey);
  });

  test("publicKey is valid Ed25519 point derived from secretKey", () => {
    const kp = generateKeypair();
    const secretBytes = new Uint8Array(Buffer.from(kp.secretKey, "hex"));
    const derivedPub = ed.getPublicKey(secretBytes);
    const expectedB58 = bs58.encode(derivedPub);
    expect(kp.publicKey).toBe(expectedB58);
  });
});
