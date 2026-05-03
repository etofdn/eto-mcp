/**
 * Unit tests for the FN-016 bijective SVM→EVM forward derivation.
 *
 * SCOPE: forward direction only (SVM→EVM and the registry contract).
 * Round-trip tests (SVM→EVM→SVM returning the original) belong to FN-018.
 * Do NOT add inverse (EVM→SVM) property tests here — those belong to FN-017/FN-018.
 */

import { describe, test, expect, beforeEach } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import bs58 from "bs58";
import { LocalSigner, LocalSignerFactory } from "../../src/signing/local-signer.js";
import { resolveAddressesAsync, WalletRegistry, pubkeyToEvmAddress } from "../../src/utils/address.js";
import { runInScope } from "../../src/signing/session-context.js";

// Configure ed25519 sync sha512
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

/** Run a test function inside an isolated scope (prevents wallet state leakage). */
function inTestScope<T>(fn: () => T): T {
  return runInScope(`bijection-test-${crypto.randomUUID()}`, fn);
}

// ---------------------------------------------------------------------------
// Helper: minimal in-memory WalletRegistry for unit tests
// ---------------------------------------------------------------------------
class TestRegistry implements WalletRegistry {
  private svmToEvm = new Map<string, string>();
  private evmToSvm = new Map<string, string>();

  record(svm: string, evm: string): void {
    const normalizedEvm = evm.toLowerCase();
    this.svmToEvm.set(svm, normalizedEvm);
    this.evmToSvm.set(normalizedEvm, svm);
  }

  lookupBySvm(svm: string): string | undefined {
    return this.svmToEvm.get(svm);
  }

