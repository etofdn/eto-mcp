import { rpc } from "../read/rpc-client.js";

export interface AgentTrigger {
  id: string;
  agentId: string;
  type: "time_interval" | "block_interval" | "balance_threshold" | "cron";
  params: Record<string, any>;
  enabled: boolean;
  intervalId?: ReturnType<typeof setInterval>;
  lastFired?: number;
  fireCount: number;
}

const activeTriggers = new Map<string, AgentTrigger>();

export function addTrigger(agentId: string, type: string, params: any): AgentTrigger {
  const id = crypto.randomUUID();
  const trigger: AgentTrigger = {
    id,
    agentId,
    type: type as AgentTrigger["type"],
    params,
    enabled: true,
    fireCount: 0,
  };

  // Set up polling based on trigger type
  if (type === "time_interval" || type === "block_interval") {
    const intervalMs = type === "time_interval"
      ? (params.seconds || 60) * 1000
      : (params.blocks || 10) * 2000; // ~2s per block

    trigger.intervalId = setInterval(async () => {
      if (!trigger.enabled) return;
      trigger.lastFired = Date.now();
      trigger.fireCount++;
      // Log trigger fire (in production this would execute the agent's program)
      console.error(`[agent-trigger] Fired: agent=${agentId} trigger=${id} type=${type} count=${trigger.fireCount}`);
    }, intervalMs);
  }

  if (type === "balance_threshold") {
    // Poll balance every 5s
    trigger.intervalId = setInterval(async () => {
      if (!trigger.enabled) return;
      try {
        const bal = await rpc.getBalance(agentId);
        const threshold = BigInt(params.threshold || 0);
        if (BigInt(bal.value) >= threshold) {
          trigger.lastFired = Date.now();
          trigger.fireCount++;
          console.error(`[agent-trigger] Balance threshold reached: agent=${agentId} balance=${bal.value}`);
        }
      } catch {}
    }, 5000);
  }

  activeTriggers.set(id, trigger);
  return trigger;
}

export function removeTrigger(triggerId: string): boolean {
  const trigger = activeTriggers.get(triggerId);
  if (!trigger) return false;
  if (trigger.intervalId) clearInterval(trigger.intervalId);
  trigger.enabled = false;
  activeTriggers.delete(triggerId);
  return true;
}

export function getTriggers(agentId: string): AgentTrigger[] {
  return Array.from(activeTriggers.values()).filter(t => t.agentId === agentId);
}

export function getAllTriggers(): AgentTrigger[] {
  return Array.from(activeTriggers.values());
}
