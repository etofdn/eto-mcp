import { describe, test, expect } from "bun:test";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import bs58 from "bs58";
import { LocalSigner, LocalSignerFactory } from "../../src/signing/local-signer.js";

// Configure ed25519 sync sha512
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

describe("LocalSignerFactory.createWallet", () => {
  test("returns walletId, svmAddress, evmAddress", async () => {
    const factory = new LocalSignerFactory();
    const result = await factory.createWallet("test-wallet");
    expect(typeof result.walletId).toBe("string");
    expect(result.walletId.length).toBeGreaterThan(0);
    expect(typeof result.svmAddress).toBe("string");
    expect(typeof result.evmAddress).toBe("string");
  });

  test("svmAddress decodes to 32 bytes (valid base58)", async () => {
    const factory = new LocalSignerFactory();
    const { svmAddress } = await factory.createWallet("test");
    const bytes = bs58.decode(svmAddress);
    expect(bytes.length).toBe(32);
  });

  test("evmAddress is valid 0x + 40 hex chars", async () => {
    const factory = new LocalSignerFactory();
    const { evmAddress } = await factory.createWallet("test");
    expect(evmAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test("walletId is a UUID format string", async () => {
    const factory = new LocalSignerFactory();
    const { walletId } = await factory.createWallet("test");
    expect(walletId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("each createWallet call generates unique wallet", async () => {
    const factory = new LocalSignerFactory();
    const w1 = await factory.createWallet("a");
    const w2 = await factory.createWallet("b");
    expect(w1.walletId).not.toBe(w2.walletId);
    expect(w1.svmAddress).not.toBe(w2.svmAddress);
    expect(w1.evmAddress).not.toBe(w2.evmAddress);
  });
});

describe("LocalSignerFactory.importWallet", () => {
  test("imports known private key and returns expected addresses", () => {
    const factory = new LocalSignerFactory();
    // Known 32-byte private key (all 0x01 bytes)
    const knownPrivKey = "01".repeat(32);
    const result = factory.importWallet("imported", knownPrivKey);

    // Derive expected addresses from known key
    const privBytes = new Uint8Array(32).fill(0x01);
    const pubBytes = ed.getPublicKey(privBytes);
    const expectedSvm = bs58.encode(pubBytes);
    const last20 = pubBytes.slice(12);
    const expectedEvm = "0x" + Array.from(last20).map(b => b.toString(16).padStart(2, "0")).join("");

    expect(result.svmAddress).toBe(expectedSvm);
    expect(result.evmAddress).toBe(expectedEvm);
  });

  test("imported wallet has valid walletId", () => {
    const factory = new LocalSignerFactory();
    const result = factory.importWallet("imp", "aa".repeat(32));
    expect(result.walletId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("accepts 0x-prefixed private key", () => {
    const factory = new LocalSignerFactory();
    const hex = "02".repeat(32);
    const result1 = factory.importWallet("a", hex);
    const result2 = factory.importWallet("b", "0x" + hex);
    expect(result1.svmAddress).toBe(result2.svmAddress);
    expect(result1.evmAddress).toBe(result2.evmAddress);
  });

  test("throws for wrong-length private key", () => {
    const factory = new LocalSignerFactory();
    expect(() => factory.importWallet("bad", "aabb")).toThrow();
    expect(() => factory.importWallet("bad", "aa".repeat(31))).toThrow();
  });
});

describe("LocalSignerFactory.listWallets", () => {
  test("returns empty array initially", async () => {
    const factory = new LocalSignerFactory();
    const wallets = await factory.listWallets();
    expect(wallets).toEqual([]);
  });

  test("includes walletIds after creation", async () => {
    const factory = new LocalSignerFactory();
    const w1 = await factory.createWallet("a");
    const w2 = await factory.createWallet("b");
    const list = await factory.listWallets();
    expect(list).toContain(w1.walletId);
    expect(list).toContain(w2.walletId);
    expect(list.length).toBe(2);
  });

  test("includes imported wallet", async () => {
    const factory = new LocalSignerFactory();
    const imported = factory.importWallet("imp", "cc".repeat(32));
    const list = await factory.listWallets();
    expect(list).toContain(imported.walletId);
  });
});

describe("LocalSignerFactory.getSigner", () => {
  test("throws for unknown walletId", async () => {
    const factory = new LocalSignerFactory();
    expect(factory.getSigner("nonexistent-id")).rejects.toThrow();
  });

  test("returns signer for created wallet", async () => {
    const factory = new LocalSignerFactory();
    const { walletId, svmAddress } = await factory.createWallet("test");
    const signer = await factory.getSigner(walletId);
    expect(signer.getPublicKey()).toBe(svmAddress);
  });
});

describe("LocalSigner sign + verify round-trip", () => {
  test("signed transaction verifies with @noble/ed25519", async () => {
    // Create a minimal Borsh-encoded transaction: [u32 LE sigCount=1] [64 zero bytes] [message]
    const messageBytes = new TextEncoder().encode("hello world test message for signing");
    const sigCount = 1;
    const txBytes = new Uint8Array(4 + 64 + messageBytes.length);
    // Write sig count as u32 LE
    new DataView(txBytes.buffer).setUint32(0, sigCount, true);
    // signature slot at bytes 4..68 (zeros)
    txBytes.set(messageBytes, 4 + 64);

    const privKey = ed.utils.randomPrivateKey();
    const signer = new LocalSigner(privKey);

    const signed = await signer.sign(txBytes);

    // Extract the signature from bytes 4..68
    const signature = signed.slice(4, 68);
    const pubKey = ed.getPublicKey(privKey);

    const valid = ed.verify(signature, messageBytes, pubKey);
    expect(valid).toBe(true);
  });

  test("sign replaces first signature slot with real signature", async () => {
    const message = new Uint8Array(32).fill(0xab);
    const txBytes = new Uint8Array(4 + 64 + message.length);
    new DataView(txBytes.buffer).setUint32(0, 1, true);
    txBytes.set(message, 68);

    const privKey = ed.utils.randomPrivateKey();
    const signer = new LocalSigner(privKey);
    const signed = await signer.sign(txBytes);

    // The signature slot should no longer be all zeros
    const sigSlot = signed.slice(4, 68);
    expect(sigSlot.every(b => b === 0)).toBe(false);
  });

  test("getPublicKey returns consistent base58 address", async () => {
    const factory = new LocalSignerFactory();
    const { walletId, svmAddress } = await factory.createWallet("test");
    const signer = await factory.getSigner(walletId);
    expect(signer.getPublicKey()).toBe(svmAddress);
  });

  test("getEvmAddress returns 0x + 40 hex chars", async () => {
    const factory = new LocalSignerFactory();
    const { walletId, evmAddress } = await factory.createWallet("test");
    const signer = await factory.getSigner(walletId);
    expect(signer.getEvmAddress()).toBe(evmAddress);
    expect(evmAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test("sign arbitrary bytes verifies correctly", async () => {
    const privKey = ed.utils.randomPrivateKey();
    const signer = new LocalSigner(privKey);
    const pubKeyBytes = ed.getPublicKey(privKey);

    // Build a tx with arbitrary message
    const message = crypto.getRandomValues(new Uint8Array(64));
    const tx = new Uint8Array(4 + 64 + message.length);
    new DataView(tx.buffer).setUint32(0, 1, true);
    tx.set(message, 68);

    const signed = await signer.sign(tx);
    const sig = signed.slice(4, 68);

    expect(ed.verify(sig, message, pubKeyBytes)).toBe(true);
  });
});
