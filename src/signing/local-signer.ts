import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import bs58 from "bs58";
import type { Signer, SignerFactory } from "./signer-interface.js";
import { WalletStore } from "./wallet-store.js";
import { currentScope } from "./session-context.js";

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
  // Wallets are scoped per caller via the AsyncLocalStorage in session-context.ts.
  // Authed SSE calls land in a scope keyed by `session.sub` (thirdweb address);
  // stdio uses `"__stdio__"`, dev-bypass uses `"__dev__"`.
  //
  // We also keep a matching WalletStore per scope so each scope has its own
  // encrypted file on disk (`~/.eto/wallets/<scope>.enc`). This is what makes
  // P0-01 (wallet persistence across reconnects) work — the same thirdweb
  // identity always lands on the same wallets regardless of SSE sessionId churn.
  private readonly walletsByScope = new Map<string, Map<string, WalletEntry>>();
  private readonly storesByScope = new Map<string, WalletStore>();
  private readonly configured: boolean;

  constructor() {
    // Check configuration via a probe store; all scope stores share the same
    // ETO_WALLET_PASSPHRASE and so share the same isConfigured() result.
    this.configured = new WalletStore("__probe__").isConfigured();
    if (!this.configured) {
      console.error("[eto-mcp] Warning: ETO_WALLET_PASSPHRASE not set — wallets stored in-memory only");
    }
  }

  private walletsForScope(scope: string): Map<string, WalletEntry> {
    let m = this.walletsByScope.get(scope);
    if (!m) {
      m = new Map();
      this.walletsByScope.set(scope, m);
    }
    return m;
  }

  private storeFor(scope: string): WalletStore {
    let s = this.storesByScope.get(scope);
    if (!s) {
      s = new WalletStore(scope);
      this.storesByScope.set(scope, s);
      if (this.configured) {
        // Kick off an async load into the scope's in-memory map. Subsequent
        // ensureLoaded()s wait on the same promise.
        s.beginLoad(loaded => {
          const bucket = this.walletsForScope(scope);
          for (const [id, w] of loaded) bucket.set(id, w);
        });
      }
    }
    return s;
  }

  private wallets(): Map<string, WalletEntry> {
    return this.walletsForScope(currentScope());
  }

  private toWalletData(entry: WalletEntry): { label: string; privateKey: Uint8Array; publicKey: Uint8Array } {
    return { label: entry.label, privateKey: entry.privateKey, publicKey: entry.publicKey };
  }

  private async persistScope(scope: string): Promise<void> {
    if (!this.configured) return;
    const bucket = this.walletsForScope(scope);
    const serializable = new Map<string, { label: string; privateKey: Uint8Array; publicKey: Uint8Array }>();
    for (const [id, w] of bucket) serializable.set(id, this.toWalletData(w));
    await this.storeFor(scope).save(serializable);
  }

  async createWallet(label: string): Promise<{ walletId: string; svmAddress: string; evmAddress: string }> {
    const scope = currentScope();
    await this.storeFor(scope).ensureLoaded();
    const privateKey = new Uint8Array(32);
    crypto.getRandomValues(privateKey);
    const publicKey = ed.getPublicKey(privateKey);
    const walletId = crypto.randomUUID();

    this.wallets().set(walletId, { label, privateKey, publicKey });
    await this.persistScope(scope);

    const signer = new LocalSigner(privateKey);
    return {
      walletId,
      svmAddress: signer.getPublicKey(),
      evmAddress: signer.getEvmAddress(),
    };
  }

  async getSigner(walletId: string): Promise<Signer> {
    const scope = currentScope();
    await this.storeFor(scope).ensureLoaded();
    const entry = this.wallets().get(walletId);
    if (!entry) {
      throw new Error(`Wallet not found: ${walletId}`);
    }
    return new LocalSigner(entry.privateKey);
  }

  async listWallets(): Promise<string[]> {
    const scope = currentScope();
    await this.storeFor(scope).ensureLoaded();
    return Array.from(this.wallets().keys());
  }

  async importWallet(label: string, privateKeyHex: string): Promise<{ walletId: string; svmAddress: string; evmAddress: string }> {
    const scope = currentScope();
    await this.storeFor(scope).ensureLoaded();

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

    this.wallets().set(walletId, { label, privateKey, publicKey });
    await this.persistScope(scope);

    const signer = new LocalSigner(privateKey);
    return {
      walletId,
      svmAddress: signer.getPublicKey(),
      evmAddress: signer.getEvmAddress(),
    };
  }

  /** Expose the scope's store for callers that need readActive()/writeActive(). */
  storeForScope(scope: string): WalletStore {
    return this.storeFor(scope);
  }

  /** Look up a wallet entry in a specific scope without switching scopes. */
  getWalletEntry(scope: string, walletId: string): WalletEntry | undefined {
    return this.walletsForScope(scope).get(walletId);
  }
}

export const localSignerFactory = new LocalSignerFactory();
