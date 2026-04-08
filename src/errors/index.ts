export interface RecoveryAction {
  action: string;
  description: string;
  tool?: string;
  params?: Record<string, unknown>;
}

export type ErrorCategory = "auth" | "validation" | "chain" | "signing" | "policy" | "internal";

export class McpError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: ErrorCategory,
    message: string,
    public readonly explanation: string,
    public readonly recovery: RecoveryAction[],
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly chainError?: { raw: string; instruction_index?: number; program_id?: string },
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "McpError";
  }

  toJSON() {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      explanation: this.explanation,
      recovery: this.recovery,
      retryable: this.retryable,
      retry_after_ms: this.retryAfterMs,
      chain_error: this.chainError,
      request_id: this.requestId,
    };
  }

  toToolResult() {
    const lines = [
      `Error: ${this.message}`,
      "",
      this.explanation,
    ];
    if (this.recovery.length > 0) {
      lines.push("", "Recovery options:");
      for (const r of this.recovery) {
        lines.push(`- ${r.description}${r.tool ? ` (use ${r.tool} tool)` : ""}`);
      }
    }
    if (this.retryable) {
      lines.push("", `This error is retryable${this.retryAfterMs ? ` after ${this.retryAfterMs}ms` : ""}.`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: true };
  }
}

export * from "./chain-errors.js";
export * from "./agent-messages.js";
