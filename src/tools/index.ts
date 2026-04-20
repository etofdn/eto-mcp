import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log, logToolCall, recordToolStat } from "../utils/logger.js";
import { authenticate, requireCapability } from "../gateway/auth.js";
import type { Capability } from "../gateway/session.js";
import { rateLimiter } from "../gateway/rate-limiter.js";
import { runInScope } from "../signing/session-context.js";

const TOOL_CAPS: Record<string, { cap: string; rate: "read" | "write" | "deploy" }> = {
  // Query tools (read)
  get_balance:            { cap: "wallet:read",     rate: "read" },
  get_account:            { cap: "account:read",    rate: "read" },
  get_transaction:        { cap: "block:read",      rate: "read" },
  get_block:              { cap: "block:read",      rate: "read" },
  search:                 { cap: "chain:read",      rate: "read" },
  get_chain_stats:        { cap: "chain:read",      rate: "read" },
  get_block_height:       { cap: "block:read",      rate: "read" },
  get_account_transactions: { cap: "account:read",  rate: "read" },
  // Validator tools (read)
  list_validators:        { cap: "validator:read",  rate: "read" },
  get_epoch_info:         { cap: "validator:read",  rate: "read" },
  get_vote_accounts:      { cap: "validator:read",  rate: "read" },
  // Devnet tools
  airdrop:                { cap: "transfer:write",  rate: "write" },
  get_health:             { cap: "chain:read",      rate: "read" },
  // Wallet tools
  create_wallet:          { cap: "wallet:create",   rate: "write" },
  import_wallet:          { cap: "wallet:create",   rate: "write" },
  list_wallets:           { cap: "wallet:read",     rate: "read" },
  get_wallet:             { cap: "wallet:read",     rate: "read" },
  set_active_wallet:      { cap: "wallet:read",     rate: "write" },
  derive_address:         { cap: "wallet:read",     rate: "read" },
  // Transfer tools
  transfer_native:        { cap: "transfer:write",  rate: "write" },
  batch_transfer:         { cap: "transfer:write",  rate: "write" },
  estimate_fee:           { cap: "chain:read",      rate: "read" },
  // Token tools
  create_token:           { cap: "token:write",     rate: "write" },
  mint_tokens:            { cap: "token:write",     rate: "write" },
  transfer_token:         { cap: "token:write",     rate: "write" },
  burn_tokens:            { cap: "token:write",     rate: "write" },
  get_token_info:         { cap: "token:read",      rate: "read" },
  get_token_balance:      { cap: "token:read",      rate: "read" },
  list_token_holdings:    { cap: "token:read",      rate: "read" },
  // Deploy tools
  deploy_evm_contract:    { cap: "deploy:write",    rate: "deploy" },
  deploy_wasm_contract:   { cap: "deploy:write",    rate: "deploy" },
  deploy_move_module:     { cap: "deploy:write",    rate: "deploy" },
  deploy_svm_program:     { cap: "deploy:write",    rate: "deploy" },
  // Contract tools
  call_contract:          { cap: "contract:write",  rate: "write" },
  read_contract:          { cap: "contract:read",   rate: "read" },
  encode_calldata:        { cap: "contract:read",   rate: "read" },
  get_contract_info:      { cap: "contract:read",   rate: "read" },
  // Cross-VM tools
  cross_vm_call:          { cap: "crossvm:write",   rate: "write" },
  resolve_cross_vm_address: { cap: "chain:read",    rate: "read" },
  inspect_uth:            { cap: "chain:read",      rate: "read" },
  // Staking tools
  create_stake:           { cap: "stake:write",     rate: "write" },
  delegate_stake:         { cap: "stake:write",     rate: "write" },
  deactivate_stake:       { cap: "stake:write",     rate: "write" },
  withdraw_stake:         { cap: "stake:write",     rate: "write" },
  get_stake_info:         { cap: "validator:read",  rate: "read" },
  // ZK tools
  zk_prove:               { cap: "zk:write",        rate: "write" },
  zk_verify:              { cap: "zk:write",        rate: "write" },
  zk_bn254_ops:           { cap: "zk:write",        rate: "write" },
  // Agent tools
  create_agent:           { cap: "agent:write",     rate: "write" },
  list_agents:            { cap: "agent:read",      rate: "read" },
  get_agent:              { cap: "agent:read",      rate: "read" },
  pause_agent:            { cap: "agent:write",     rate: "write" },
  resume_agent:           { cap: "agent:write",     rate: "write" },
  // A2A tools
  create_a2a_channel:     { cap: "a2a:write",       rate: "write" },
  send_a2a_message:       { cap: "a2a:write",       rate: "write" },
  read_a2a_messages:      { cap: "a2a:read",        rate: "read" },
  list_a2a_channels:      { cap: "a2a:read",        rate: "read" },
  close_a2a_channel:      { cap: "a2a:write",       rate: "write" },
  // MCP program tools
  register_mcp_service:   { cap: "mcp_program:write", rate: "write" },
  call_mcp_service:       { cap: "mcp_program:write", rate: "write" },
  list_mcp_services:      { cap: "mcp_program:read",  rate: "read" },
  get_mcp_service:        { cap: "mcp_program:read",  rate: "read" },
  // Swarm tools
  create_swarm:           { cap: "swarm:write",     rate: "write" },
  join_swarm:             { cap: "swarm:write",     rate: "write" },
  swarm_propose:          { cap: "swarm:write",     rate: "write" },
  swarm_vote:             { cap: "swarm:write",     rate: "write" },
  get_swarm:              { cap: "swarm:read",      rate: "read" },
  // Subscription tools
  subscribe_account:      { cap: "subscription:write", rate: "write" },
  subscribe_logs:         { cap: "subscription:write", rate: "write" },
  subscribe_blocks:       { cap: "subscription:write", rate: "write" },
  unsubscribe:            { cap: "subscription:write", rate: "write" },
  // Batch tools
  batch_execute:          { cap: "batch:write",     rate: "write" },
  batch_query:            { cap: "chain:read",      rate: "read" },
  // Foundry tools
  forge_compile:          { cap: "contract:read",   rate: "read" },
  forge_create:           { cap: "deploy:write",    rate: "deploy" },
  cast_call:              { cap: "contract:write",  rate: "write" },
  cast_abi_encode:        { cap: "contract:read",   rate: "read" },
  // Anchor tools
  anchor_init:            { cap: "deploy:write",    rate: "write" },
  anchor_build:           { cap: "deploy:write",    rate: "write" },
  anchor_test:            { cap: "deploy:write",    rate: "write" },
  // Session introspection
  session_info:           { cap: "wallet:read",     rate: "read" },
};

