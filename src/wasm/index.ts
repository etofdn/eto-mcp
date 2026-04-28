import * as ed from "@noble/ed25519";
import { etc } from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import bs58 from "bs58";

// Configure ed25519 to use synchronous SHA-512
etc.sha512Sync = (...m: Uint8Array[]) => sha512(etc.concatBytes(...m));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_PROGRAM_ID = new Uint8Array(32); // all zeros

const TOKEN_PROGRAM_ID = new Uint8Array([
  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
  28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);

const EVM_PROGRAM_ID = new Uint8Array([
  ...Array(31).fill(0xff),
  0xee,
]);

// SPL Memo Program v2: makes the memo part of the transaction's account keys
// and instruction data so two transfers with different memos produce distinct
// on-chain records (and signatures). Standard Solana program ID.
const MEMO_PROGRAM_ID = bs58.decode("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// ---------------------------------------------------------------------------
// Low-level serialization helpers
// ---------------------------------------------------------------------------

function writeU8(buf: number[], v: number): void {
  buf.push(v & 0xff);
}

function writeU32LE(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function writeU64LE(buf: number[], v: bigint): void {
  const lo = Number(v & 0xffffffffn);
  const hi = Number((v >> 32n) & 0xffffffffn);
  writeU32LE(buf, lo);
  writeU32LE(buf, hi);
}

function writeBytes(buf: number[], bytes: Uint8Array): void {
  for (const b of bytes) buf.push(b);
}

function writeVec(buf: number[], bytes: Uint8Array): void {
  writeU32LE(buf, bytes.length);
  writeBytes(buf, bytes);
}

function writeFixedBytes32(buf: number[], bytes: Uint8Array): void {
  if (bytes.length !== 32) throw new Error(`Expected 32 bytes, got ${bytes.length}`);
  writeBytes(buf, bytes);
}

// ---------------------------------------------------------------------------
// Pubkey helpers
// ---------------------------------------------------------------------------

function pubkeyBytes(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length === 32) return decoded;
  if (decoded.length > 32) throw new Error(`Invalid pubkey length: ${decoded.length}`);
  // Pad short keys (leading zero bytes compress in base58)
  const padded = new Uint8Array(32);
  padded.set(decoded, 32 - decoded.length);
  return padded;
}

function blockhashBytes(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length === 32) return decoded;
  // Pad short blockhashes (e.g. low block heights encode as short base58)
  const padded = new Uint8Array(32);
  padded.set(decoded, 32 - decoded.length);
  return padded;
}

// Ed25519 curve check: a point is on curve if it decodes successfully.
// We use the property that valid Ed25519 points satisfy the curve equation.
// Simple check: attempt to decompress — noble/ed25519 throws if not on curve.
function isOnEd25519Curve(bytes: Uint8Array): boolean {
  try {
    ed.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transaction serialization
// ---------------------------------------------------------------------------

interface CompiledInstruction {
  programIdIndex: number;
  accounts: Uint8Array;
  data: Uint8Array;
}

interface Message {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: Uint8Array[]; // each 32 bytes
  recentBlockhash: Uint8Array; // 32 bytes
  instructions: CompiledInstruction[];
}

function serializeMessage(msg: Message): Uint8Array {
  const buf: number[] = [];

  // Header: 3 bytes
  writeU8(buf, msg.numRequiredSignatures);
  writeU8(buf, msg.numReadonlySigned);
  writeU8(buf, msg.numReadonlyUnsigned);

  // Account keys
  writeU32LE(buf, msg.accountKeys.length);
  for (const key of msg.accountKeys) writeFixedBytes32(buf, key);

  // Recent blockhash
  writeFixedBytes32(buf, msg.recentBlockhash);

  // Instructions
  writeU32LE(buf, msg.instructions.length);
  for (const ix of msg.instructions) {
    writeU8(buf, ix.programIdIndex);
    writeVec(buf, ix.accounts);
    writeVec(buf, ix.data);
  }

  return new Uint8Array(buf);
}

function serializeTransaction(msg: Message, signatures: Uint8Array[]): Uint8Array {
  const buf: number[] = [];

  // Signatures vector: u32 LE count, then each [u8; 64]
  writeU32LE(buf, signatures.length);
  for (const sig of signatures) {
    if (sig.length !== 64) throw new Error(`Signature must be 64 bytes, got ${sig.length}`);
    writeBytes(buf, sig);
  }

  // Message
  writeBytes(buf, serializeMessage(msg));

  return new Uint8Array(buf);
}

function unsignedTransaction(msg: Message): Uint8Array {
  const sigs = Array.from({ length: msg.numRequiredSignatures }, () => new Uint8Array(64));
  return serializeTransaction(msg, sigs);
}

// Build a message, adding the program ID as last account key.
// Returns { message, programIndex }.
function buildMessage(
  accountKeys: Uint8Array[],
  recentBlockhash: Uint8Array,
  instructions: CompiledInstruction[],
  numRequiredSignatures: number,
  numReadonlySigned: number,
  numReadonlyUnsigned: number
): Message {
  return {
    numRequiredSignatures,
    numReadonlySigned,
    numReadonlyUnsigned,
    accountKeys,
    recentBlockhash,
    instructions,
  };
}

// ---------------------------------------------------------------------------
// Key Generation
// ---------------------------------------------------------------------------

export function generateKeypair(): { publicKey: string; secretKey: string } {
  const secretKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = ed.getPublicKey(secretKeyBytes);
  return {
    publicKey: bs58.encode(publicKeyBytes),
    secretKey: Buffer.from(secretKeyBytes).toString("hex"),
  };
}

export function deriveKeypair(_mnemonic: string, _path: string): never {
  throw new Error("BIP-39 derivation not yet implemented in TS stub");
}

// ---------------------------------------------------------------------------
// Address Conversion
// ---------------------------------------------------------------------------

export function pubkeyToEvmAddress(pubkeyB58: string): string {
  const bytes = pubkeyBytes(pubkeyB58);
  const last20 = bytes.slice(12); // last 20 bytes
  return "0x" + Buffer.from(last20).toString("hex");
}

export function evmAddressToPubkey(evmAddr: string): string {
  const addr = evmAddr.startsWith("0x") ? evmAddr.slice(2) : evmAddr;
  const prefix = new TextEncoder().encode("evm:");
  const addrBytes = new TextEncoder().encode(addr);
  const combined = new Uint8Array(prefix.length + addrBytes.length);
  combined.set(prefix);
  combined.set(addrBytes, prefix.length);
  const hash = sha256(combined);
  return bs58.encode(hash);
}

export function findPda(
  seeds: Uint8Array[],
  programId: string
): { address: string; bump: number } {
  // ETO PDA: SHA256(seeds... || [bump] || program_id || "ProgramDerivedAddress")
  // ETO's create_program_address does NOT reject on-curve points, so bump=255 always.
  const programIdBytes = pubkeyBytes(programId);
  const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
  const bump = 255;

  const buf: number[] = [];
  for (const seed of seeds) writeBytes(buf, seed);
  writeU8(buf, bump);
  writeBytes(buf, programIdBytes);
  writeBytes(buf, PDA_MARKER);

  return { address: bs58.encode(sha256(new Uint8Array(buf))), bump };
}

// ---------------------------------------------------------------------------
// Transaction Builders
// ---------------------------------------------------------------------------

export function buildTransferTx(
  from: string,
  to: string,
  lamports: bigint,
  recentBlockhash: string,
  memo?: string,
): Uint8Array {
  const fromKey = pubkeyBytes(from);
  const toKey = pubkeyBytes(to);
  const blockhash = blockhashBytes(recentBlockhash);

  // SystemProgram::Transfer instruction data: [2, 0, 0, 0] + lamports u64 LE
  const transferData: number[] = [];
  writeU32LE(transferData, 2);
  writeU64LE(transferData, lamports);

  if (memo && memo.length > 0) {
    // With memo: 4 keys [from, to, system, memoProgram], 2 instructions
    // [memoIx, transferIx]. The memo ix has no accounts and its data is the
    // raw UTF-8 memo bytes — the SPL Memo program treats this as the record.
    // Memo first so its program log appears before the transfer log.
    const accountKeys = [fromKey, toKey, SYSTEM_PROGRAM_ID, MEMO_PROGRAM_ID];

    const memoIx: CompiledInstruction = {
      programIdIndex: 3, // memo program
      accounts: new Uint8Array([]),
      data: new TextEncoder().encode(memo),
    };
    const transferIx: CompiledInstruction = {
      programIdIndex: 2, // system program
      accounts: new Uint8Array([0, 1]),
      data: new Uint8Array(transferData),
    };

    const msg = buildMessage(
      accountKeys,
      blockhash,
      [memoIx, transferIx],
      1, // numRequiredSignatures
      0, // numReadonlySigned
      2, // numReadonlyUnsigned (system program + memo program)
    );
    return unsignedTransaction(msg);
  }

  // No memo: original 3-key, 1-instruction layout (kept identical for
  // backwards compatibility with callers that don't supply a memo).
  const accountKeys = [fromKey, toKey, SYSTEM_PROGRAM_ID];

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // system program
    accounts: new Uint8Array([0, 1]), // from, to
    data: new Uint8Array(transferData),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // numRequiredSignatures
    0, // numReadonlySigned
    1, // numReadonlyUnsigned (system program)
  );

  return unsignedTransaction(msg);
}

export function buildCreateAccountTx(
  payer: string,
  newAccount: string,
  lamports: bigint,
  space: bigint,
  owner: string,
  recentBlockhash: string
): Uint8Array {
  const payerKey = pubkeyBytes(payer);
  const newAccountKey = pubkeyBytes(newAccount);
  const ownerKey = pubkeyBytes(owner);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: payer (0), newAccount (1), system program (2)
  const accountKeys = [payerKey, newAccountKey, SYSTEM_PROGRAM_ID];

  // Instruction data: [0, 0, 0, 0] + lamports u64 LE + space u64 LE + owner 32 bytes
  const data: number[] = [];
  writeU32LE(data, 0);
  writeU64LE(data, lamports);
  writeU64LE(data, space);
  writeBytes(data, ownerKey);

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // system program
    accounts: new Uint8Array([0, 1]), // payer, newAccount
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    2, // payer + newAccount are signers
    0,
    1  // system program readonly
  );

  return unsignedTransaction(msg);
}

export function buildTokenTransferTx(
  authority: string,
  source: string,
  destination: string,
  amount: bigint,
  decimals: number,
  recentBlockhash: string
): Uint8Array {
  const authorityKey = pubkeyBytes(authority);
  const sourceKey = pubkeyBytes(source);
  const destinationKey = pubkeyBytes(destination);
  const blockhash = blockhashBytes(recentBlockhash);

  // Authority must be in slot 0 so its signature verifies AND SPL's authority
  // signer check passes inside the program.
  const accountKeys = [authorityKey, sourceKey, destinationKey, TOKEN_PROGRAM_ID];

  // Instruction data: [11] + amount u64 LE + decimals u8
  const data: number[] = [];
  writeU8(data, 11); // TransferChecked discriminator (Borsh enum index 11)
  writeU64LE(data, amount);
  writeU8(data, decimals);

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // token program
    accounts: new Uint8Array([1, 2, 0]), // source, destination, authority
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // authority is signer (slot 0)
    0,
    1  // token program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// RLP helpers for EVM transactions (EIP-155 legacy)
// ---------------------------------------------------------------------------

function bigintToBeBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  return new Uint8Array(Buffer.from(padded, "hex"));
}

function rlpEncodeItem(bytes: Uint8Array): number[] {
  if (bytes.length === 0) return [0x80];
  if (bytes.length === 1 && bytes[0] < 0x80) return [bytes[0]];
  if (bytes.length <= 55) return [0x80 + bytes.length, ...bytes];
  const lenBytes = bigintToBeBytes(BigInt(bytes.length));
  return [0xb7 + lenBytes.length, ...Array.from(lenBytes), ...bytes];
}

function rlpEncodeInt(n: bigint): number[] {
  return rlpEncodeItem(bigintToBeBytes(n));
}

function rlpEncodeList(items: number[][]): Uint8Array {
  const flat = items.flat();
  const len = flat.length;
  if (len <= 55) return new Uint8Array([0xc0 + len, ...flat]);
  const lenBytes = bigintToBeBytes(BigInt(len));
  return new Uint8Array([0xf7 + lenBytes.length, ...Array.from(lenBytes), ...flat]);
}

/** EIP-155 signing hash for a legacy EVM deploy transaction (to = null). */
export function buildEvmDeploySigningHash(
  bytecode: string,
  chainId: bigint,
  nonce: bigint,
  gasPrice: bigint,
  gasLimit: bigint,
  value: bigint = 0n,
): Uint8Array {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const data = new Uint8Array(Buffer.from(hex, "hex"));
  const encoded = rlpEncodeList([
    rlpEncodeInt(nonce), rlpEncodeInt(gasPrice), rlpEncodeInt(gasLimit),
    [0x80], // to = null (contract creation)
    rlpEncodeInt(value), rlpEncodeItem(data),
    rlpEncodeInt(chainId), rlpEncodeInt(0n), rlpEncodeInt(0n), // EIP-155
  ]);
  return keccak_256(encoded);
}

/** EIP-155 signing hash for a legacy EVM call transaction (to = contract). */
export function buildEvmCallSigningHash(
  contract: string,
  calldata: string,
  chainId: bigint,
  nonce: bigint,
  gasPrice: bigint,
  gasLimit: bigint,
  value: bigint = 0n,
): Uint8Array {
  const toHex = contract.startsWith("0x") ? contract.slice(2) : contract;
  const to = new Uint8Array(Buffer.from(toHex.padStart(40, "0"), "hex"));
  const cdHex = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
  const cd = new Uint8Array(Buffer.from(cdHex, "hex"));
  const encoded = rlpEncodeList([
    rlpEncodeInt(nonce), rlpEncodeInt(gasPrice), rlpEncodeInt(gasLimit),
    rlpEncodeItem(to), rlpEncodeInt(value), rlpEncodeItem(cd),
    rlpEncodeInt(chainId), rlpEncodeInt(0n), rlpEncodeInt(0n),
  ]);
  return keccak_256(encoded);
}

function wrapEvmRlpInSvmTx(deployer: string, rlp: Uint8Array, recentBlockhash: string): Uint8Array {
  const deployerKey = pubkeyBytes(deployer);
  const blockhash = blockhashBytes(recentBlockhash);
  const instruction: CompiledInstruction = { programIdIndex: 1, accounts: new Uint8Array([0]), data: rlp };
  const msg = buildMessage([deployerKey, EVM_PROGRAM_ID], blockhash, [instruction], 1, 0, 1);
  return unsignedTransaction(msg);
}

/** Build fully signed EVM deploy tx (RLP) wrapped in SVM instruction envelope. */
export function buildSignedEvmDeployTx(
  deployer: string,
  bytecode: string,
  r: Uint8Array,
  s: Uint8Array,
  v: bigint,
  chainId: bigint,
  nonce: bigint,
  gasPrice: bigint,
  gasLimit: bigint,
  value: bigint,
  recentBlockhash: string,
): Uint8Array {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const data = new Uint8Array(Buffer.from(hex, "hex"));
  const rlp = rlpEncodeList([
    rlpEncodeInt(nonce), rlpEncodeInt(gasPrice), rlpEncodeInt(gasLimit),
    [0x80], // to = null (contract creation)
    rlpEncodeInt(value), rlpEncodeItem(data),
    rlpEncodeInt(v), rlpEncodeItem(r), rlpEncodeItem(s),
  ]);
  return wrapEvmRlpInSvmTx(deployer, rlp, recentBlockhash);
}

/** Build fully signed EVM call tx (RLP) wrapped in SVM instruction envelope. */
export function buildSignedEvmCallTx(
  caller: string,
  contract: string,
  calldata: string,
  r: Uint8Array,
  s: Uint8Array,
  v: bigint,
  chainId: bigint,
  nonce: bigint,
  gasPrice: bigint,
  gasLimit: bigint,
  value: bigint,
  recentBlockhash: string,
): Uint8Array {
  const toHex = contract.startsWith("0x") ? contract.slice(2) : contract;
  const to = new Uint8Array(Buffer.from(toHex.padStart(40, "0"), "hex"));
  const cdHex = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
  const cd = new Uint8Array(Buffer.from(cdHex, "hex"));
  const rlp = rlpEncodeList([
    rlpEncodeInt(nonce), rlpEncodeInt(gasPrice), rlpEncodeInt(gasLimit),
    rlpEncodeItem(to), rlpEncodeInt(value), rlpEncodeItem(cd),
    rlpEncodeInt(v), rlpEncodeItem(r), rlpEncodeItem(s),
  ]);
  return wrapEvmRlpInSvmTx(caller, rlp, recentBlockhash);
}

/** Legacy: wraps raw bytecode in SVM envelope (kept for backward compat). */
export function buildEvmDeployTx(
  deployer: string,
  bytecode: string,
  _value: bigint,
  _gasLimit: bigint,
  recentBlockhash: string
): Uint8Array {
  const deployerKey = pubkeyBytes(deployer);
  const blockhash = blockhashBytes(recentBlockhash);
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const data = new Uint8Array(Buffer.from(hex, "hex"));
  const instruction: CompiledInstruction = { programIdIndex: 1, accounts: new Uint8Array([0]), data };
  const msg = buildMessage([deployerKey, EVM_PROGRAM_ID], blockhash, [instruction], 1, 0, 1);
  return unsignedTransaction(msg);
}

export function buildEvmCallTx(
  caller: string,
  contract: string,
  calldata: string,
  _value: bigint,
  _gasLimit: bigint,
  recentBlockhash: string
): Uint8Array {
  const callerKey = pubkeyBytes(caller);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: caller (0), EVM program (1)
  const accountKeys = [callerKey, EVM_PROGRAM_ID];

  // Contract address: strip 0x, decode 20 bytes
  const contractHex = contract.startsWith("0x") ? contract.slice(2) : contract;
  const contractBytes = new Uint8Array(Buffer.from(contractHex.padStart(40, "0"), "hex"));
  if (contractBytes.length !== 20) throw new Error("Contract address must be 20 bytes");

  // Calldata bytes
  const calldataHex = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
  const calldataBytes = new Uint8Array(Buffer.from(calldataHex, "hex"));

  // Instruction data: contract address (20 bytes) + calldata
  const data = new Uint8Array(contractBytes.length + calldataBytes.length);
  data.set(contractBytes);
  data.set(calldataBytes, contractBytes.length);

  const instruction: CompiledInstruction = {
    programIdIndex: 1, // EVM program
    accounts: new Uint8Array([0]), // caller
    data,
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // caller is signer
    0,
    1  // EVM program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export function signTransaction(txBytes: Uint8Array, secretKeyHex: string): Uint8Array {
  const secretKey = new Uint8Array(Buffer.from(secretKeyHex, "hex"));

  // Parse the transaction to extract message bytes.
  // Format: u32 LE sig count, then sig_count * 64 bytes, then message bytes.
  const view = new DataView(txBytes.buffer, txBytes.byteOffset, txBytes.byteLength);
  const sigCount = view.getUint32(0, true); // little-endian
  const messageOffset = 4 + sigCount * 64;
  const messageBytes = txBytes.slice(messageOffset);

  const signature = ed.sign(messageBytes, secretKey);

  // Rebuild: write sig count=1, signature, then message bytes
  const result: number[] = [];
  writeU32LE(result, 1);
  writeBytes(result, signature);
  writeBytes(result, messageBytes);

  return new Uint8Array(result);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

interface DecodedInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string; // hex
}

interface DecodedTransaction {
  signatures: string[]; // hex
  message: {
    header: {
      numRequiredSignatures: number;
      numReadonlySigned: number;
      numReadonlyUnsigned: number;
    };
    accountKeys: string[]; // base58
    recentBlockhash: string; // base58
    instructions: DecodedInstruction[];
  };
}

export function decodeTransaction(txBytes: Uint8Array): DecodedTransaction {
  let offset = 0;

  function readU8(): number {
    return txBytes[offset++];
  }

  function readU32LE(): number {
    const v =
      txBytes[offset] |
      (txBytes[offset + 1] << 8) |
      (txBytes[offset + 2] << 16) |
      (txBytes[offset + 3] << 24);
    offset += 4;
    return v >>> 0;
  }

  function readBytes(n: number): Uint8Array {
    const slice = txBytes.slice(offset, offset + n);
    offset += n;
    return slice;
  }

  function readVec(): Uint8Array {
    const len = readU32LE();
    return readBytes(len);
  }

  // Signatures
  const sigCount = readU32LE();
  const signatures: string[] = [];
  for (let i = 0; i < sigCount; i++) {
    signatures.push(Buffer.from(readBytes(64)).toString("hex"));
  }

  // Message header
  const numRequiredSignatures = readU8();
  const numReadonlySigned = readU8();
  const numReadonlyUnsigned = readU8();

  // Account keys
  const keyCount = readU32LE();
  const accountKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    accountKeys.push(bs58.encode(readBytes(32)));
  }

  // Recent blockhash
  const recentBlockhash = bs58.encode(readBytes(32));

  // Instructions
  const ixCount = readU32LE();
  const instructions: DecodedInstruction[] = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = readU8();
    const accountsBytes = readVec();
    const dataBytes = readVec();
    instructions.push({
      programIdIndex,
      accounts: Array.from(accountsBytes),
      data: Buffer.from(dataBytes).toString("hex"),
    });
  }

  return {
    signatures,
    message: {
      header: { numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned },
      accountKeys,
      recentBlockhash,
      instructions,
    },
  };
}

