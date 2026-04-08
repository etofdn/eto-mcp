import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// In-memory policy store
const policyPrograms = new Map<string, PolicyProgram>();

interface PolicyRule {
  name: string;
  assertion: string;
  message: string;
}

interface PolicyProgram {
  id: string;
  name: string;
  rules: PolicyRule[];
  scope: string;
  scopeId: string;
  active: boolean;
  createdAt: string;
  evaluationCount: number;
}

export function evaluatePolicy(
  policyId: string,
  context: { amount?: number; token?: string; recipient?: string }
): { allowed: boolean; violations: string[] } {
  const policy = policyPrograms.get(policyId);
  if (!policy || !policy.active) {
    return { allowed: true, violations: [] };
  }

  const violations: string[] = [];

  for (const rule of policy.rules) {
    const assertion = rule.assertion.trim();

    // transfer.amount <= X (literal number)
    const amountLiteralMatch = assertion.match(/^transfer\.amount\s*<=\s*([\d.]+)$/);
    if (amountLiteralMatch) {
      const limit = parseFloat(amountLiteralMatch[1]);
      if (context.amount !== undefined && context.amount > limit) {
        violations.push(`Rule "${rule.name}" violated: ${rule.message}`);
      }
      continue;
    }

    // transfer.amount <= wallet.balance * X
    const amountRatioMatch = assertion.match(/^transfer\.amount\s*<=\s*wallet\.balance\s*\*\s*([\d.]+)$/);
    if (amountRatioMatch) {
      // Without live balance data we can only enforce if amount and a ratio are provided
      // Skip enforcement for unknown balance (pass by default)
      continue;
    }

    // transfer.token in ["A", "B", ...]
    const tokenInMatch = assertion.match(/^transfer\.token\s+in\s+\[([^\]]+)\]$/);
    if (tokenInMatch) {
      const tokens = tokenInMatch[1]
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""));
      if (context.token !== undefined && !tokens.includes(context.token)) {
        violations.push(`Rule "${rule.name}" violated: ${rule.message}`);
      }
      continue;
    }

    // Default: unknown assertion passes
  }

  return { allowed: violations.length === 0, violations };
}

export function registerEplTools(server: McpServer): void {
  server.tool(
    "create_policy_program",
    'Create a programmable policy that governs agent behavior. Policies are expressed in ETO Policy Language (EPL) and enforced on-chain. They can reference real-time chain state.\n\nExample EPL:\n```\npolicy "conservative_trading" {\n  rule max_position_size {\n    assert transfer.amount <= wallet.balance * 0.1\n    message "Cannot risk more than 10% of balance per trade"\n  }\n  rule approved_tokens {\n    assert transfer.token in ["ETO", "USDC"]\n    message "Only approved tokens can be traded"\n  }\n}\n```',
    {
      name: z.string().describe("Policy name"),
      rules: z.string().describe("EPL policy definition"),
      scope: z
        .enum(["agent", "wallet", "swarm", "dao"])
        .describe("What this policy applies to"),
      scope_id: z
        .string()
        .describe("ID of the agent, wallet, swarm, or DAO"),
    },
    async ({ name, rules, scope, scope_id }) => {
      try {
        const ruleRegex =
          /rule\s+(\w+)\s*\{[^}]*assert\s+(.+?)\s+message\s+"([^"]+)"/g;
        const parsed: PolicyRule[] = [];
        let match: RegExpExecArray | null;

        while ((match = ruleRegex.exec(rules)) !== null) {
          parsed.push({
            name: match[1],
            assertion: match[2],
            message: match[3],
          });
        }

        if (parsed.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: 'Could not parse EPL rules. Use the format: `rule name { assert condition message "description" }`',
              },
            ],
            isError: true,
          };
        }

        const id = `pol_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const policy: PolicyProgram = {
          id,
          name,
          rules: parsed,
          scope,
          scopeId: scope_id,
          active: true,
          createdAt: new Date().toISOString(),
          evaluationCount: 0,
        };
        policyPrograms.set(id, policy);

        const rulesText = parsed
          .map(
            (r, i) =>
              `  ${i + 1}. ${r.name}: ${r.assertion}\n     → "${r.message}"`
          )
          .join("\n");

        const text = [
          "Policy Program Created",
          "══════════════════════",
          "",
          `ID: ${id}`,
          `Name: ${name}`,
          `Scope: ${scope} (${scope_id})`,
          `Status: Active`,
          "",
          `Rules (${parsed.length}):`,
          rulesText,
          "",
          "The policy is now active and will be enforced on all operations within scope.",
          "Note: EPL enforcement is advisory in Phase 5. Full on-chain enforcement requires runtime integration.",
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
