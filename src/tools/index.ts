import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log, logToolCall, recordToolStat } from "../utils/logger.js";
import { authenticate, requireCapability } from "../gateway/auth.js";
import { rateLimiter } from "../gateway/rate-limiter.js";
import { McpError } from "../errors/index.js";

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
  freeze_token_account:   { cap: "token:write",     rate: "write" },
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
  configure_agent_trigger: { cap: "agent:write",    rate: "write" },
  list_agents:            { cap: "agent:read",      rate: "read" },
  get_agent:              { cap: "agent:read",      rate: "read" },
  execute_agent:          { cap: "agent:write",     rate: "write" },
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
  // Policy tools
  set_spending_limit:     { cap: "policy:admin",    rate: "write" },
  set_tool_permissions:   { cap: "policy:admin",    rate: "write" },
  set_address_whitelist:  { cap: "policy:admin",    rate: "write" },
  get_policy:             { cap: "policy:admin",    rate: "read" },
  // Security tools
  manage_key_shares:      { cap: "security:admin",  rate: "write" },
  configure_step_up_auth: { cap: "security:admin",  rate: "write" },
  get_audit_log:          { cap: "security:admin",  rate: "read" },
  // Intent tools
  execute_intent:         { cap: "contract:write",  rate: "write" },
  plan_execution:         { cap: "chain:read",      rate: "read" },
  // Template tools
  list_templates:         { cap: "chain:read",      rate: "read" },
  execute_template:       { cap: "contract:write",  rate: "write" },
  // Analytics tools
  get_portfolio:          { cap: "wallet:read",     rate: "read" },
  get_activity_feed:      { cap: "account:read",    rate: "read" },
  get_gas_analytics:      { cap: "chain:read",      rate: "read" },
  // Identity tools
  register_agent_identity: { cap: "agent:write",   rate: "write" },
  get_agent_reputation:   { cap: "agent:read",      rate: "read" },
  discover_agents:        { cap: "agent:read",      rate: "read" },
  // Marketplace tools
  list_agent_services:    { cap: "agent:read",      rate: "read" },
  hire_agent:             { cap: "agent:write",     rate: "write" },
  // DAO tools
  create_dao:             { cap: "vote:write",      rate: "write" },
  dao_propose:            { cap: "vote:write",      rate: "write" },
  dao_vote:               { cap: "vote:write",      rate: "write" },
  dao_delegate:           { cap: "vote:write",      rate: "write" },
  // EPL tools
  create_policy_program:  { cap: "policy:admin",    rate: "deploy" },
  // Foundry tools
  forge_compile:          { cap: "contract:read",   rate: "read" },
  forge_create:           { cap: "deploy:write",    rate: "deploy" },
  cast_call:              { cap: "contract:write",  rate: "write" },
  cast_abi_encode:        { cap: "contract:read",   rate: "read" },
  // Anchor tools
  anchor_init:            { cap: "deploy:write",    rate: "write" },
  anchor_build:           { cap: "deploy:write",    rate: "write" },
  anchor_test:            { cap: "deploy:write",    rate: "write" },
  // Mesh tools
  mesh_state:             { cap: "chain:read",      rate: "read" },
  mesh_transfer:          { cap: "transfer:write",  rate: "write" },
  mesh_attest_balance:    { cap: "chain:read",      rate: "read" },
  mesh_verify:            { cap: "chain:read",      rate: "read" },
  mesh_history:           { cap: "chain:read",      rate: "read" },
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
        // Auth + rate limiting
        const authHeader = extra?.authInfo?.token
          ? `Bearer ${extra.authInfo.token}`
          : undefined;
        const session = authenticate(authHeader);
        const toolCap = TOOL_CAPS[name];
        if (!toolCap) {
          throw new McpError(
            "AUTH_003",
            "auth",
            "Tool not authorized",
            `Tool "${name}" is not registered in the authorization map and cannot be called.`,
            [],
            false,
          );
        }
        requireCapability(session.session, toolCap.cap as any);
        rateLimiter.check(session.userId, toolCap.rate);

        const result = await origHandler(toolArgs, extra);
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
import { registerPolicyTools } from "./policy.js";
// Phase 3 tools
import { registerSecurityTools } from "./security.js";
// Phase 4 tools
import { registerIntentTools } from "./intent.js";
import { registerTemplateTools } from "./templates.js";
import { registerAnalyticsTools } from "./analytics.js";
// Phase 5 tools
import { registerIdentityTools } from "./identity.js";
import { registerMarketplaceTools } from "./marketplace.js";
import { registerDaoTools } from "./dao.js";
import { registerEplTools } from "./epl.js";
// Dev toolchains
import { registerFoundryTools } from "./foundry.js";
import { registerAnchorTools } from "./anchor.js";
// Cross-chain mesh
import { registerMeshTools } from "./mesh.js";

export function registerAllTools(server: McpServer): void {
  instrumentServer(server);
  // Phase 1 (49 tools)
  registerQueryTools(server);       // 8 tools
  registerValidatorTools(server);   // 3 tools
  registerDevnetTools(server);      // 2 tools
  registerWalletTools(server);      // 6 tools
  registerTransferTools(server);    // 3 tools
  registerTokenTools(server);       // 8 tools
  registerDeployTools(server);      // 4 tools
  registerContractTools(server);    // 4 tools
  registerCrossVmTools(server);     // 3 tools
  registerStakingTools(server);     // 5 tools
  registerZkTools(server);          // 3 tools
  // Phase 2 (31 tools)
  registerAgentTools(server);       // 7 tools
  registerA2ATools(server);         // 5 tools
  registerMcpProgramTools(server);  // 4 tools
  registerSwarmTools(server);       // 5 tools
  registerSubscriptionTools(server);// 4 tools
  registerBatchTools(server);       // 2 tools
  registerPolicyTools(server);      // 4 tools
  // Phase 3 (3 tools)
  registerSecurityTools(server);    // 3 tools
  // Phase 4 (7 tools)
  registerIntentTools(server);      // 2 tools
  registerTemplateTools(server);    // 2 tools
  registerAnalyticsTools(server);   // 3 tools
  // Phase 5 (10 tools)
  registerIdentityTools(server);    // 3 tools
  registerMarketplaceTools(server); // 2 tools
  registerDaoTools(server);         // 4 tools
  registerEplTools(server);         // 1 tool
  // Dev toolchains (7 tools)
  registerFoundryTools(server);     // 4 tools: forge_compile, forge_create, cast_call, cast_abi_encode
  registerAnchorTools(server);      // 3 tools: anchor_init, anchor_build, anchor_test
  // Cross-chain mesh (5 tools)
  registerMeshTools(server);        // 5 tools: mesh_state, mesh_transfer, mesh_attest_balance, mesh_verify, mesh_history
  // Total: 112 tools
}
