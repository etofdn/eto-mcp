# ETO MCP — Local Setup Guide

## Prerequisites
- Testnet running on `localhost:8899` (`SVM_PRELOAD_COUNT=0`)
- Bun installed

## Add to Claude Code

Run this in another terminal:

```bash
claude mcp add eto-mcp -s user -e ETO_RPC_URL=http://localhost:8899 -e NETWORK=testnet -e AUTH_DEV_BYPASS=true -- bun run /home/naman/eto/eto-mcp/src/index.ts
```

Then **restart Claude Code** (exit and reopen) for the MCP server to connect.

Or add manually to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eto-mcp": {
      "command": "bun",
      "args": ["run", "/home/naman/eto/eto-mcp/src/index.ts"],
      "env": {
        "ETO_RPC_URL": "http://localhost:8899",
        "NETWORK": "testnet",
        "AUTH_DEV_BYPASS": "true"
      }
    }
  }
}
```

## 100 Available Tools

### Quick Start (try these first)
- `get_health` — Check if ETO node is alive
- `get_block_height` — Current block height
- `get_chain_stats` — TPS, validators, VM breakdown
- `create_wallet` — Create a new Ed25519 wallet
- `airdrop` — Get test tokens (testnet only)
- `get_balance` — Check balance (SVM or EVM address)
- `transfer_native` — Send ETO tokens
- `get_transaction` — Look up tx by signature

### All Categories
| Category | Tools | Count |
|----------|-------|-------|
| Query | get_balance, get_account, get_transaction, get_block, search, get_chain_stats, get_block_height, get_account_transactions | 8 |
| Wallet | create_wallet, import_wallet, list_wallets, get_wallet, set_active_wallet, derive_address | 6 |
| Transfer | transfer_native, batch_transfer, estimate_fee | 3 |
| Token | create_token, mint_tokens, transfer_token, burn_tokens, get_token_info, get_token_balance, list_token_holdings, freeze_token_account | 8 |
| Deploy | deploy_evm_contract, deploy_wasm_contract, deploy_move_module, deploy_svm_program | 4 |
| Contract | call_contract, read_contract, encode_calldata, get_contract_info | 4 |
| Cross-VM | cross_vm_call, resolve_cross_vm_address, inspect_uth | 3 |
| Staking | create_stake, delegate_stake, deactivate_stake, withdraw_stake, get_stake_info | 5 |
| Validator | list_validators, get_epoch_info, get_vote_accounts | 3 |
| ZK | zk_prove, zk_verify, zk_bn254_ops | 3 |
| Devnet | airdrop, get_health | 2 |
| Agent | create_agent, configure_agent_trigger, list_agents, get_agent, execute_agent, pause_agent, resume_agent | 7 |
| A2A | create_a2a_channel, send_a2a_message, read_a2a_messages, list_a2a_channels, close_a2a_channel | 5 |
| MCP Program | register_mcp_service, call_mcp_service, list_mcp_services, get_mcp_service | 4 |
| Swarm | create_swarm, join_swarm, swarm_propose, swarm_vote, get_swarm | 5 |
| Subscription | subscribe_account, subscribe_logs, subscribe_blocks, unsubscribe | 4 |
| Batch | batch_execute, batch_query | 2 |
| Policy | set_spending_limit, set_tool_permissions, set_address_whitelist, get_policy | 4 |
| Security | manage_key_shares, configure_step_up_auth, get_audit_log | 3 |
| Intent | execute_intent, plan_execution | 2 |
| Templates | list_templates, execute_template | 2 |
| Analytics | get_portfolio, get_activity_feed, get_gas_analytics | 3 |
| Identity | register_agent_identity, get_agent_reputation, discover_agents | 3 |
| Marketplace | list_agent_services, hire_agent | 2 |
| DAO | create_dao, dao_propose, dao_vote, dao_delegate | 4 |
| Policy Language | create_policy_program | 1 |

## Example Workflow

```
1. create_wallet → label: "test-wallet"
2. airdrop → amount: "10", address: (from step 1)
3. get_balance → address: (from step 1)
4. create_wallet → label: "recipient"
5. transfer_native → to: (recipient), amount: "1"
6. get_transaction → hash: (signature from step 5)
7. get_balance → address: (recipient) → should show 1 ETO
```
