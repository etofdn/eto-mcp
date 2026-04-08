import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log, logToolCall, recordToolStat } from "../utils/logger.js";

/** Wrap an McpServer so every tool() call gets automatic timing + logging */
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
  // Total: 107 tools
}