/** Wrap an McpServer so every tool() call gets automatic timing + logging + auth + rate limiting */
function instrumentServer(server: McpServer): McpServer {
  const origTool = server.tool.bind(server);
  server.tool = function (...args: any[]) {
    const name: string = args[0];
    // The handler is always the last argument
    const handlerIdx = args.length - 1;
    const origHandler = args[handlerIdx];

    args[handlerIdx] = async function (toolArgs: any, extra: any) {
      const start = performance.now();
      logToolCall(name, toolArgs ?? {});
      try {
        // Auth + capability + rate limit. authenticate() reads the ambient
        // bearer set by runWithAuth in sse-server (dev-bypass short-circuits
        // to DEV_SESSION).
        const meta = TOOL_CAPS[name];
        const { session } = authenticate();
        if (meta) {
          requireCapability(session, meta.cap as Capability);
        } else {
          log("warn", "auth", `Tool '${name}' not in TOOL_CAPS — no capability enforced`);
        }
        rateLimiter.check(session.sub, meta?.rate ?? "read");

        // Scope everything below by session.sub so the wallet store, active
        // wallet sidecar, and every other per-caller map lands in the right
        // bucket. This is what persists wallets across SSE reconnects.
        const result = await runInScope(session.sub, () => origHandler(toolArgs, extra));
        const ms = performance.now() - start;
        recordToolStat(name, ms, !result?.isError);
        log("info", "perf", `${name} ${ms.toFixed(0)}ms ${result?.isError ? "FAIL" : "OK"}`);
        return result;
      } catch (e: any) {
        const ms = performance.now() - start;
        recordToolStat(name, ms, false);
        log("error", "perf", `${name} ${ms.toFixed(0)}ms EXCEPTION: ${e?.message}`);
        throw e;
      }
    };

    return (origTool as any)(...args);
  } as any;

  setInterval(() => rateLimiter.cleanup(), 60_000).unref();

  return server;
}

// Phase 1 tools
import { registerQueryTools } from "./query.js";
import { registerValidatorTools } from "./validator.js";
import { registerDevnetTools } from "./devnet.js";
import { registerWalletTools } from "./wallet.js";
import { registerTransferTools } from "./transfer.js";
import { registerTokenTools } from "./token.js";
import { registerDeployTools } from "./deploy.js";
import { registerContractTools } from "./contract.js";
import { registerCrossVmTools } from "./cross-vm.js";
import { registerStakingTools } from "./staking.js";
import { registerZkTools } from "./zk.js";
// Phase 2 tools
import { registerAgentTools } from "./agent.js";
import { registerA2ATools } from "./a2a.js";
import { registerMcpProgramTools } from "./mcp-program.js";
import { registerSwarmTools } from "./swarm.js";
import { registerSubscriptionTools } from "./subscription.js";
import { registerBatchTools } from "./batch.js";
// Dev toolchains
import { registerFoundryTools } from "./foundry.js";
import { registerAnchorTools } from "./anchor.js";
// Session introspection
import { registerSessionTools } from "./session.js";

export function registerAllTools(server: McpServer): void {
  instrumentServer(server);
  // Phase 1 (48 tools)
  registerQueryTools(server);       // 8 tools
  registerValidatorTools(server);   // 3 tools
  registerDevnetTools(server);      // 2 tools
  registerWalletTools(server);      // 6 tools
  registerTransferTools(server);    // 3 tools
  registerTokenTools(server);       // 7 tools
  registerDeployTools(server);      // 4 tools
  registerContractTools(server);    // 4 tools
  registerCrossVmTools(server);     // 3 tools
  registerStakingTools(server);     // 5 tools
  registerZkTools(server);          // 3 tools
  // Phase 2 (24 tools)
  registerAgentTools(server);       // 5 tools
  registerA2ATools(server);         // 5 tools
  registerMcpProgramTools(server);  // 4 tools
  registerSwarmTools(server);       // 5 tools
  registerSubscriptionTools(server);// 4 tools
  registerBatchTools(server);       // 2 tools
  // Dev toolchains (7 tools)
  registerFoundryTools(server);     // 4 tools: forge_compile, forge_create, cast_call, cast_abi_encode
  registerAnchorTools(server);      // 3 tools: anchor_init, anchor_build, anchor_test
  // Session introspection (1 tool)
  registerSessionTools(server);     // session_info
  // Total: 81 tools
}