interface UniversalTokenHeader {
  version: number;
  vmOrigin: number; // 0=SVM, 1=EVM, 2=WASM, 3=Move
  mint: string; // hex
  owner: string; // hex
  amount: bigint;
  decimals: number;
  frozen: boolean;
}

export function decodeUth(data: Uint8Array): UniversalTokenHeader | null {
  if (data.length < 76) return null;

  const version = data[0];
  const vmOrigin = data[1];
  const mint = Buffer.from(data.slice(2, 34)).toString("hex");
  const owner = Buffer.from(data.slice(34, 66)).toString("hex");

  const view = new DataView(data.buffer, data.byteOffset + 66, 8);
  const amountLo = view.getUint32(0, true);
  const amountHi = view.getUint32(4, true);
  const amount = BigInt(amountHi) * 0x100000000n + BigInt(amountLo);

  const decimals = data[74];
  const frozen = data[75] !== 0;

  return { version, vmOrigin, mint, owner, amount, decimals, frozen };
}

// ---------------------------------------------------------------------------
// ABI Encoding
// ---------------------------------------------------------------------------

function keccak256Str(s: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(s));
}

function abiEncodeArg(type: string, value: unknown): Uint8Array {
  const word = new Uint8Array(32);

  if (type === "uint256") {
    const v = BigInt(value as string | number | bigint);
    // Write as big-endian 32 bytes
    let tmp = v;
    for (let i = 31; i >= 0; i--) {
      word[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
  } else if (type === "address") {
    const addr = (value as string).startsWith("0x")
      ? (value as string).slice(2)
      : (value as string);
    const addrBytes = Buffer.from(addr.padStart(40, "0"), "hex");
    // right-aligned in 32 bytes
    word.set(addrBytes, 12);
  } else if (type === "bool") {
    word[31] = (value as boolean) ? 1 : 0;
  } else if (type === "bytes32") {
    const bytes =
      typeof value === "string"
        ? new Uint8Array(Buffer.from((value as string).startsWith("0x") ? (value as string).slice(2) : (value as string), "hex"))
        : (value as Uint8Array);
    word.set(bytes.slice(0, 32));
  } else {
    throw new Error(`Unsupported ABI type: ${type}`);
  }

  return word;
}

export function encodeEvmCall(signature: string, args: unknown[]): Uint8Array {
  // Parse signature: "functionName(type1,type2,...)"
  const parenOpen = signature.indexOf("(");
  const parenClose = signature.lastIndexOf(")");
  if (parenOpen === -1 || parenClose === -1) {
    throw new Error(`Invalid function signature: ${signature}`);
  }

  const typesPart = signature.slice(parenOpen + 1, parenClose).trim();
  const types = typesPart.length > 0 ? typesPart.split(",").map((t) => t.trim()) : [];

  if (args.length !== types.length) {
    throw new Error(`Argument count mismatch: expected ${types.length}, got ${args.length}`);
  }

  // Selector: keccak256 of canonical signature, first 4 bytes
  const selector = keccak256Str(signature).slice(0, 4);

  const encodedArgs: Uint8Array[] = types.map((type, i) => abiEncodeArg(type, args[i]));

  const totalLen = 4 + encodedArgs.length * 32;
  const result = new Uint8Array(totalLen);
  result.set(selector, 0);
  let pos = 4;
  for (const word of encodedArgs) {
    result.set(word, pos);
    pos += 32;
  }

  return result;
}

export function decodeEvmReturn(_signature: string, data: Uint8Array): string {
  // Phase 1 stub: return raw hex
  return "0x" + Buffer.from(data).toString("hex");
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256Hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function keccak256Hash(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

// ---------------------------------------------------------------------------
// Validation & Utilities
// ---------------------------------------------------------------------------

export function isValidPubkey(pubkey: string): boolean {
  try {
    const decoded = bs58.decode(pubkey);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

export function isValidEvmAddr(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1_000_000_000;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1_000_000_000));
}

// ---------------------------------------------------------------------------
// Additional Program IDs
// ---------------------------------------------------------------------------

const STAKE_PROGRAM_ID = new Uint8Array([
  6, 161, 216, 23, 145, 55, 84, 42, 152, 52, 55, 189, 254, 42, 122, 178,
  85, 127, 83, 92, 138, 120, 114, 43, 104, 164, 157, 192, 0, 0, 0, 0,
]);

const SYSVAR_RENT_PUBKEY = new Uint8Array([
  6, 167, 213, 23, 25, 44, 97, 55, 206, 224, 146, 217, 182, 146, 62, 225,
  204, 214, 25, 3, 250, 130, 184, 161, 98, 201, 252, 166, 0, 0, 0, 0,
]);

const AGENT_PROGRAM_ID = new Uint8Array([
  0xa6, 0xe7, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xae, 0x01,
]);

const A2A_PROGRAM_ID = new Uint8Array([
  0xa2, 0xa0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xa2, 0x01,
]);

const MCP_PROGRAM_ID = new Uint8Array([
  0xbc, 0xd0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xbc, 0x01,
]);

const SWARM_PROGRAM_ID = new Uint8Array([
  0x5a, 0xaf, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x5a, 0x01,
]);

const WASM_PROGRAM_ID = new Uint8Array([
  ...Array(29).fill(0xff),
  0x03,
]);

const MOVE_PROGRAM_ID = new Uint8Array([
  ...Array(29).fill(0xff),
  0x02,
]);

const BPF_LOADER_PROGRAM_ID = new Uint8Array([
  2, 168, 246, 145, 230, 44, 162, 234, 255, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

// ---------------------------------------------------------------------------
// Token Instructions (SPL Token program)
// ---------------------------------------------------------------------------

export function buildCreateMintTx(
  payer: string,
  mintAccount: string,
  mintAuthority: string,
  decimals: number,
  recentBlockhash: string
): Uint8Array {
  const payerKey = pubkeyBytes(payer);
  const mintKey = pubkeyBytes(mintAccount);
  const mintAuthorityKey = pubkeyBytes(mintAuthority);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: payer(0), mint(1), system program(2), token program(3), rent sysvar(4)
  const accountKeys = [
    payerKey,
    mintKey,
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    SYSVAR_RENT_PUBKEY,
  ];

  // Instruction 0: System program CreateAccount
  // Space for mint = 82 bytes; lamports = 1461600 (typical rent-exempt for mint)
  const createData: number[] = [];
  writeU32LE(createData, 0); // CreateAccount discriminator
  writeU64LE(createData, 1461600n); // lamports (rent-exempt)
  writeU64LE(createData, 0n); // space=0: token program writes data on InitializeMint
  writeBytes(createData, TOKEN_PROGRAM_ID); // owner = token program

  const createIx: CompiledInstruction = {
    programIdIndex: 2, // system program
    accounts: new Uint8Array([0, 1]), // payer, mint
    data: new Uint8Array(createData),
  };

  // Instruction 1: Token program InitializeMint
  // [0] + decimals u8 + Some(mintAuthority) + None (freeze authority)
  // Borsh: Option<Pubkey> = 0x01 + 32 bytes for Some, 0x00 for None
  const initData: number[] = [];
  writeU8(initData, 0); // InitializeMint discriminator
  writeU8(initData, decimals);
  writeBytes(initData, mintAuthorityKey); // mint_authority: Pubkey (not Option)
  writeU8(initData, 0); // freeze_authority: Option<Pubkey> = None

  const initIx: CompiledInstruction = {
    programIdIndex: 3, // token program
    accounts: new Uint8Array([1, 4]), // mint, rent sysvar
    data: new Uint8Array(initData),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [createIx, initIx],
    2, // payer + mint are signers
    0,
    3  // system program, token program, rent sysvar readonly
  );

  return unsignedTransaction(msg);
}

export function buildMintToTx(
  mintAuthority: string,
  mint: string,
  destination: string,
  amount: bigint,
  recentBlockhash: string
): Uint8Array {
  const mintAuthorityKey = pubkeyBytes(mintAuthority);
  const mintKey = pubkeyBytes(mint);
  const destinationKey = pubkeyBytes(destination);
  const blockhash = blockhashBytes(recentBlockhash);

  // Solana message-format invariant: the first numRequiredSignatures account
  // keys are the signers. Authority must be in slot 0 so its signature is
  // checked AND so SPL Token's "is authority a signer?" check passes
  // (otherwise MintTo returns "Token program failed" with computeUnits=0).
  const accountKeys = [mintAuthorityKey, mintKey, destinationKey, TOKEN_PROGRAM_ID];

  // Instruction data: [6] + amount u64 LE
  const data: number[] = [];
  writeU8(data, 6); // MintTo discriminator (Borsh enum index 6)
  writeU64LE(data, amount);

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // token program
    accounts: new Uint8Array([1, 2, 0]), // mint, destination, authority
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // authority is signer (slot 0)
    0,
    1  // token program readonly
  );

  return unsignedTransaction(msg);
}

export function buildBurnTx(
  owner: string,
  tokenAccount: string,
  mint: string,
  amount: bigint,
  recentBlockhash: string
): Uint8Array {
  const ownerKey = pubkeyBytes(owner);
  const tokenAccountKey = pubkeyBytes(tokenAccount);
  const mintKey = pubkeyBytes(mint);
  const blockhash = blockhashBytes(recentBlockhash);

  // Owner must be in slot 0 so its signature is verified AND SPL's authority
  // signer check passes inside the program.
  const accountKeys = [ownerKey, tokenAccountKey, mintKey, TOKEN_PROGRAM_ID];

  // Instruction data: [7] + amount u64 LE
  const data: number[] = [];
  writeU8(data, 7); // Burn discriminator (Borsh enum index 7)
  writeU64LE(data, amount);

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // token program
    accounts: new Uint8Array([1, 2, 0]), // tokenAccount, mint, owner
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // owner is signer (slot 0)
    0,
    1  // token program readonly
  );

  return unsignedTransaction(msg);
}

export function buildFreezeTx(
  freezeAuthority: string,
  tokenAccount: string,
  mint: string,
  recentBlockhash: string
): Uint8Array {
  const freezeAuthorityKey = pubkeyBytes(freezeAuthority);
  const tokenAccountKey = pubkeyBytes(tokenAccount);
  const mintKey = pubkeyBytes(mint);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: tokenAccount(0), mint(1), freezeAuthority(2), token program(3)
  const accountKeys = [tokenAccountKey, mintKey, freezeAuthorityKey, TOKEN_PROGRAM_ID];

  // Instruction data: [9] (FreezeAccount discriminator, Borsh variant index)
  const data: number[] = [];
  writeU8(data, 9);

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // token program
    accounts: new Uint8Array([0, 1, 2]), // tokenAccount, mint, freezeAuthority
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // freezeAuthority is signer
    0,
    1  // token program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// Staking Instructions (Stake program)
// ---------------------------------------------------------------------------

export function buildCreateStakeTx(
  staker: string,
  stakeAccount: string,
  lamports: bigint,
  recentBlockhash: string
): Uint8Array {
  const stakerKey = pubkeyBytes(staker);
  const stakeAccountKey = pubkeyBytes(stakeAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: staker(0), stakeAccount(1), system program(2), stake program(3), rent sysvar(4)
  const accountKeys = [
    stakerKey,
    stakeAccountKey,
    SYSTEM_PROGRAM_ID,
    STAKE_PROGRAM_ID,
    SYSVAR_RENT_PUBKEY,
  ];

  // Instruction 0: System CreateAccount with space=0 (stake program writes
  // state in Initialize; space>0 causes Borsh trailing-bytes failure when
  // deserializing zero-padded data).
  const createData: number[] = [];
  writeU32LE(createData, 0); // CreateAccount discriminator
  writeU64LE(createData, lamports);
  writeU64LE(createData, 0n); // space=0
  writeBytes(createData, STAKE_PROGRAM_ID); // owner

  const createIx: CompiledInstruction = {
    programIdIndex: 2, // system program
    accounts: new Uint8Array([0, 1]), // staker, stakeAccount
    data: new Uint8Array(createData),
  };

  // Instruction 1: Stake Initialize(Authorized, Lockup)
  // Borsh: u8 variant 0, then Authorized { staker, withdrawer } (64 bytes),
  // then Lockup { unix_timestamp: i64, epoch: u64, custodian: Pubkey }.
  const initData: number[] = [];
  writeU8(initData, 0); // Initialize variant (Borsh u8 discriminant)
  writeBytes(initData, stakerKey); // authorized.staker
  writeBytes(initData, stakerKey); // authorized.withdrawer (same)
  writeU64LE(initData, 0n); // lockup.unix_timestamp (no lockup)
  writeU64LE(initData, 0n); // lockup.epoch
  writeBytes(initData, new Uint8Array(32)); // lockup.custodian = zero

  const initIx: CompiledInstruction = {
    programIdIndex: 3, // stake program
    accounts: new Uint8Array([1, 4]), // stakeAccount, rent sysvar
    data: new Uint8Array(initData),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [createIx, initIx],
    2, // staker + stakeAccount are signers
    0,
    3  // system program, stake program, rent sysvar readonly
  );

  return unsignedTransaction(msg);
}

export function buildDelegateStakeTx(
  staker: string,
  stakeAccount: string,
  voteAccount: string,
  recentBlockhash: string
): Uint8Array {
  const stakerKey = pubkeyBytes(staker);
  const stakeAccountKey = pubkeyBytes(stakeAccount);
  const voteAccountKey = pubkeyBytes(voteAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: stakeAccount(0), voteAccount(1), staker(2), stake program(3)
  const accountKeys = [stakeAccountKey, voteAccountKey, stakerKey, STAKE_PROGRAM_ID];

  // Instruction data: discriminator [2,0,0,0] (u32 LE = 2)
  const data: number[] = [];
  writeU32LE(data, 2); // DelegateStake discriminator

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // stake program
    accounts: new Uint8Array([0, 1, 2]), // stakeAccount, voteAccount, staker
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // staker is signer
    0,
    1  // stake program readonly
  );

  return unsignedTransaction(msg);
}

export function buildDeactivateStakeTx(
  staker: string,
  stakeAccount: string,
  recentBlockhash: string
): Uint8Array {
  const stakerKey = pubkeyBytes(staker);
  const stakeAccountKey = pubkeyBytes(stakeAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: stakeAccount(0), staker(1), stake program(2)
  const accountKeys = [stakeAccountKey, stakerKey, STAKE_PROGRAM_ID];

  // Instruction data: discriminator [5,0,0,0] (u32 LE = 5)
  const data: number[] = [];
  writeU32LE(data, 5); // Deactivate discriminator

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // stake program
    accounts: new Uint8Array([0, 1]), // stakeAccount, staker
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // staker is signer
    0,
    1  // stake program readonly
  );

  return unsignedTransaction(msg);
}

export function buildWithdrawStakeTx(
  staker: string,
  stakeAccount: string,
  recipient: string,
  lamports: bigint,
  recentBlockhash: string
): Uint8Array {
  const stakerKey = pubkeyBytes(staker);
  const stakeAccountKey = pubkeyBytes(stakeAccount);
  const recipientKey = pubkeyBytes(recipient);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: stakeAccount(0), recipient(1), staker(2), stake program(3)
  const accountKeys = [stakeAccountKey, recipientKey, stakerKey, STAKE_PROGRAM_ID];

  // Instruction data: discriminator [4,0,0,0] (u32 LE = 4) + lamports u64 LE
  const data: number[] = [];
  writeU32LE(data, 4); // Withdraw discriminator
  writeU64LE(data, lamports);

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // stake program
    accounts: new Uint8Array([0, 1, 2]), // stakeAccount, recipient, staker
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // staker is signer
    0,
    1  // stake program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// Agent Program Instructions
// ---------------------------------------------------------------------------

export function buildRegisterAgentTx(
  authority: string,
  agentAccount: string,
  name: string,
  modelId: string,
  recentBlockhash: string
): Uint8Array {
  const authorityKey = pubkeyBytes(authority);
  const agentAccountKey = pubkeyBytes(agentAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: funder(0), agentAccount(1), authority(2), agent program(3)
  // Rust expects: [signer+writable funder, writable agent, read-only authority]
  // Authority = funder in the common case
  const accountKeys = [authorityKey, agentAccountKey, authorityKey, AGENT_PROGRAM_ID];

  // Instruction data: Borsh AgentInstruction::RegisterAgent
  // [0] + name (Borsh String) + model_id (Borsh String) + metadata_uri (Borsh String) + initial_lamports (u64 LE)
  const nameBytes = new TextEncoder().encode(name);
  const modelIdBytes = new TextEncoder().encode(modelId);
  const metadataUriBytes = new TextEncoder().encode("");
  const data: number[] = [];
  writeU8(data, 0); // RegisterAgent discriminator
  writeVec(data, nameBytes);
  writeVec(data, modelIdBytes);
  writeVec(data, metadataUriBytes);
  writeU64LE(data, 0n); // initial_lamports

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // agent program
    accounts: new Uint8Array([0, 1, 2]), // funder, agentAccount, authority
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // funder is signer
    0,
    2  // authority + agent program readonly
  );

  return unsignedTransaction(msg);
}

export function buildSetAgentStatusTx(
  authority: string,
  agentAccount: string,
  status: number,
  recentBlockhash: string
): Uint8Array {
  const authorityKey = pubkeyBytes(authority);
  const agentAccountKey = pubkeyBytes(agentAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: agentAccount(0), authority(1), agent program(2)
  const accountKeys = [agentAccountKey, authorityKey, AGENT_PROGRAM_ID];

  // Instruction data: [7] + status u8
  const data: number[] = [];
  writeU8(data, 6); // SetStatus discriminator (Borsh variant index 6)
  writeU8(data, status);

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // agent program
    accounts: new Uint8Array([0, 1]), // agentAccount, authority
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // authority is signer
    0,
    1  // agent program readonly
  );

  return unsignedTransaction(msg);
}

export function buildSetDelegateTx(
  authority: string,
  agentAccount: string,
  delegate: string | null,
  spendLimit: bigint,
  recentBlockhash: string
): Uint8Array {
  const authorityKey = pubkeyBytes(authority);
  const agentAccountKey = pubkeyBytes(agentAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: agentAccount(0), authority(1), agent program(2)
  const accountKeys = [agentAccountKey, authorityKey, AGENT_PROGRAM_ID];

  // Instruction data: [6] + has_delegate u8 + delegate 32 bytes (if present) + spend_limit u64 LE
  const data: number[] = [];
  writeU8(data, 5); // SetDelegate discriminator (Borsh variant index 5)
  if (delegate !== null) {
    writeU8(data, 1);
    writeBytes(data, pubkeyBytes(delegate));
  } else {
    writeU8(data, 0);
  }
  writeU64LE(data, spendLimit);

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // agent program
    accounts: new Uint8Array([0, 1]), // agentAccount, authority
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // authority is signer
    0,
    1  // agent program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// A2A Program Instructions (RegisterCard / CreateTask / SendMessage protocol)
// ---------------------------------------------------------------------------

function writeString(buf: number[], s: string): void {
  const bytes = new TextEncoder().encode(s);
  writeU32LE(buf, bytes.length);
  for (const b of bytes) buf.push(b);
}

/**
 * RegisterCard (variant 0) — create an agent card making the agent addressable for A2A tasks.
 * Accounts: funder(0,signer,writable), cardPDA(1,writable), agentAccount(2,readonly), authority(3,signer)
 */
export function buildCreateA2AChannelTx(
  owner: string,
  cardAccount: string,
  agentAccount: string,
  _capacity: number,
  recentBlockhash: string,
  name: string = "Agent Card",
  description: string = "A2A agent card",
  endpointUri: string = "",
  capabilitiesUri: string = "",
  version: string = "1.0",
): Uint8Array {
  const ownerKey = pubkeyBytes(owner);
  const cardKey = pubkeyBytes(cardAccount);
  const agentKey = pubkeyBytes(agentAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  const accountKeys = [ownerKey, cardKey, agentKey, A2A_PROGRAM_ID];

  const data: number[] = [];
  writeU8(data, 0); // RegisterCard variant
  writeString(data, name);
  writeString(data, description);
  writeString(data, endpointUri);
  writeString(data, capabilitiesUri);
  writeString(data, version);
  writeU8(data, 0); // AuthType::None

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // A2A program
    accounts: new Uint8Array([0, 1, 2, 0]), // funder, cardPDA, agentAccount, authority=owner
    data: new Uint8Array(data),
  };

  const msg = buildMessage(accountKeys, blockhash, [instruction], 1, 0, 2);
  return unsignedTransaction(msg);
}

// Removed: buildSendA2AMessageTx and buildCloseA2AChannelTx.
//
// Both were unused (no callers anywhere in src/) and wrong by construction:
//
// buildSendA2AMessageTx — derived escrowKey via sha256("escrow:" + taskAccount)
// and used the input message bytes as the task_id. The on-chain A2A program
// doesn't enforce a specific PDA derivation, but clients need to agree on
// the address they create; sha256 isn't a PDA and doesn't interop with a
// findPda-based client.
//
// buildCloseA2AChannelTx — on top of the same escrow derivation bug, its
// account ordering put a non-signer at index 0 while advertising
// numRequiredSignatures=1, its instruction.accounts array duplicated index 3
// (the sender_card slot collided with the authority slot), and it fabricated
// current_slot from Date.now()/400 instead of fetching from RPC.
//
// When these builders are needed, rebuild against the real on-chain contract:
// CancelTask (variant 10) expects accounts
// [task_pda(W), escrow_pda(W), sender_wallet(W), sender_card, authority(S)]
// and the caller must pass in a real slot from eth_blockNumber / getSlot.
// See src/runtime/src/programs/a2a.rs:cancel_task and :create_task.
//
// Addresses CodeRabbit PR #5: wasm/index.ts:1452 (Major), :1485 (Critical).

// ---------------------------------------------------------------------------
// MCP Program Instructions
// ---------------------------------------------------------------------------

export function buildRegisterMcpToolTx(
  owner: string,
  toolAccount: string,
  targetProgram: string,
  name: string,
  description: string,
  recentBlockhash: string
): Uint8Array {
  const ownerKey = pubkeyBytes(owner);
  const toolAccountKey = pubkeyBytes(toolAccount);
  const targetProgramKey = pubkeyBytes(targetProgram);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: owner(0), toolAccount(1), targetProgram(2), MCP program(3)
  const accountKeys = [ownerKey, toolAccountKey, targetProgramKey, MCP_PROGRAM_ID];

  // Instruction data: [0] + name_len u32 + name + desc_len u32 + desc + targetProgram 32 bytes
  const nameBytes = new TextEncoder().encode(name);
  const descBytes = new TextEncoder().encode(description);
  const data: number[] = [];
  writeU8(data, 0); // RegisterTool discriminator
  writeVec(data, nameBytes);
  writeVec(data, descBytes);
  writeBytes(data, targetProgramKey);

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // MCP program
    accounts: new Uint8Array([0, 1, 2]), // owner, toolAccount, targetProgram
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // owner is signer
    0,
    1  // MCP program readonly
  );

  return unsignedTransaction(msg);
}

export function buildInvokeMcpToolTx(
  caller: string,
  toolAccount: string,
  logAccount: string,
  inputHash: Uint8Array,
  recentBlockhash: string
): Uint8Array {
  const callerKey = pubkeyBytes(caller);
  const toolAccountKey = pubkeyBytes(toolAccount);
  const logAccountKey = pubkeyBytes(logAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: caller(0), toolAccount(1), logAccount(2), MCP program(3)
  const accountKeys = [callerKey, toolAccountKey, logAccountKey, MCP_PROGRAM_ID];

  // Instruction data: [2] + inputHash 32 bytes
  if (inputHash.length !== 32) throw new Error(`inputHash must be 32 bytes, got ${inputHash.length}`);
  const data: number[] = [];
  writeU8(data, 2); // InvokeTool discriminator
  writeBytes(data, inputHash);

  const instruction: CompiledInstruction = {
    programIdIndex: 3, // MCP program
    accounts: new Uint8Array([0, 1, 2]), // caller, toolAccount, logAccount
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // caller is signer
    0,
    1  // MCP program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// Swarm Program Instructions
// ---------------------------------------------------------------------------

export function buildCreateSwarmTx(
  creator: string,
  swarmAccount: string,
  name: string,
  strategy: number,
  maxMembers: number,
  recentBlockhash: string
): Uint8Array {
  const creatorKey = pubkeyBytes(creator);
  const swarmAccountKey = pubkeyBytes(swarmAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: creator(0), swarmAccount(1), swarm program(2)
  const accountKeys = [creatorKey, swarmAccountKey, SWARM_PROGRAM_ID];

  // Instruction data: [0] + name_len u32 + name bytes + strategy u8 + maxMembers u8
  const nameBytes = new TextEncoder().encode(name);
  const data: number[] = [];
  writeU8(data, 0); // CreateSwarm discriminator
  writeVec(data, nameBytes);
  writeU8(data, strategy);
  writeU8(data, maxMembers);

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // swarm program
    accounts: new Uint8Array([0, 1]), // creator, swarmAccount
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // creator is signer
    0,
    1  // swarm program readonly
  );

  return unsignedTransaction(msg);
}

export function buildJoinSwarmTx(
  agent: string,
  swarmAccount: string,
  recentBlockhash: string
): Uint8Array {
  const agentKey = pubkeyBytes(agent);
  const swarmAccountKey = pubkeyBytes(swarmAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: agent(0), swarmAccount(1), swarm program(2)
  const accountKeys = [agentKey, swarmAccountKey, SWARM_PROGRAM_ID];

  // Instruction data: [1] (JoinSwarm discriminator)
  const data: number[] = [];
  writeU8(data, 1);

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // swarm program
    accounts: new Uint8Array([0, 1]), // agent, swarmAccount
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // agent is signer
    0,
    1  // swarm program readonly
  );

  return unsignedTransaction(msg);
}

export function buildSwarmProposeTx(
  proposer: string,
  swarmAccount: string,
  title: string,
  actionData: Uint8Array,
  recentBlockhash: string
): Uint8Array {
  const proposerKey = pubkeyBytes(proposer);
  const swarmAccountKey = pubkeyBytes(swarmAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: proposer(0), swarmAccount(1), swarm program(2)
  const accountKeys = [proposerKey, swarmAccountKey, SWARM_PROGRAM_ID];

  // Instruction data: [2] + title_len u32 + title + action_len u32 + action bytes
  const titleBytes = new TextEncoder().encode(title);
  const data: number[] = [];
  writeU8(data, 2); // Propose discriminator
  writeVec(data, titleBytes);
  writeVec(data, actionData);

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // swarm program
    accounts: new Uint8Array([0, 1]), // proposer, swarmAccount
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // proposer is signer
    0,
    1  // swarm program readonly
  );

  return unsignedTransaction(msg);
}

export function buildSwarmVoteTx(
  voter: string,
  swarmAccount: string,
  proposalIndex: number,
  vote: number,
  recentBlockhash: string
): Uint8Array {
  const voterKey = pubkeyBytes(voter);
  const swarmAccountKey = pubkeyBytes(swarmAccount);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: voter(0), swarmAccount(1), swarm program(2)
  const accountKeys = [voterKey, swarmAccountKey, SWARM_PROGRAM_ID];

  // Instruction data: [3] + proposalIndex u32 LE + vote u8
  const data: number[] = [];
  writeU8(data, 3); // Vote discriminator
  writeU32LE(data, proposalIndex);
  writeU8(data, vote);

  const instruction: CompiledInstruction = {
    programIdIndex: 2, // swarm program
    accounts: new Uint8Array([0, 1]), // voter, swarmAccount
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // voter is signer
    0,
    1  // swarm program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// Cross-VM Instruction
// ---------------------------------------------------------------------------

export function buildCrossVmCallTx(
  caller: string,
  sourceVm: number,
  targetVm: number,
  targetAddress: string,
  calldata: Uint8Array,
  recentBlockhash: string
): Uint8Array {
  const callerKey = pubkeyBytes(caller);
  const targetAddressKey = pubkeyBytes(targetAddress);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: caller(0), EVM program(1)
  const accountKeys = [callerKey, EVM_PROGRAM_ID];

  // Instruction data: [0xCA] + sourceVm u8 + targetVm u8 + targetAddress 32 bytes + calldata
  const data: number[] = [];
  writeU8(data, 0xca); // cross-VM marker
  writeU8(data, sourceVm);
  writeU8(data, targetVm);
  writeBytes(data, targetAddressKey);
  writeBytes(data, calldata);

  const instruction: CompiledInstruction = {
    programIdIndex: 1, // EVM program
    accounts: new Uint8Array([0]), // caller
    data: new Uint8Array(data),
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // caller is signer
    0,
    1  // EVM program readonly
  );

  return unsignedTransaction(msg);
}

// ---------------------------------------------------------------------------
// Deploy Instructions (WASM/Move/SVM)
// ---------------------------------------------------------------------------

export function buildWasmDeployTx(
  deployer: string,
  wasmBytes: Uint8Array,
  recentBlockhash: string
): Uint8Array {
  const deployerKey = pubkeyBytes(deployer);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: deployer(0), WASM program(1)
  const accountKeys = [deployerKey, WASM_PROGRAM_ID];

  const instruction: CompiledInstruction = {
    programIdIndex: 1, // WASM program
    accounts: new Uint8Array([0]), // deployer
    data: wasmBytes,
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // deployer is signer
    0,
    1  // WASM program readonly
  );

  return unsignedTransaction(msg);
}

export function buildMoveDeployTx(
  deployer: string,
  moveBytes: Uint8Array,
  recentBlockhash: string
): Uint8Array {
  const deployerKey = pubkeyBytes(deployer);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: deployer(0), Move program(1)
  const accountKeys = [deployerKey, MOVE_PROGRAM_ID];

  const instruction: CompiledInstruction = {
    programIdIndex: 1, // Move program
    accounts: new Uint8Array([0]), // deployer
    data: moveBytes,
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // deployer is signer
    0,
    1  // Move program readonly
  );

  return unsignedTransaction(msg);
}

export function buildSvmDeployTx(
  deployer: string,
  programBytes: Uint8Array,
  recentBlockhash: string
): Uint8Array {
  const deployerKey = pubkeyBytes(deployer);
  const blockhash = blockhashBytes(recentBlockhash);

  // Account keys: deployer(0), BPF Loader program(1)
  const accountKeys = [deployerKey, BPF_LOADER_PROGRAM_ID];

  const instruction: CompiledInstruction = {
    programIdIndex: 1, // BPF Loader program
    accounts: new Uint8Array([0]), // deployer
    data: programBytes,
  };

  const msg = buildMessage(
    accountKeys,
    blockhash,
    [instruction],
    1, // deployer is signer
    0,
    1  // BPF Loader program readonly
  );

  return unsignedTransaction(msg);
}
