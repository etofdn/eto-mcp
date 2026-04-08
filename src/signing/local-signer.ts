import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import bs58 from "bs58";
import type { Signer, SignerFactory } from "./signer-interface.js";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export class LocalSigner implements Signer {
  private readonly privateKey: Uint8Array;

  constructor(privateKey: Uint8Array) {
    this.privateKey = privateKey;
  }

  async sign(txBytes: Uint8Array): Promise<Uint8Array> {
    // Parse Borsh-serialized transaction:
    // - First 4 bytes: u32 LE signature count
    // - Next count*64 bytes: signature slots
    // - Everything after: the message bytes
    const sigCount = new DataView(txBytes.buffer, txBytes.byteOffset, 4).getUint32(0, true);
    const messageOffset = 4 + sigCount * 64;
    const messageBytes = txBytes.slice(messageOffset);

    const signature = await ed.sign(messageBytes, this.privateKey);

    // Replace the first signature slot (bytes 4..68) with the real signature
    const result = new Uint8Array(txBytes);
    result.set(signature, 4);
    return result;
  }

  getPublicKey(): string {
    const pubKey = ed.getPublicKey(this.privateKey);
    return bs58.encode(pubKey);
  }

  getEvmAddress(): string {
    const pubKey = ed.getPublicKey(this.privateKey);
    // Last 20 bytes of public key, 0x-prefixed hex
    const last20 = pubKey.slice(12);
    const hex = Array.from(last20)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `0x${hex}`;
  }
}

interface WalletEntry {
  label: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export class LocalSignerFactory implements SignerFactory {
  private readonly wallets = new Map<string, WalletEntry>();

  async createWallet(label: string): Promise<{ walletId: string; svmAddress: string; evmAddress: string }> {
    const privateKey = new Uint8Array(32);
    crypto.getRandomValues(privateKey);
    const publicKey = ed.getPublicKey(privateKey);
    const walletId = crypto.randomUUID();

    this.wallets.set(walletId, { label, privateKey, publicKey });

    const signer = new LocalSigner(privateKey);
    return {
      walletId,
      svmAddress: signer.getPublicKey(),
      evmAddress: signer.getEvmAddress(),
    };
  }

  async getSigner(walletId: string): Promise<Signer> {
    const entry = this.wallets.get(walletId);
    if (!entry) {
      throw new Error(`Wallet not found: ${walletId}`);
    }
    return new LocalSigner(entry.privateKey);
  }

  async listWallets(): Promise<string[]> {
    return Array.from(this.wallets.keys());
  }

  importWallet(label: string, privateKeyHex: string): { walletId: string; svmAddress: string; evmAddress: string } {
    const hex = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
    if (hex.length !== 64) {
      throw new Error("Private key must be 32 bytes (64 hex characters)");
    }
    const privateKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      privateKey[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const publicKey = ed.getPublicKey(privateKey);
    const walletId = crypto.randomUUID();

    this.wallets.set(walletId, { label, privateKey, publicKey });

    const signer = new LocalSigner(privateKey);
    return {
      walletId,
      svmAddress: signer.getPublicKey(),
      evmAddress: signer.getEvmAddress(),
    };
  }
}

export const localSignerFactory = new LocalSignerFactory();
