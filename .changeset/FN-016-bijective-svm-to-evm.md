---
"eto-mcp": minor
---

## FN-016: Replace lossy SVM→EVM derivation with registry-backed bijection

### What was removed

The `pubkeyToEvmAddress` function in `src/utils/address.ts` and `src/wasm/index.ts`
previously truncated the 32-byte SVM pubkey to its last 20 bytes
(`pubkey[12..32]`), producing an EVM address. This is **not injective** — up to
2^96 different SVM pubkeys map to the same EVM address — making round-trip
reconstruction impossible and silently routing funds to the wrong account.

The old `evmAddressToPubkey` inverse used `SHA256("evm:" || addr_bytes)` to
produce a derived SVM pubkey, which bore no relationship to the input SVM key.

Both broken derivations have been replaced.

### What replaces it (FN-015 Option B — Registry-backed bijection)

The EVM address for a `LocalSigner` wallet is derived once at wallet-creation
time via `signer.getEvmSigningAddress()`:

```
evmKey       = HKDF-SHA256(ikm=ed25519_private_key, info="eto-evm-secp256k1-v1")
secp_pubkey  = secp256k1.getPublicKey(evmKey, uncompressed)
evm_address  = "0x" + keccak256(secp_pubkey[1:])[12:]
```

This is the address recovered by `ecrecover` on any signed EVM transaction from
this wallet. The SVM↔EVM pair is immediately stored in:

1. The in-memory `InMemoryRegistry` inside the wallet's `WalletStore`
2. The encrypted sidecar file (`~/.eto/wallets/<scope>.enc`) under a new
   optional `evmAddress` field on each wallet record

Lookups go through the new `resolveAddressesAsync(addr, registry)` function.

### Migration impact for persisted wallets

**Devnet / testnet wallets created before this change:**

Wallet files that do not contain an `evmAddress` field (pre-FN-016 format) are
automatically migrated on first load: the correct EVM address is recomputed from
the stored Ed25519 private key and saved back to disk. No manual re-import is
needed.

The **EVM address bytes will change** for wallets that were previously
identified by the old `slice(12,32)` derivation. Any external system that
recorded the old EVM address (off-chain address book, explorer, audit log) must
be updated to use the new address. On-chain balances under the old address are
NOT automatically migrated — if funds were sent to the old (incorrect) EVM
address, they must be transferred manually.

**Mainnet / production wallets:** No mainnet deployment exists at this point
(devnet only). If mainnet wallets are created before FN-016 is deployed, they
must be migrated following the same process.

### New public API surface

| Symbol | Location | Description |
|---|---|---|
| `WalletRegistry` | `src/utils/address.ts` | Interface for SVM↔EVM lookups |
| `resolveAddressesAsync` | `src/utils/address.ts` | Registry-backed bijective resolver |
| `WalletStore.recordCrossVmMapping()` | `src/signing/wallet-store.ts` | Record SVM↔EVM at wallet creation |
| `WalletStore.lookupBySvm()` | `src/signing/wallet-store.ts` | EVM for a given SVM |
| `WalletStore.lookupByEvm()` | `src/signing/wallet-store.ts` | SVM for a given EVM |
| `WalletStore.asRegistry()` | `src/signing/wallet-store.ts` | Expose as `WalletRegistry` |
| `LocalSignerFactory.getRegistryForCurrentScope()` | `src/signing/local-signer.ts` | Get registry for active scope |

### Related issues and follow-ups

- **GitHub issue:** https://github.com/etofdn/eto-mcp/issues/16
- **FN-017:** Implement `evmAddressToPubkey` as a registry-backed inverse.
- **FN-018 / FN-019:** Round-trip property tests (`SVM→EVM→SVM`).
- **FN-020:** Update `resolve_cross_vm_address` tool description.
- **FN-009 (new):** Fix `FrostSigner.getEvmAddress()` which still uses the
  old `slice(12,32)` derivation (open question — signing service cannot derive
  a secp256k1 key from FROST shares).
