# FN-015: Bijective SVM↔EVM Cross-VM Address Derivation — Research & Recommendation

**Task:** FN-015  
**Date:** 2026-05-02  
**Status:** Research deliverable — no code changes  
**Downstream:** FN-016 (forward derivation fix), FN-017 (inverse derivation fix), FN-020/FN-123/FN-133 (tool description updates)

---

## 1. Problem Statement

### 1.1 Formal Bijection Requirement

Define:

- **S** = the set of all valid SVM addresses used within ETO (32-byte Ed25519 public keys, base58-encoded).
- **E** = the set of all valid EVM addresses used within ETO (20-byte Keccak-derived addresses, 0x-hex-encoded).

We want two functions:

```
f : S → E    (SVM → EVM, "forward derivation")
g : E → S    (EVM → SVM, "inverse derivation")
```

such that, for every ETO-native wallet address `s ∈ S`:

```
g(f(s)) = s    [round-trip SVM→EVM→SVM restores original SVM address]
```

and ideally, for every ETO-native wallet address `e ∈ E`:

```
f(g(e)) = e    [round-trip EVM→SVM→EVM restores original EVM address]
```

The functions `f` and `g` form an **injective pair** (each direction is injective on the domain of ETO-native wallets). A *total* bijection over all 32-byte and 20-byte values is impossible due to the cardinality gap described below.

### 1.2 Current Broken State

`src/utils/address.ts` implements:

```ts
// pubkeyToEvmAddress: SVM → EVM (BROKEN — lossy, non-injective)
pubkey.slice(12, 32)  →  "0x" + hex
// evmAddressToPubkey: EVM → SVM (BROKEN — not the inverse of above)
sha256("evm:" || raw_20_bytes)  →  32-byte pubkey
```

The round-trip `evmAddressToPubkey(pubkeyToEvmAddress(p)) ≠ p` for any valid Ed25519 pubkey `p` because:

1. The forward direction discards the first 12 bytes of the 32-byte pubkey (96 bits of information are lost — the mapping is 2^96-to-one, not injective).
2. The inverse direction is a SHA256 hash of the 20-byte address, producing a completely new 32-byte value that has no relationship to the original pubkey.

Additionally, `src/wasm/index.ts` contains a *second* implementation of the same two functions with an additional bug: `evmAddressToPubkey` calls `new TextEncoder().encode(hexString)` on the hex-encoded address string (encoding ASCII characters as UTF-8 bytes) rather than parsing the hex digits into raw bytes. This produces a *third* divergent address space.

`src/signing/local-signer.ts` meanwhile computes the real EVM address via a completely independent derivation:

```ts
// LocalSigner.getEvmSigningAddress(): the address ecrecover returns
HKDF-SHA256(ed25519_privkey, salt="", info="eto-evm-secp256k1-v1", 32)
  → secp256k1_private_key
  → secp256k1.getPublicKey(key, false)   // uncompressed 65 bytes
  → keccak256(pubkey[1:])                 // skip 0x04 prefix
  → last 20 bytes                         // Ethereum address derivation
```

This address is what EVM runtimes recover via `ecrecover` when verifying signatures. `LocalSigner.getEvmAddress()` correctly delegates to `getEvmSigningAddress()`. However, `FrostSigner.getEvmAddress()` still uses the broken `pubkeyBytes.slice(12)` formula.

`wallet.ts`'s `derive_address` tool calls `resolveAddresses(svmAddress)` from `address.ts`, which uses the broken formula — so it returns an address that disagrees with `LocalSigner.getEvmAddress()` even for locally-held wallets.

---

## 2. Cardinality / Impossibility Note

- |SVM address space| = 2^256 (any 32-byte value is syntactically valid as an SVM address, though Ed25519 group elements are a strict subset; the ETO runtime accepts arbitrary 32-byte account keys).
- |EVM address space| = 2^160 (20-byte values).

Because |SVM| >> |EVM|, a **total bijection** between all SVM and all EVM addresses is mathematically impossible by the pigeonhole principle. There are 2^96 SVM addresses for every EVM address under any surjective mapping.

