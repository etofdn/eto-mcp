import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";

export function isValidSvmAddress(addr: string): boolean {
  try {
    const bytes = bs58.decode(addr);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

export function isValidEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export function isValidAddress(addr: string): boolean {
  return isValidSvmAddress(addr) || isValidEvmAddress(addr);
}

export function detectAddressType(addr: string): "svm" | "evm" | "unknown" {
  if (isValidEvmAddress(addr)) return "evm";
  if (isValidSvmAddress(addr)) return "svm";
  return "unknown";
}

/** SVM pubkey (32 bytes) → EVM address (last 20 bytes) */
export function pubkeyToEvmAddress(pubkey: Uint8Array): string {
  const addr = pubkey.slice(12, 32);
  return "0x" + Buffer.from(addr).toString("hex");
}

/** EVM address (20 bytes) → SVM pubkey via SHA256("evm:" || addr) */
export function evmAddressToPubkey(evmAddr: string): Uint8Array {
  const addrBytes = hexToBytes(evmAddr.replace("0x", ""));
  const preimage = new Uint8Array(4 + 20);
  preimage.set(new TextEncoder().encode("evm:"), 0);
  preimage.set(addrBytes, 4);
  return sha256(preimage);
}

/** Convert base58 SVM address to both SVM and EVM formats */
export function resolveAddresses(addr: string): { svm: string; evm: string } {
  if (isValidEvmAddress(addr)) {
    const pubkey = evmAddressToPubkey(addr);
    return { svm: bs58.encode(pubkey), evm: addr.toLowerCase() };
  }
  const pubkey = bs58.decode(addr);
  return { svm: addr, evm: pubkeyToEvmAddress(pubkey) };
}

export function pubkeyToBase58(pubkey: Uint8Array): string {
  return bs58.encode(pubkey);
}

export function base58ToPubkey(addr: string): Uint8Array {
  return bs58.decode(addr);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}
