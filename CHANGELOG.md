# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.1.0] — 2026-05-02

### Features

- **`deploy_evm_contract`** positioned as the preferred high-level EVM deploy abstraction;
  description updated to note it handles wallet resolution, EIP-155 signing, SVM-envelope
  wrapping, and pre-submission simulation ([#24](https://github.com/etofdn/eto-mcp/pull/24), FN-006)

- **`forge_create`** description updated to clarify it is the lower-level, Foundry-native raw
  deploy path; recommends `deploy_evm_contract` for most callers and explains when `forge_create`
  is preferred (source-level deploys, custom constructor-arg type inference)
  ([#29](https://github.com/etofdn/eto-mcp/pull/29), FN-007)

- **`read_contract`** description updated to explicitly document that it returns raw ABI-encoded
  hex from `eth_call`, and recommends `cast_call` when human-readable decoded output is needed
  ([#27](https://github.com/etofdn/eto-mcp/pull/27), FN-008)

- **`cast_call`** description updated with a clear contrast against `read_contract`: Foundry-backed,
  ABI-aware, returns decoded human-readable output; cross-references `read_contract` by name
  ([#28](https://github.com/etofdn/eto-mcp/pull/28), FN-009)

### Documentation

- Added `docs/tool-guide.md` — a discoverable tool-picker reference covering both tool pairs
  (`deploy_evm_contract` vs `forge_create`, `cast_call` vs `read_contract`) with use-case
  guidance and comparison tables (FN-010)

- Added `docs/cast_call-vs-read_contract.md` — deep-dive audit of the return-format difference
  between the two contract-read tools (FN-005)

### Tests

- Integration tests added for `forge_create` vs `deploy_evm_contract` equivalence — asserts
  both tools produce equivalent deployment outcomes for the same input bytecode
  ([#30](https://github.com/etofdn/eto-mcp/pull/30), FN-011)

- Integration tests added for `cast_call` vs `read_contract` data compatibility — asserts
  ABI-decoding `read_contract`'s raw hex yields the same result as `cast_call`'s decoded
  output for the same contract call (FN-012)

---

*This changelog covers the tool-description disambiguation effort tracked in
[GitHub issue #17](https://github.com/etofdn/eto-mcp/issues/17).*