### Achievable goal

The achievable goal is a **bijection restricted to the set of ETO-native wallets** — wallets created and managed by ETO's signer backends (LocalSigner, FrostSigner, PrivySigner). This set is small (bounded by the number of wallets ever created in the system) and can be explicitly enumerated.

**Three disjoint address categories arise from this:**

| Category | SVM input | EVM input | Contract |
|---|---|---|---|
| **ETO-native** | SVM pubkey with a registered EVM counterpart | EVM address with a registered SVM counterpart | Bijective lookup |
| **Foreign SVM** | A base58 pubkey from an external program / user with no registered EVM counterpart | — | `resolve_cross_vm_address` must return an explicit "unmapped" error |
| **Foreign EVM** | — | A 0x address (e.g., MetaMask) with no registered SVM counterpart | `resolve_cross_vm_address` must return an explicit "unmapped" error |

---

## 3. Option A — Deterministic Dual-Curve Derivation from a Single Seed

### Algorithm

Both Ed25519 and secp256k1 keys are derived deterministically from a single master seed — the Ed25519 private key — using HKDF-SHA256. This is **exactly what `LocalSigner` already does**:

```
ed25519_privkey
  → HKDF-SHA256(ikm=privkey, salt="", info="eto-evm-secp256k1-v1", 32)
  → secp256k1_privkey
  → secp256k1.getPublicKey(secp_privkey, false)   // 65-byte uncompressed
  → keccak256(secp_pubkey[1:])
  → last 20 bytes  →  EVM address
```

### Forward Direction (`f`)

`f(svm_pubkey)` **cannot be computed from the SVM pubkey alone**. It requires the Ed25519 *private* key. The secp256k1 public key is mathematically independent of the Ed25519 public key; recovering the secp256k1 private key from the Ed25519 public key is computationally infeasible.

**Implication:** There is no pure function `f(svm_pubkey) → evm_address`. The bijection is realized by the wallet record (seed + derived keys), not by a standalone address-transformation function.

### Inverse Direction (`g`)

Similarly, `g(evm_address) → svm_pubkey` has no pure-function form. It requires either the private seed or a stored mapping.

### Signing Compatibility

✓ **Fully compatible.** This is exactly the address `ecrecover` yields for EVM transactions signed by `LocalSigner.signEvm()`.

### On-Chain Compatibility

✓ On-chain programs that verify EVM signatures using ecrecover will see the correct signer address.

### Key-Management Implications

- Requires access to the Ed25519 private key to compute the EVM address at derivation time.
- For `FrostSigner` (FROST/threshold signing service): the Ed25519 private key is split across shares; the signing service holds shares. There is no single node that holds the full `ed25519_privkey` to feed into HKDF. Therefore this approach cannot be applied directly to FrostSigner wallets without architectural changes to the signing service (exposing a "derive secp256k1 key" endpoint, or pre-computing the EVM address at wallet creation time and storing it).
- For `PrivySigner`: entirely delegated to Privy; the Ed25519 private key is never held locally. EVM address derivation would require a Privy API call.

### Storage Requirements

- The EVM address must be stored alongside the wallet record (or recomputed on-demand if the private key is accessible). `LocalSigner`'s wallet store already persists private keys, so recomputation is straightforward. FrostSigner and PrivySigner require the EVM address to be pre-computed and stored at wallet creation time.

### Foreign Address Behaviour

For foreign SVM pubkeys (no private key → no secp256k1 derivation), `f` is undefined. For foreign EVM addresses (no origin seed known), `g` is undefined. The resolver must return an "unmapped" error.

### Migration Impact

Existing wallet records encoded with `slice(12,32)` EVM addresses are stale. For `LocalSigner` wallets, the correct EVM address can be recomputed from the stored `privateKey`. A one-time migration script can rewrite all stored EVM addresses.

### Performance

One HKDF invocation + one secp256k1 scalar multiplication + one keccak256 per derivation. Negligible in practice (< 1 ms). The result can be cached in the wallet record to avoid recomputation.

### Security

