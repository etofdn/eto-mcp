# `cast_call` vs `read_contract` — Return Format Audit

> **Task:** FN-005 · Parent issue: [#17](https://github.com/etofdn/eto-mcp/issues/17)

---

## Summary

Both tools perform a read-only `eth_call` against an EVM contract, but they differ fundamentally in **how the return value is represented** and in **what input they require from the caller**.

| Dimension | `read_contract` | `cast_call` |
|---|---|---|
| Implementation | `src/tools/contract.ts` | `src/tools/foundry.ts` |
| Underlying engine | `rpc.ethCall()` — direct JSON-RPC | Foundry `cast call` CLI binary |
| Return encoding | **Raw hex** (`0x…` bytes as returned by the node) | **ABI-decoded** human-readable values |
| ABI decoding | ❌ None — caller must decode manually | ✅ Automatic — uses the return types in the function signature |
| Function signature input | Method name or selector string; args ABI-encoded by the built-in `abiEncodeArgs` helper | Full human-readable signature `"fn(type)…(returnType)"` |
| Write support | ❌ Read-only only | ✅ `send: true` flag triggers `cast send` |
| Address format support | EVM (`0x`) **and** SVM/WASM/Move (base58) | EVM only (`0x` addresses required) |
| Requires Foundry installed | No | Yes (`~/.foundry/bin/cast`) |

---

## Return Shape Details

### `read_contract`

Delegates to the JSON-RPC `eth_call` method via `rpc.ethCall()`.  The node returns a **raw ABI-encoded hex blob** — the binary serialisation of the return values according to the Solidity ABI spec.  The tool surfaces this verbatim:

```
Contract: 0xAbCd…
Method:   balanceOf(address)
Selector: 0x70a08231
Calldata: 0x70a08231000000…

Result: 0x00000000000000000000000000000000000000000000000de0b6b3a7640000
```

- The `Result:` field is a raw `0x`-prefixed hex string.
- **No type information is applied.** The caller must know the return type and decode it.
- For `uint256 balanceOf(address)` the example above is `1 × 10¹⁸` (1 ETH in wei), but nothing in the output says so.

### `cast_call`

Invokes `cast call <to> <sig> [args…] --rpc-url <url>` and captures stdout.  Foundry parses the **return type** from the function signature's parenthesised suffix (e.g. `(uint256)`) and ABI-decodes the response before printing it.  The tool surfaces Foundry's decoded stdout:

```
Call result:
1000000000000000000
```

- For `uint256` the value is printed as a decimal integer.
- For `address` it is a checksum-cased `0x` address.
- For `bool` it is `true` / `false`.
- For tuples / structs the output is a comma-separated list inside parentheses.
- For `bytes` / `bytes32` the value is a `0x`-prefixed hex string (Foundry default).

> **Note:** Foundry only decodes return types that are explicitly written in the signature string.  If the caller supplies `"balanceOf(address)"` without a return-type suffix, `cast` still runs but may omit or silently skip decoding.  To guarantee decoded output, include the return type: `"balanceOf(address)(uint256)"`.

---

## Use-Case Guidelines

### Use `cast_call` when…

1. **Human-readable output is the goal.**  You want a decimal number, a boolean, or a formatted address rather than a raw hex blob.
2. **Interactive / exploratory work.**  You are probing a contract from the chat interface and do not want to manually decode the result.
3. **The function signature is well-known and the Foundry toolchain is available.**  `cast_call` requires Foundry installed at `~/.foundry/bin/cast`; it will fail if that binary is absent.
4. **You need to issue a state-changing call** (`send: true`).  `read_contract` is strictly read-only.
5. **Simpler calldata construction.**  `cast call` handles ABI encoding from the signature string; you do not need to specify argument types separately.

### Use `read_contract` when…

1. **You need the raw bytes.** Downstream code will ABI-decode the result itself, or you need to pass the raw return data to another call.
2. **You want a pure JSON-RPC path** with no external binary dependency.  `read_contract` uses only the internal RPC client — no Foundry required.
3. **You are calling a non-EVM contract** (SVM / WASM / Move base58 address).  `cast_call` only supports EVM; `read_contract` has a (stub) path for other VMs.
4. **You want explicit calldata visibility.**  The output always shows `Selector:` and `Calldata:`, making it easy to inspect or replay the exact bytes sent to the contract.
5. **Automation / programmatic use.**  Raw hex output is easier to parse reliably than Foundry's human-formatted output, which can vary between Foundry versions.

---

## Implementation Notes

### `read_contract` — `abiEncodeArgs` limitations

The built-in `abiEncodeArgs` helper (`src/tools/contract.ts`) handles:
- `bigint` / `number` → 32-byte big-endian slot
- `address` strings (`/^0x[0-9a-fA-F]{40}$/`) → left-zero-padded 32-byte slot
- `bool` → 32-byte slot, last byte 0 or 1
- Generic hex strings → interpreted as `bytes32` / `uint256`

**Dynamic types (`string`, `bytes`, `uint[]`, tuples) are not supported** by this helper.  For complex arguments, use `cast_call` or pre-encode calldata with `encode_calldata` / `cast_abi_encode`.

### `cast_call` — RPC URL injection

The Foundry subprocess inherits the server's `config.etoRpcUrl`.  All `cast call` invocations connect to the ETO node; no separate RPC configuration is needed on the caller side.

### Missing return-type decoding in `read_contract`

The `read_contract` tool intentionally omits ABI decoding.  If automatic decoding for common primitive types (`uint256`, `address`, `bool`) is desired, that should be added as a separate feature (see issue #17 backlog items).

---

## Files Referenced

| File | Role |
|---|---|
| `src/tools/contract.ts` | `read_contract` (and `call_contract`, `encode_calldata`, `get_contract_info`) |
| `src/tools/foundry.ts` | `cast_call`, `forge_compile`, `forge_create`, `cast_abi_encode` |
| `src/read/rpc-client.ts` | `rpc.ethCall()` — wraps JSON-RPC `eth_call` |
| `src/tools/index.ts` | Tool capability + rate-limit mapping |
