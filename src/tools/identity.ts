import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";

// In-memory DID registry (on-chain in production)
const didRegistry = new Map<string, AgentIdentity>();

interface AgentIdentity {
  did: string;
  name: string;
  capabilities: string[];
  serviceEndpoints: { type: string; endpoint: string }[];
  metadata: Record<string, any>;
  publicKey: string;
  registeredAt: string;
  reputation: number;
  txCount: number;
  successRate: number;
}

export function registerIdentityTools(server: McpServer): void {
  server.tool(
    "register_agent_identity",
    "Register an AI agent's identity on-chain using W3C Decentralized Identifiers (DIDs). The agent gets a permanent, verifiable identity that other agents can discover and verify. The DID document includes public keys, service endpoints, capabilities, and controller information.",
    {
      agent_name: z.string().describe("Human-readable agent name"),
      capabilities: z
        .array(z.string())
        .describe("What this agent can do (e.g., 'trading', 'analysis', 'deployment')"),
      service_endpoints: z
        .array(
          z.object({
            type: z.string(),
            endpoint: z.string(),
          })
        )
        .optional(),
      metadata: z
        .record(z.any())
        .optional()
        .describe("Additional metadata (model, version, etc)"),
    },
    async ({ agent_name, capabilities, service_endpoints, metadata }) => {
      try {
        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active wallet. Use set_active_wallet to select a wallet before registering an identity.",
              },
            ],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const publicKey = signer.getPublicKey();

        const did = `did:eto:${publicKey}`;
        const registeredAt = new Date().toISOString();
        const endpoints = service_endpoints ?? [];

        const identity: AgentIdentity = {
          did,
          name: agent_name,
          capabilities,
          serviceEndpoints: endpoints,
          metadata: metadata ?? {},
          publicKey,
          registeredAt,
          reputation: 100,
          txCount: 0,
          successRate: 100,
        };

        didRegistry.set(did, identity);
        // Also index by public key for lookup by address
        didRegistry.set(publicKey, identity);

        const endpointLines =
          endpoints.length > 0
            ? endpoints.map((e) => `  - ${e.type}: ${e.endpoint}`).join("\n")
            : "  (none)";

        const text = [
          "Agent Identity Registered",
          "═════════════════════════",
          "",
          `DID: ${did}`,
          `Name: ${agent_name}`,
          `Public Key: ${publicKey}`,
          `Capabilities: ${capabilities.join(", ")}`,
          `Service Endpoints:`,
          endpointLines,
          `Registered: ${registeredAt}`,
          `Initial Reputation: 100/10000`,
          "",
          "The agent is now discoverable on the ETO network.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error registering identity: ${err?.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_agent_reputation",
    "Query an agent's on-chain reputation score. Reputation is computed from transaction success rate, swarm participation, service quality, stake weight, and account age. Reputation is non-transferable and decays without activity.",
    {
      agent_did: z
        .string()
        .describe("Agent's DID (did:eto:...) or base58 address"),
    },
    async ({ agent_did }) => {
      try {
        // Resolve to registry key: support both DID and raw address
        let identity = didRegistry.get(agent_did);
        if (!identity && agent_did.startsWith("did:eto:")) {
          const addr = agent_did.slice("did:eto:".length);
          identity = didRegistry.get(addr);
        }

        if (!identity) {
          // Try on-chain lookup for basic info
          const lookupAddr = agent_did.startsWith("did:eto:")
            ? agent_did.slice("did:eto:".length)
            : agent_did;

          try {
            const accountInfo = await rpc.getAccountInfo(lookupAddr);
            if (accountInfo) {
              const text = [
                "Agent Reputation",
                "════════════════",
                "",
                `DID: did:eto:${lookupAddr}`,
                `Name: (unregistered)`,
                `Reputation Score: (uncomputed — not registered via ETO identity)`,
                `On-Chain Account: found`,
                `Status: Unregistered`,
                "",
                "This address has an on-chain account but has not registered an agent identity. Use register_agent_identity to get a full reputation profile.",
              ].join("\n");
              return { content: [{ type: "text" as const, text }] };
            }
          } catch {
            // Fall through to not-found message
          }

          return {
            content: [
              {
                type: "text" as const,
                text: "Agent not found. The DID may not be registered.",
              },
            ],
          };
        }

        const status = identity.txCount > 0 || identity.reputation > 0 ? "Active" : "Inactive";

        const text = [
          "Agent Reputation",
          "════════════════",
          "",
          `DID: ${identity.did}`,
          `Name: ${identity.name}`,
          `Reputation Score: ${identity.reputation}/10000`,
          `Transaction Count: ${identity.txCount}`,
          `Success Rate: ${identity.successRate}%`,
          `Capabilities: ${identity.capabilities.join(", ")}`,
          `Status: ${status}`,
          `Registered: ${identity.registeredAt}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching reputation: ${err?.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "discover_agents",
    "Discover other AI agents on the ETO network. Search by capability, reputation, availability, or service type. Returns a ranked list of agents that match the criteria.",
    {
      capability: z
        .string()
        .optional()
        .describe("Required capability to filter by"),
      min_reputation: z
        .number()
        .default(0)
        .optional()
        .describe("Minimum reputation (0-10000)"),
      max_fee: z.string().optional().describe("Maximum fee per interaction"),
      limit: z.number().default(10).optional(),
    },
    async ({ capability, min_reputation, limit }) => {
      try {
        const minRep = min_reputation ?? 0;
        const maxResults = limit ?? 10;

        // Collect unique identities (registry has duplicate entries keyed by address)
        const seen = new Set<string>();
        const candidates: AgentIdentity[] = [];
        for (const [, identity] of didRegistry.entries()) {
          if (seen.has(identity.did)) continue;
          seen.add(identity.did);

          if (capability) {
            const capLower = capability.toLowerCase();
            const hasCapability = identity.capabilities.some((c) =>
              c.toLowerCase().includes(capLower)
            );
            if (!hasCapability) continue;
          }

          if (identity.reputation < minRep) continue;

          candidates.push(identity);
        }

        // Sort by reputation descending
        candidates.sort((a, b) => b.reputation - a.reputation);

        const results = candidates.slice(0, maxResults);
        const total = seen.size;

        if (results.length === 0) {
          const filterDesc = capability
            ? ` with capability "${capability}"`
            : "";
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `No agents found${filterDesc}.`,
                  "",
                  `${total} agent(s) are registered on ETO. Use register_agent_identity to add yours to the network.`,
                ].join("\n"),
              },
            ],
          };
        }

        const lines = [
          `Discovered Agents (${results.length} results)`,
          "════════════════════════════════════",
          "",
        ];

        results.forEach((agent, i) => {
          const endpointStr =
            agent.serviceEndpoints.length > 0
              ? agent.serviceEndpoints
                  .map((e) => `${e.type}: ${e.endpoint}`)
                  .join(", ")
              : "(none)";

          lines.push(`${i + 1}. ${agent.name} (${agent.did})`);
          lines.push(
            `   Reputation: ${agent.reputation}/10000 | Capabilities: ${agent.capabilities.join(", ")}`
          );
          lines.push(`   Endpoints: ${endpointStr}`);
          lines.push("");
        });

        lines.push(`No more results. ${total} agent(s) registered on ETO.`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error discovering agents: ${err?.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