An attacker cannot grind an SVM pubkey to collide with a victim's EVM address under this scheme without also controlling the victim's Ed25519 private key, because the EVM address is derived from a secp256k1 key itself derived via HKDF from the Ed25519 private key. No preimage attack is feasible.

---

## 4. Option B — Canonical On-Disk / On-Chain Mapping Table (Registry)

### Algorithm

Maintain an explicit bidirectional registry:

```
Registry: svm_address → evm_address   (forward index)
Registry: evm_address → svm_address   (inverse index)
```

Populated at wallet creation time. Both `f` and `g` are **table lookups**.

### Forward Direction (`f`)

`f(svm_address) = registry.svmToEvm[svm_address]` — returns the stored EVM address or `null` if unmapped.

### Inverse Direction (`g`)

`g(evm_address) = registry.evmToSvm[evm_address]` — returns the stored SVM address or `null` if unmapped.

### Signing Compatibility

✓ **Fully compatible**, provided the EVM address stored in the registry is the correct HKDF-secp256k1-keccak256 address (i.e., the EVM address written to the registry at wallet creation is `LocalSigner.getEvmSigningAddress()`). The registry's value is ground truth.

For `FrostSigner`, which cannot produce an EVM signing address today (`getEvmSigningAddress()` throws), the registry would initially store a placeholder or the broken `slice(12)` value until the signing service exposes EVM key derivation.

### On-Chain Compatibility

✓ If the stored EVM address is the signing address, on-chain ecrecover verification remains consistent.

### Key-Management Implications

