# Changelog

## [Unreleased]

### Bug Fixes

- PDA derivation + stake multi-sig + space=0 for stake ([`f5133ea`](f5133ea29f7820e7f7af6112c98e18ae78ed2b00))
- GetEvmAddress returns the secp256k1-derived address (Critical) ([`1ba461e`](1ba461e7974c4fcc9de14cf651d09ba5f42ba593))
- Bump scrypt N from 2^12 to 2^17 + safe salt compare ([`5fc773a`](5fc773a18436e87975e640875df45f735038b1db))
- Use config.chain.id + accept from_wallet override ([`224d3f5`](224d3f5eea2861faff09f6af5e321b44b2b2f91a))
- Use findPda for AgentCard address + restore idempotencyKey ([`ca60cb5`](ca60cb594dc351be4d5e545ddf56a430d9211432))
- Harden auth and add Fly deploy gates ([`f685bee`](f685beef1f224ccb801e852e6a56afead23a4a0c))
- Verify redirect_uri matches on authorization code exchange ([`9e26ce6`](9e26ce6ad57887e4059be45740580ee3a66609ff))
- Harden auth and add Fly deploy gates ([`fc03eb3`](fc03eb3d539b98eacc9099a0c8db9decec243d10))
- Land memo on-chain, make confirmation timeout actionable, expose idempotency_key ([`94bce2b`](94bce2bc2a24810cbd92153d37f25a4b2dc3ca6b))
- Pin @noble crypto deps to versions tests expect ([#35](https://github.com/etofdn/eto-mcp/issues/35)) ([`f8a6ca5`](f8a6ca5eec85b67fdf00d5575843a78fa53c4619))
- Skip tests/bridge-conformance.test.ts until FN-092 stubs ship ([#41](https://github.com/etofdn/eto-mcp/issues/41)) ([`c456130`](c456130c7fde5bd9e9d6dadcf610044667e25080))
- Inline BANK_NETWORK_LABEL + computeBankNetworkId into eto-mcp ([#45](https://github.com/etofdn/eto-mcp/issues/45)) ([`097e78e`](097e78e8562a682d82d0451ce638ac118a12eaee))

### CI/CD

- Add PR-gating workflow (typecheck · test · build) ([#18](https://github.com/etofdn/eto-mcp/issues/18)) ([`fcc874e`](fcc874e19f9974d6ac438de55acd206cdd63f5b6))
- Add PR-gating workflow (typecheck · test · build) ([#25](https://github.com/etofdn/eto-mcp/issues/25)) ([`4e002a7`](4e002a7dd883143a1750bdc8bf63db3f1941097a))
- Fusion-task-gate — enforce branch ↔ task-id match ([#44](https://github.com/etofdn/eto-mcp/issues/44)) ([`7181111`](718111113392649899dfedee52ed54ed60579979))

### Chores

- CodeRabbit minor cleanups across tools + llms.txt ([`271bc4a`](271bc4a7be8da262319d2935a488087c1c57f560))
- ISSUER_URL prod warn + signing-key alias + docs ([`83dbc29`](83dbc2907609e5cafe7ea64c6e113c111b09348d))
- Board hygiene audit docs ([#38](https://github.com/etofdn/eto-mcp/issues/38)) ([`a764a86`](a764a86e06ee2ffd4f4bc9fd2109989faae9ba10))
- Add @noble/curves dep for src/signing/local-signer.ts ([#47](https://github.com/etofdn/eto-mcp/issues/47)) ([`5ec7479`](5ec74793aa541283c72f4aef0702a1027937878a))

### Documentation

- Add Marqeta integration v0.5 placeholder + swap-surface checklist ([`a7dc246`](a7dc24602e5f7cb586d95681a0ed1cddcd837b77))
- Audit cast_call vs read_contract — document return-format difference ([#23](https://github.com/etofdn/eto-mcp/issues/23)) ([`62fc53a`](62fc53aeec203b3b0935cb03ab3954516b471672))

### Features

- EVM secp256k1 + Borsh fixes + persistent auth state ([`084f5e6`](084f5e6708b5e4d3a9b7d792e74e90821d6da7a5))
- Persist OAuth clients, pending codes, and refresh tokens ([`515473d`](515473d465ebd78afc8a928d16e857a216e6219d))
- Rotate refresh tokens on use + detect reuse ([`379f7cc`](379f7cc5fdc9653e1e6759d82554b193b3e39746))
- Access-token denylist via revoked-jti persistence ([`099183a`](099183ae03abc57a1415497aeacc91a9e1c823d3))
- HMAC-sign oauth_state so the /login bridge isn't forgeable ([`e8d2a20`](e8d2a2034a6242f3f21fdb8a5c34126037ce6cf4))
- /oauth-callback returns JSON location for custom-scheme compat ([`5e35762`](5e357628599b87ca7b32fb9edfdbc24686d55da7))
- Auto-update CHANGELOG.md on every push and PR ([`8c650f3`](8c650f303c01c8ec1eb02a6f3c968da98b4d6bc8))
- Notify Telegram on every push and PR ([`9cfc6c2`](9cfc6c206bc259db3eada668b5b84a3db691d569))
- Land Beckn BPP keeper templates and ETO issuer suite ([`6103cbb`](6103cbb7b430231adff539ac7a84e7da0c16ea2b))
- Add bank BPP service price list with 8 services ([`1b92fc4`](1b92fc4a0cc04d6253f0d1ce87a862cd3528ae25))
- Add Dockerfile.bridge + fly.toml.bridge for bridge.eto.network deploy ([`37f0a21`](37f0a21dcfa43303432746ea5bb62ffb1a3dbc15))
- Add Beckn v2.0 LTS schema validation with ajv (4 main actions + 4 callbacks) ([`3e5529c`](3e5529c4624d7a5b9bc4e20f2b6447b80dba7c42))
- Add inbound BAP gateway role for /search + /select with stubbed on-chain submission ([`4d0934a`](4d0934ad2731ed0775e627ff571eeee33afad698))
- Add outbound BAP gateway role with /on_search callback receiver ([`b99a21a`](b99a21a709755ac2033e5277800c0460e204a026))
- Add v0 yield accrual mechanism (4% APY, daily compounding, stubbed on-chain commit) ([`c397115`](c397115a4670c1e8f1bc5435d2aa291bc46c155a))
- Add inbound BPP gateway role with /on_confirm callback receiver ([`1e8dd21`](1e8dd21ec4a2bab3911fa9368b4e3620fa5e1b7d))
- Add offramp BPP handler with burn + USD push and post-burn reconciliation flag ([`d5f14d4`](d5f14d41c186a24db980fb4c31ac4430f459fa12))
- Add wire transfer BPP handler with lock/release/refund phases (v0 mock receipt) ([`7010d9d`](7010d9d2f46737ec333f56dd944606ed70096c9b))
- Add open-checking BPP handler with credential gate, ledger entry, and credential issuance ([`4653fca`](4653fca868b69318b15a80a75bb3e03437af7519))
- Add onramp BPP handler with 1pip fee math and stubbed USD pull + on-chain mint ([`6dcc702`](6dcc702b4ebc7ab7c094e1dbcc48c8745c3569d8))
- Fix pre-existing test failures, add gateway config and missing deps ([#20](https://github.com/etofdn/eto-mcp/issues/20)) ([`047db9c`](047db9c14f07b75c230403bbce4d04e298f5ead7))
- Position deploy_evm_contract as preferred high-level EVM deploy abstraction ([#24](https://github.com/etofdn/eto-mcp/issues/24)) ([`6f0e467`](6f0e467dc9a050cfd160814168e870e196375e01))
- Add makeProdIssueCardCredential adapter ([#33](https://github.com/etofdn/eto-mcp/issues/33)) ([`c2b7795`](c2b77951289f31503e40bbece307346c714f6247))
- Beckn + Credential + Banking MCP tools ([#34](https://github.com/etofdn/eto-mcp/issues/34)) ([`23408b9`](23408b9d3a98dec8928ed8f8805ca41e373ec258))
- Scaffold spec/banking/credentials/ JSON Schema templates ([#39](https://github.com/etofdn/eto-mcp/issues/39)) ([`882b647`](882b6479d4c2918c06a0c2b47eeb906d33c5541a))
- Orphan-ledger reconciliation hook on issue-card + open-checking ([#40](https://github.com/etofdn/eto-mcp/issues/40)) ([`f33040a`](f33040a7485acb41fa73833ddf5a143393b1fb32))
- Update read_contract description to note raw-hex return and cast_call alternative ([#27](https://github.com/etofdn/eto-mcp/issues/27)) ([`49b3550`](49b3550a4a63f380ac6af37e9e4b7013f3fc9ea0))
- Update cast_call description with contrast vs read_contract ([#28](https://github.com/etofdn/eto-mcp/issues/28)) ([`8b14a2c`](8b14a2cd9c492d77def6722fda4b09dd1425a6ee))
- Update forge_create description to clarify low-level raw deploy path ([#29](https://github.com/etofdn/eto-mcp/issues/29)) ([`71fb4e7`](71fb4e7998ac5abe4ca2ba7a19a5c18b1704175c))
- Wire IssueCardDeps.recordCard to shared bank credential ledger ([#48](https://github.com/etofdn/eto-mcp/issues/48)) ([`7b575e5`](7b575e5f282952f28a29456133a88d3640d2f477))
- Add changeset for Poseidon-2 swap and VK regeneration note ([#50](https://github.com/etofdn/eto-mcp/issues/50)) ([`da71e91`](da71e91e21955d911109a40f67e00ed913849dfc))
- Collapse per-BPP SigningRuntimeChain imports to template barrel ([`b416026`](b4160262d4d8f7b096eb7f0b0bef1d1157167d6a))
- Merge fusion/fn-084 ([`d4fd0b3`](d4fd0b30e318216e35b40f09a4c5bbf0f9bc4453))

### Refactor

- Remove broken, unused A2A builders ([`a194d20`](a194d20c193edbdd65e2fa5b0dc69f4c609b1800))

### Fly.toml

- Production defaults, let secrets be source of truth ([`3aeb95e`](3aeb95e4b9dc77208116127431de5e47e87546c5))

### Test

- Add card auth flow test stubs (5 pending cases) ([`88e125f`](88e125f5e3c82da2790683b4953af84b190066b7))
- Add bank Network lifecycle test scaffolding (10 cases across 4 phases) ([`e71e7b5`](e71e7b541ffcff60851a5c17ec3a8754785d952a))
- Add integration tests for forge_create vs deploy_evm_contract equivalence ([#30](https://github.com/etofdn/eto-mcp/issues/30)) ([`3f6f354`](3f6f354f3d9be8af47b2dfdc1534eaa9630aea83))


