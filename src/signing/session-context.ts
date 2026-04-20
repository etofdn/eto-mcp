import { AsyncLocalStorage } from "node:async_hooks";

// Per-request/session scope context. The SSE server wraps each POST /message
// with sessionStore.run({...}, ...) so anything inside the tool handler stack
// (signer factories, active-wallet state, etc.) can scope itself per caller
// instead of leaking globally across all connections. The stdio entrypoint
// runs inside a fixed "__stdio__" scope.
//
// `scope` is the persistence key: authed SSE calls use `session.sub` (the
// thirdweb address / wallet-signed-in-with-Ethereum identity), stdio uses
// `"__stdio__"`, and dev-bypass requests use `"__dev__"`.
interface ScopeContext {
  sessionId: string;
  scope: string;
}

export const sessionStore = new AsyncLocalStorage<ScopeContext>();

const DEFAULT_SCOPE = "__default__";

export function runInScope<T>(scope: string, fn: () => T): T {
  const existing = sessionStore.getStore();
  const ctx: ScopeContext = {
    sessionId: existing?.sessionId ?? scope,
    scope,
  };
  return sessionStore.run(ctx, fn);
}

export function currentScope(): string {
  const scope = sessionStore.getStore()?.scope;
  if (!scope) {
    throw new Error(
      "No session scope is active; wrap execution in runInScope() or use currentScopeOrDefault()"
    );
  }
  return scope;
}

// Explicit opt-in for callers that genuinely need a fallback (e.g. offline
// tooling or tests). The SSE server and stdio entrypoint always wrap in a
// scope before tool execution, so production code paths should use
// currentScope() and fail closed on missing context.
export function currentScopeOrDefault(): string {
  return sessionStore.getStore()?.scope ?? DEFAULT_SCOPE;
}

export function currentSessionId(): string | undefined {
  return sessionStore.getStore()?.sessionId;
}