- The EVM address computation algorithm is **decoupled** from the lookup function. `WalletStore` (or another persistent store) owns the registry. Callers (`cross-vm.ts`, `wallet.ts`) query the registry rather than recomputing.
- The registry write path is the wallet creation flow. No other code path may write EVM addresses; preventing stale entries requires discipline at the write boundary.
- For cross-VM dispatch to a *counterparty* whose mapping is not in the local registry (e.g., looking up a merchant's ETO EVM address given only their SVM pubkey), the registry cannot help. This is the "foreign address" case.

### Storage Requirements

The registry can live in one of three places:

1. **In-memory only (within the same process session):** Fast, zero persistence cost, but lost on restart. Useful for unit tests; insufficient for production.
2. **Sidecar JSON file (per-session, alongside wallet store):** `WalletStore` already persists wallet records as JSON. Adding `evmAddress` as a field to each wallet record is minimal cost. The inverse index can be rebuilt from the forward map on load.
3. **On-chain account (e.g., a PDA):** Enables third parties to query the mapping without trusting the local registry. Adds network round-trip cost and gas/lamports overhead. Overkill for the current use case.

Option 2 (sidecar JSON / wallet record field) is the natural fit given the existing `WalletStore` architecture.

### Foreign Address Behaviour

Foreign addresses are not in the registry. The resolver returns an explicit "unmapped" or "not an ETO-native wallet" error. This is a clean, predictable contract.

### Migration Impact

Existing wallet records must be updated to include the correct `evmAddress` field. For `LocalSigner` wallets this can be computed from the stored private key. A one-time migration script at startup checks whether the stored EVM address (if any) matches the HKDF-derived address; if not, it rewrites the record.

### Performance

One in-memory hash-map lookup per resolution. Constant time O(1), negligible cost. Initial load of the wallet store (typically small — tens to hundreds of wallets) is unchanged.

### Security

The registry cannot be ground-attacked directly. An attacker who can write to the wallet store already has full key access. Registry poisoning (writing a malicious EVM address) would require control of the wallet creation flow.

---

## 5. Option C — Pure-Function Derivation via Hash + Truncation, Registry Only for Inverse

### Algorithm

Forward direction is a **pure function** of the SVM pubkey:

```
f(svm_pubkey) = keccak256("eto-svm-v1:" || svm_pubkey_bytes)[12:]
```

(or a similar canonical hash; `keccak256(svm_pubkey)[12:]` without a domain-separation prefix is a minimal variant).

Inverse direction has **no pure-function form** — keccak256 truncated to 20 bytes is irreversible. A registry is required for `g`.

### Forward Direction (`f`)

Pure, stateless, O(1), no storage required. Works for any 32-byte SVM address including foreign addresses.

### Inverse Direction (`g`)

Registry-only lookup. Foreign EVM addresses (those not derived from a known SVM pubkey via the above formula) return "unmapped".

### Signing Compatibility

✗ **Incompatible.** This is the critical failure of Option C.

`keccak256("eto-svm-v1:" || svm_pubkey_bytes)[12:]` will produce a different EVM address than `LocalSigner.getEvmSigningAddress()`, because the latter is derived from a secp256k1 key generated via HKDF from the Ed25519 *private* key — a cryptographically independent key pair.

If `resolve_cross_vm_address` returns the keccak256-derived EVM address, but the wallet's actual EVM signing address (the one ecrecover yields) is the HKDF-secp256k1-keccak256 address, then:

- Users are shown one EVM address but send EVM transactions from a *different* address.
- EVM contract calls, token transfers, and ecrecover-based authentication silently use the wrong account.
- The ETO balance shown for "your EVM address" would not match the actual on-chain account holding the user's funds.

This is a **hard rejection criterion** per the task specification.

### On-Chain Compatibility

✗ Mismatches on-chain ecrecover outputs for `LocalSigner`-signed transactions.

### Key-Management Implications

The pure-function forward direction is appealing in isolation, but the disconnect between the "resolved" EVM address and the "signing" EVM address makes this option untenable for ETO's signing architecture. Unless ETO transitions to secp256k1 keys as primary wallet keys (a major architectural change outside scope), Option C's EVM addresses are decorative, not functional.

### Storage Requirements

Registry for inverse direction only. Forward direction is stateless.

### Foreign Address Behaviour

Forward: any SVM pubkey maps to an EVM address (including foreign pubkeys). This is an appealing property but creates the misleading impression that foreign SVM addresses have usable ETO EVM counterparts when they do not (no private key → no ability to sign EVM transactions from the derived address).

Inverse: foreign EVM addresses with no registry entry return "unmapped".

### Migration Impact

High. All previously stored EVM addresses (whether derived via `slice(12,32)` or anything else) are invalid under Option C. The migration produces a new set of EVM addresses that *still* do not match signing addresses — so the migration effort produces no signing-correctness benefit.

### Performance

Forward: one keccak256 hash — excellent, ~nanosecond-range. Inverse: registry lookup.

### Security

An attacker could precompute an SVM pubkey whose keccak256 truncation collides with a victim's address, but the 20-byte output space makes this computationally infeasible (2^80 expected operations for collision via birthday paradox). No practical attack.

However, the more important security concern is **false assurance**: users shown a keccak256-derived EVM address may send funds there, only to find those funds are inaccessible because the corresponding secp256k1 private key does not exist.

---

## 6. Trade-Off Matrix

| Criterion | Option A (Dual-curve derivation) | Option B (Registry) | Option C (Pure-hash forward + registry inverse) |
|---|---|---|---|
| **Forward purity** | ✗ Requires private key | ✗ Requires registry | ✓ Pure function of SVM pubkey |
| **Inverse purity** | ✗ Requires private key or registry | ✗ Requires registry | ✗ Requires registry |
| **Agrees with `LocalSigner.getEvmSigningAddress()`** | ✓ Is identical | ✓ Stores the identical value | ✗ Different address space |
| **Foreign SVM address behaviour** | ✗ Undefined (no private key) — error | ✗ Unmapped — error | Partial: produces an EVM address, but no signing ability |
| **Foreign EVM address behaviour** | ✗ Unmapped — error | ✗ Unmapped — error | ✗ Unmapped — error |
| **FrostSigner compatibility** | Partial: signing service must expose secp256k1 derivation endpoint or pre-store address at creation | ✓ Store at creation, no algorithm change needed | ✗ Same signing mismatch as for LocalSigner |
| **Migration cost** | Medium: recompute from stored private keys (only valid for LocalSigner) | Low: add `evmAddress` field to wallet record; seed from HKDF on first access | High: migrate to new address space that still doesn't match signer |
| **Performance (forward)** | Medium: HKDF + secp256k1 mul + keccak256 (~1 ms) | Low: hash-map lookup (< 1 μs) | Low: keccak256 hash (< 1 μs) |
| **Performance (inverse)** | Medium: same | Low: hash-map lookup | Low: hash-map lookup |
| **Security risk** | Low: no grinding attack possible | Low: requires write-access to wallet store | Low (cryptographic), High (UX/key-loss: user sent funds to unreachable address) |
| **Implementation complexity** | Low for LocalSigner; High for FrostSigner/PrivySigner | Low: CRUD on wallet record field | Medium: two divergent address spaces to maintain |

---

## 7. Recommendation

### **Recommendation: Option B (Registry-backed bijection) with EVM address = `LocalSigner.getEvmSigningAddress()` stored at wallet creation**

**One-sentence statement:** Implement the bijection as a registry keyed by SVM address → EVM address, where the stored EVM address for each ETO-native wallet is the HKDF-secp256k1-keccak256 address that `LocalSigner.getEvmSigningAddress()` already computes, written once at wallet creation and never recomputed from the SVM pubkey alone.

### Rationale

**(a) Consistency with `LocalSigner.getEvmSigningAddress()`:**  
The registry stores the secp256k1-derived Ethereum address — the same value `ecrecover` will return when verifying transactions signed by `LocalSigner.signEvm()`. The resolved address and the signing address are identical by construction. There is no silent divergence.

**(b) Foreign address contract:**  
Both foreign SVM pubkeys and foreign EVM addresses are explicitly "unmapped" — the resolver returns an error such as `{ error: "unmapped", address: "<input>" }`. This is the honest contract: ETO cannot prove ownership or routing for addresses it has no registry entry for. Users who paste an external MetaMask address get a clear error rather than a silently-wrong derived address.

**(c) Role of `src/utils/address.ts`:**  
The two broken functions `pubkeyToEvmAddress` and `evmAddressToPubkey` should be **removed or deprecated** from `src/utils/address.ts` in FN-016/FN-017. The resolver in `cross-vm.ts` should delegate to `WalletStore` for registry lookups rather than calling these functions. `src/utils/address.ts` retains its utility functions (`isValidSvmAddress`, `isValidEvmAddress`, `hexToBytes`, etc.) but no longer contains a cross-VM derivation formula.

**(d) FrostSigner compatibility:**  
Because Option B decouples the storage of the EVM address from its derivation algorithm, `FrostSigner` wallets can be supported without changes to the signing service: at wallet creation time, the `FrostSignerFactory.createWallet()` method must compute and store the EVM address via whatever mechanism is available. For now, this is a known open question (see below). The registry cleanly separates "what is the EVM address" from "how was it derived".

**(e) Migration path is minimal and safe:**  
`LocalSigner` wallets have their private key in `WalletStore`. A one-time migration at startup can iterate all wallet records, recompute `getEvmSigningAddress()` from the stored private key, and write the correct EVM address to the record. The old `slice(12,32)` addresses stored in any existing records are silently replaced. No on-chain state is affected (the correct secp256k1-derived address was always the on-chain identity; only the local store was wrong).

**(f) Implementation simplicity:**  
Adding an `evmAddress` field to each wallet record in `WalletStore` requires minimal schema change. The registry index (inverse lookup) can be rebuilt in-memory at startup from the `svm → evm` forward index. No new persistence layer is required.

**(g) No pure-function forward direction needed:**  
Option A and Option B agree on the EVM address value; they differ only in whether the address is recomputed on-demand (A) or read from storage (B). Option B is strictly preferable because it works uniformly across all signer backends without requiring private key access in the resolver code path. `resolve_cross_vm_address` should not hold or receive private key material.

### Interface Sketch (for FN-016 / FN-017 implementers)

The following are **function signatures only**. Bodies are not specified here.

```ts
// src/signing/wallet-store.ts  — additions to WalletStore
interface WalletRecord {
  walletId: string;
  label: string;
  privateKey: Uint8Array;    // existing
  evmAddress: string;        // NEW: 0x-prefixed hex, set at creation, immutable thereafter
}

// Called at wallet creation time by LocalSignerFactory.createWallet()
// (and analogously by FrostSignerFactory, PrivySignerFactory)
async function registerEvmAddress(
  walletId: string,
  evmAddress: string           // caller computes this via signer.getEvmSigningAddress()
): Promise<void>;

// src/utils/address.ts  — new registry-backed resolver (replaces resolveAddresses)
// Returns null for foreign / unmapped addresses (not an ETO-native wallet)
async function resolveAddressFromRegistry(
  addr: string,
  store: WalletStore
): Promise<{ svm: string; evm: string } | null>;

// src/signing/local-signer.ts — no signature change needed
// getEvmSigningAddress() is already correct and is the source of truth for EVM address value

// src/tools/cross-vm.ts — updated handler shape
// (resolver now returns null for foreign addresses; tool returns "unmapped" error message)
```

### Open Questions for FN-016 Implementer

1. **FrostSigner EVM address source:** The FROST signing service holds only FROST/Ed25519 shares; it cannot currently derive a secp256k1 key. What EVM address should `FrostSignerFactory.createWallet()` write to the registry? Options: (a) store `null` / "unknown" until the signing service exposes a `derive_evm_key` endpoint; (b) use the broken `slice(12)` formula as a placeholder with a clear comment that it is not signing-compatible; (c) have the signing service add an HKDF-based secp256k1 derivation endpoint. **The implementer must make this decision and document it.** The registry design does not force a choice.

2. **Registry persistence layer:** Should `evmAddress` be a new field in the existing JSON wallet store file, a separate sidecar file, or an in-memory-only cache? The recommendation is a new `evmAddress` field on the existing `WalletRecord` type (minimal schema change, survives restarts, no new dependencies). Confirm this fits `WalletStore`'s serialization model before proceeding.

3. **Startup migration:** Should the first-run migration from stale `slice(12)` EVM addresses be silent (auto-migrate) or surfaced to the user (prompt/warning)? Given that no on-chain state is tied to these addresses (on-chain EVM identity was always the secp256k1 address), silent auto-migration from the stored private key is safe for `LocalSigner` wallets.

4. **`wasm/index.ts` divergence:** `src/wasm/index.ts` has its own copies of `pubkeyToEvmAddress` and `evmAddressToPubkey` with the same algorithmic bugs plus an additional TextEncoder bug. These must be fixed or deprecated in parallel with the `address.ts` changes. This is likely in scope for FN-016 or a sibling ticket (see FN-016 scope).

---

## 8. Hand-off to FN-016 / FN-017

**FN-016** (forward derivation fix) should:
- Add `evmAddress: string` to `WalletRecord` in `WalletStore`.
- Update `LocalSignerFactory.createWallet()` to call `getEvmSigningAddress()` and store the result.
- Implement `resolveAddressFromRegistry()` in `src/utils/address.ts` (or `cross-vm.ts`) backed by `WalletStore`.
- Update `wallet.ts`'s `derive_address` and `get_wallet` handlers to use the registry.
- Provide a startup migration that recomputes and stores EVM addresses for existing `LocalSigner` wallets.
- Address the FrostSigner open question (item 1 above) with a documented decision.
- Fix the `wasm/index.ts` divergence.

**FN-017** (inverse derivation fix) should:
- Update `resolve_cross_vm_address` in `cross-vm.ts` to call the registry-backed resolver.
- Replace the current `evmAddressToPubkey` call with a `store.evmToSvm(addr)` registry lookup.
- Return an explicit "unmapped" error message for foreign EVM addresses.
- Ensure the inverse index (evm → svm) is maintained in `WalletStore` alongside the forward index.

**FN-020 / FN-123 / FN-133** (tool description updates) should update the description string in `resolve_cross_vm_address`'s tool registration (currently in `cross-vm.ts` lines ~127–128) to accurately describe the registry-backed bijection, replacing the references to `slice(12,32)` and `SHA256("evm:" || …)`.

---

*End of FN-015 research deliverable.*
