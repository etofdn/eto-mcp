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

/**
 * Registry interface for SVM↔EVM address lookups.
 *
 * Implemented by WalletStore and any test double. The registry is populated at
 * wallet-creation time (see LocalSignerFactory.createWallet / importWallet) and
 * is the single source of truth for the SVM→EVM bijection (FN-015 Option B).
 */
export interface WalletRegistry {
  /** Returns the canonical EVM address for a given SVM pubkey, or undefined if unmapped. */
  lookupBySvm(svmAddress: string): string | undefined;
  /** Returns the canonical SVM pubkey for a given EVM address, or undefined if unmapped. */
  lookupByEvm(evmAddress: string): string | undefined;
}

/**
 * Forward derivation stub: SVM pubkey (32 bytes) → EVM address.
 *
 * **Algorithm:** Registry-backed bijection (FN-015 recommendation, Option B).
 * The EVM address for a LocalSigner wallet equals `signer.getEvmSigningAddress()`,
 * which is derived via HKDF-SHA256(privateKey) → secp256k1 → keccak256. This
 * derivation requires the Ed25519 *private* key and cannot be recomputed from
 * the 32-byte public key alone.
 *
 * Therefore this function always throws — call `resolveAddressesAsync` with a
 * `WalletRegistry` instead, or call `signer.getEvmAddress()` directly when the
 * signer is available.
 *
 * @throws Always — SVM→EVM requires a registry lookup (FN-016).
 *         Use `resolveAddressesAsync(svmAddr, registry)` for mapped wallets.
 * @see resolveAddressesAsync
 * @see WalletRegistry
 * @deprecated — retained for type-compatibility only; body is replaced in FN-016.
 *   The inverse (`EVM→SVM`) is implemented in FN-017.
 */
export function pubkeyToEvmAddress(_pubkey: Uint8Array): string {
  throw new Error(
    "SVM→EVM address derivation requires a registry lookup (FN-016). " +
    "Use resolveAddressesAsync(addr, registry) for wallet-backed addresses, " +
    "or call signer.getEvmAddress() when the signer is available.",
  );
}

/**
 * EVM address (20 bytes) → SVM pubkey stub.
 *
 * Body is intentionally left for FN-017 to implement. The current SHA-256
 * preimage is retained to keep the function compilable; FN-017 will replace it
 * with a registry-backed inverse lookup.
 *
 * @deprecated — body is a placeholder; the correct inverse is implemented in FN-017.
 */
export function evmAddressToPubkey(evmAddr: string): Uint8Array {
  const addrBytes = hexToBytes(evmAddr.replace("0x", ""));
  const preimage = new Uint8Array(4 + 20);
  preimage.set(new TextEncoder().encode("evm:"), 0);
  preimage.set(addrBytes, 4);
  return sha256(preimage);
}

/**
 * Registry-backed resolver: converts an SVM or EVM address to both formats.
 *
 * **Algorithm:** FN-015 Option B (registry-backed bijection).
 *
 * - SVM input: looks up the registry for the canonical EVM address populated at
 *   wallet-creation time via `signer.getEvmSigningAddress()`.
 * - EVM input: looks up the registry for the canonical SVM pubkey.
 * - If no registry entry exists for the address, throws with an explicit
 *   "unmapped" error — the function never fabricates an address.
 *
 * @param addr  SVM base58 pubkey or 0x-prefixed EVM address.
 * @param registry  WalletRegistry providing the SVM↔EVM mapping.
 * @returns  Both `svm` (base58) and `evm` (0x-prefixed lowercase) addresses.
 * @throws  If the address has no registry entry.
 */
export async function resolveAddressesAsync(
  addr: string,
  registry: WalletRegistry,
): Promise<{ svm: string; evm: string }> {
  const trimmed = addr.trim();

  if (isValidEvmAddress(trimmed)) {
    const normalized = trimmed.toLowerCase();
    const svm = registry.lookupByEvm(normalized);
    if (!svm) {
      throw new Error(
        `EVM address ${trimmed} is not registered in any known wallet. ` +
        "Create or import a wallet to establish the SVM↔EVM mapping.",
      );
    }
    return { svm, evm: normalized };
  }

  if (isValidSvmAddress(trimmed)) {
    const evm = registry.lookupBySvm(trimmed);
    if (!evm) {
      throw new Error(
        `SVM address ${trimmed} is not registered in any known wallet. ` +
        "Create or import a wallet to establish the SVM↔EVM mapping.",
      );
    }
    return { svm: trimmed, evm };
  }

  throw new Error(
    `Invalid address: "${trimmed}". Expected a base58 SVM pubkey (32 bytes) or a 0x-prefixed EVM address (20 bytes).`,
  );
}

/**
 * Synchronous address resolver — **retained for backward-compatibility only**.
 *
 * This function can no longer compute SVM→EVM or EVM→SVM mappings without a
 * registry (FN-015 Option B).  Call sites that only need address validation /
 * pass-through (i.e. they use only the same-type output field) still compile
 * correctly.  Any call site that needs a cross-VM conversion MUST switch to
 * `resolveAddressesAsync`.
 *
 * Behavior:
 * - SVM input: `{ svm: addr, evm: "<unmapped — use resolveAddressesAsync>" }`
 * - EVM input: `{ svm: "<unmapped — use resolveAddressesAsync>", evm: addr.toLowerCase() }`
 *
 * @deprecated  For cross-VM resolution use `resolveAddressesAsync` with a
 *   `WalletRegistry` (FN-016).  This function is kept so existing call sites
 *   that only consume the same-type field continue to compile.
 */
export function resolveAddresses(addr: string): { svm: string; evm: string } {
  const trimmed = addr.trim();
  if (isValidEvmAddress(trimmed)) {
    return {
      svm: "<unmapped — use resolveAddressesAsync>",
      evm: trimmed.toLowerCase(),
    };
  }
  return {
    svm: trimmed,
    evm: "<unmapped — use resolveAddressesAsync>",
  };
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