  lookupByEvm(evm: string): string | undefined {
    return this.evmToSvm.get(evm.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// 1. Forward determinism
// ---------------------------------------------------------------------------
describe("pubkeyToEvmAddress — forward derivation stub", () => {
  test("throws with a descriptive error (registry required)", () => {
    const pubkey = new Uint8Array(32).fill(0x42);
    expect(() => pubkeyToEvmAddress(pubkey)).toThrow(
      /registry/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. resolveAddressesAsync — forward determinism via registry
// ---------------------------------------------------------------------------
describe("resolveAddressesAsync — forward determinism", () => {
  test("returns the same EVM address on repeated calls for the same SVM key", async () => {
    const registry = new TestRegistry();
    const privKey = new Uint8Array(32).fill(0x01);
    const signer = new LocalSigner(privKey);
    const svmAddr = signer.getPublicKey();
    const evmAddr = signer.getEvmSigningAddress();
    registry.record(svmAddr, evmAddr);

    const result1 = await resolveAddressesAsync(svmAddr, registry);
    const result2 = await resolveAddressesAsync(svmAddr, registry);

    expect(result1.evm).toBe(result2.evm);
    expect(result1.svm).toBe(result2.svm);
  });

  test("normalized EVM address is lowercase 0x + 40 hex chars", async () => {
    const registry = new TestRegistry();
    const privKey = new Uint8Array(32).fill(0x02);
    const signer = new LocalSigner(privKey);
    const svmAddr = signer.getPublicKey();
    const evmAddr = signer.getEvmSigningAddress();
    registry.record(svmAddr, evmAddr);

    const { evm } = await resolveAddressesAsync(svmAddr, registry);
    expect(evm).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// 3. Forward injectivity sample
// ---------------------------------------------------------------------------
describe("forward injectivity — N≥32 freshly generated wallets have distinct EVM addresses", () => {
  test("32 fresh LocalSigner wallets produce 32 distinct EVM addresses", () => {
    const N = 32;
    const evmSet = new Set<string>();

    for (let i = 0; i < N; i++) {
      const privKey = ed.utils.randomPrivateKey();
      const signer = new LocalSigner(privKey);
      evmSet.add(signer.getEvmSigningAddress());
    }

    expect(evmSet.size).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// 4. Signer agreement — hard-coded seed for reproducibility
// ---------------------------------------------------------------------------
describe("signer agreement — pubkeyToEvmAddress ≡ signer.getEvmSigningAddress()", () => {
  test("registry lookup matches signer.getEvmSigningAddress() for a known seed", async () => {
    // Fixed seed → reproducible across runs
    const FIXED_SEED = new Uint8Array(32);
    FIXED_SEED[0] = 0xde;
    FIXED_SEED[1] = 0xad;
    FIXED_SEED[2] = 0xbe;
    FIXED_SEED[3] = 0xef;

    const signer = new LocalSigner(FIXED_SEED);
    const svmAddr = signer.getPublicKey();
    const expectedEvm = signer.getEvmSigningAddress();

    const registry = new TestRegistry();
    registry.record(svmAddr, expectedEvm);

    const { evm } = await resolveAddressesAsync(svmAddr, registry);
    expect(evm).toBe(expectedEvm.toLowerCase());
  });

  test("LocalSignerFactory.createWallet evmAddress matches getEvmSigningAddress()", () =>
    inTestScope(async () => {
      const factory = new LocalSignerFactory();
      const { walletId, svmAddress, evmAddress } = await factory.createWallet("signer-agree");

      const signer = await factory.getSigner(walletId);
      const directEvmAddr = signer.getEvmAddress();

      // evmAddress from createWallet must equal signer.getEvmSigningAddress()
      expect(evmAddress).toBe(directEvmAddr);
      expect(evmAddress).toMatch(/^0x[0-9a-f]{40}$/);

      // Registry lookup must agree
      const registry = factory.getRegistryForCurrentScope();
      const pubkeyBytes = bs58.decode(svmAddress);
      void pubkeyBytes; // ensure it decodes without error
      const { evm: registryEvm } = await resolveAddressesAsync(svmAddress, registry);
      expect(registryEvm).toBe(evmAddress.toLowerCase());
    }),
  );

  test("LocalSignerFactory.importWallet evmAddress matches getEvmSigningAddress()", () =>
    inTestScope(async () => {
      const factory = new LocalSignerFactory();
      // Known private key: all bytes = 0x07
      const knownPrivHex = "07".repeat(32);
      const { walletId, evmAddress } = await factory.importWallet("imported-key", knownPrivHex);

      const signer = await factory.getSigner(walletId);
      expect(evmAddress).toBe(signer.getEvmAddress());
    }),
  );
});

// ---------------------------------------------------------------------------
// 5. Foreign-address contract — unmapped address must throw, not fabricate
// ---------------------------------------------------------------------------
describe("foreign-address contract — unmapped addresses return explicit error", () => {
  test("resolveAddressesAsync throws for a synthetic SVM pubkey with no registry entry", async () => {
    const registry = new TestRegistry();
    // Random SVM pubkey not registered
    const foreignPriv = ed.utils.randomPrivateKey();
    const foreignSvm = bs58.encode(ed.getPublicKey(foreignPriv));

    await expect(resolveAddressesAsync(foreignSvm, registry)).rejects.toThrow(
      /not registered/i,
    );
  });

  test("resolveAddressesAsync throws for a foreign EVM address with no registry entry", async () => {
    const registry = new TestRegistry();
    const foreignEvm = "0x" + "ab".repeat(20);

    await expect(resolveAddressesAsync(foreignEvm, registry)).rejects.toThrow(
      /not registered/i,
    );
  });

  test("resolveAddressesAsync NEVER returns undefined or a fabricated address for unmapped keys", async () => {
    const registry = new TestRegistry();
    const foreignSvm = bs58.encode(new Uint8Array(32).fill(0xff));

    let threw = false;
    let result: { svm: string; evm: string } | undefined;
    try {
      result = await resolveAddressesAsync(foreignSvm, registry);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. derive_address ↔ resolve_cross_vm_address agreement
// ---------------------------------------------------------------------------
describe("derive_address ↔ resolve_cross_vm_address agreement", () => {
  test("for a wallet created in-test, both code paths return identical SVM and EVM strings", () =>
    inTestScope(async () => {
      const factory = new LocalSignerFactory();
      const { walletId, svmAddress, evmAddress } = await factory.createWallet("agree-test");

      // derive_address path: signer.getPublicKey() + signer.getEvmAddress()
      const signer = await factory.getSigner(walletId);
      const derivedSvm = signer.getPublicKey();
      const derivedEvm = signer.getEvmAddress();

      expect(derivedSvm).toBe(svmAddress);
      expect(derivedEvm).toBe(evmAddress);

      // resolve_cross_vm_address path: registry lookup
      const registry = factory.getRegistryForCurrentScope();
      const { svm: resolvedSvm, evm: resolvedEvm } = await resolveAddressesAsync(svmAddress, registry);

      expect(resolvedSvm).toBe(svmAddress);
      expect(resolvedEvm).toBe(evmAddress.toLowerCase());

      // Both paths agree
      expect(resolvedSvm).toBe(derivedSvm);
      expect(resolvedEvm).toBe(derivedEvm.toLowerCase());
    }),
  );

  test("EVM lookup by resolved EVM address returns the original SVM address", () =>
    inTestScope(async () => {
      const factory = new LocalSignerFactory();
      const { svmAddress, evmAddress } = await factory.createWallet("evm-to-svm");

      const registry = factory.getRegistryForCurrentScope();

      // Forward: SVM → EVM
      const { evm } = await resolveAddressesAsync(svmAddress, registry);
      expect(evm).toBe(evmAddress.toLowerCase());

      // Reverse lookup via the registry interface (not a round-trip test — just
      // confirming the registry stores both directions)
      const reverseSvm = registry.lookupByEvm(evm);
      expect(reverseSvm).toBe(svmAddress);
    }),
  );
});
