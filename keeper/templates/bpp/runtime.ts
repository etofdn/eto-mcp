/**
 * BPP runtime loop (FN-073, T-2.7.1.1, Step 4).
 *
 * `runBpp(config, handler, deps)` consumes Beckn `Init` events from a
 * pluggable `eventSource`, runs each through the credential gate, then
 * dispatches to the user's `BppHandler`. Successful results are
 * committed via `chain.completeTask`; failures (gate-deny, handler
 * throw, handler returns `failure`, handler timeout) via
 * `chain.failTask`.
 *
 * The default `InMemoryEventSource` and `InMemoryChain` keep the
 * runtime fully testable without an RPC connection; a TODO marks where
 * the real Beckn-program subscription will replace the in-memory
 * stub once FN-053 (`Confirm`) and the event subscriber land.
 */

import type {
  BeckonInitEvent,
  BppConfig,
  BppContext,
  BppHandler,
  Logger,
  TaskRequest,
  TaskResult,
} from "./types.js";
import type { CredentialGate } from "./credential-gate.js";

const DEFAULT_HANDLER_TIMEOUT_SEC = 60;

/* -------------------------------------------------------------------------- */
/* Chain adapter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Subset of the on-chain surface the runtime needs at task-completion
 * time. `registerCard` is included for ergonomic parity with
 * `register.ts` but the runtime itself never calls it — registration is
 * a startup-time concern.
 */
export interface RuntimeChain {
  completeTask(args: { taskId: string; output: unknown }): Promise<void>;
  failTask(args: { taskId: string; reason: string }): Promise<void>;
}

/** Test/example chain adapter. Records calls in arrays for assertion. */
export class InMemoryChain implements RuntimeChain {
  public readonly completed: Array<{ taskId: string; output: unknown }> = [];
  public readonly failed: Array<{ taskId: string; reason: string }> = [];

  public async completeTask(args: {
    taskId: string;
    output: unknown;
  }): Promise<void> {
    this.completed.push({ taskId: args.taskId, output: args.output });
  }
  public async failTask(args: {
    taskId: string;
    reason: string;
  }): Promise<void> {
    this.failed.push({ taskId: args.taskId, reason: args.reason });
  }
}

/* -------------------------------------------------------------------------- */
/* Event source abstraction                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Source of `BeckonInitEvent`s. The default `InMemoryEventSource` is an
 * async-iterable backed by an internal queue; it lets tests and the
 * worked example drive the loop deterministically. The production
 * implementation will be a thin wrapper around the SVM RPC log
 * subscription (TODO: post-FN-053).
 */
export type EventSource<TInput = unknown> = AsyncIterable<BeckonInitEvent<TInput>>;

/**
 * Push-based async iterable. `push()` enqueues an event; `close()`
 * signals end-of-stream so `runBpp` can exit cleanly.
 */
export class InMemoryEventSource<TInput = unknown>
  implements AsyncIterable<BeckonInitEvent<TInput>>
{
  private readonly queue: BeckonInitEvent<TInput>[] = [];
  private closed = false;
  private resolveNext: (() => void) | null = null;

  public push(event: BeckonInitEvent<TInput>): void {
    if (this.closed) throw new Error("InMemoryEventSource: already closed");
    this.queue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  public close(): void {
    this.closed = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<BeckonInitEvent<TInput>> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((res) => {
        this.resolveNext = res;
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* runBpp                                                                     */
/* -------------------------------------------------------------------------- */

export interface RunBppDeps<TInput = unknown> {
  readonly eventSource: EventSource<TInput>;
  readonly chain: RuntimeChain;
  readonly gate: CredentialGate;
  readonly logger: Logger;
  /** Override wall-clock for tests. Default: `() => Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
}

/**
 * Run a BPP until its event source closes. Resolves once the source
 * iterator returns done; never throws on per-event errors — those are
 * routed to `chain.failTask` and `logger.error` instead so a single
 * malformed event cannot tear the loop down.
 */
export async function runBpp<TInput = unknown, TOutput = unknown>(
  config: BppConfig,
  handler: BppHandler<TInput, TOutput>,
  deps: RunBppDeps<TInput>,
): Promise<void> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs =
    (config.handlerTimeoutSec ?? DEFAULT_HANDLER_TIMEOUT_SEC) * 1000;
  const ctx: BppContext = {
    logger: deps.logger,
    agent: { authority: config.authority, name: config.name },
    now,
  };

  // FN-022: idempotent retry — skip duplicate events targeting the same
  // taskId. The on-chain Beckn flow can replay an Init event (network
  // partitions, BAP retries, double-delivery from the SVM log
  // subscription); without dedupe this would result in duplicate
  // completeTask/failTask submissions, double-charged side-effects, and
  // duplicate signed envelopes. Memory cost is one string per task for
  // the lifetime of the BPP process, bounded by Beckon lifetime.
  const seenTaskIds = new Set<string>();
  for await (const event of deps.eventSource) {
    if (seenTaskIds.has(event.taskId)) {
      deps.logger.info("duplicate task event suppressed (idempotent retry)", {
        taskId: event.taskId,
      });
      continue;
    }
    seenTaskIds.add(event.taskId);
    await dispatchOne(event, handler, deps, ctx, timeoutMs);
  }
}

async function dispatchOne<TInput, TOutput>(
  event: BeckonInitEvent<TInput>,
  handler: BppHandler<TInput, TOutput>,
  deps: RunBppDeps<TInput>,
  ctx: BppContext,
  timeoutMs: number,
): Promise<void> {
  const { logger, chain, gate } = deps;
  const taskId = event.taskId;

  // 1. Credential gate.
  let gateResult;
  try {
    gateResult = await gate(event.bapPubkey);
  } catch (err) {
    const reason = `credential_gate_error: ${(err as Error).message}`;
    logger.error("credential gate threw", { taskId, reason });
    await safeFail(chain, taskId, reason, logger);
    return;
  }
  if (!gateResult.ok) {
    const reason = `credential_gate_denied: ${gateResult.reason}`;
    logger.warn("credential gate denied", { taskId, reason });
    await safeFail(chain, taskId, reason, logger);
    return;
  }

  // 2. Dispatch with timeout.
  const req: TaskRequest<TInput> = {
    taskId,
    bapPubkey: event.bapPubkey,
    bppPubkey: event.bppPubkey,
    networkPubkey: event.networkPubkey,
    action: event.action,
    input: event.input,
    // FN-073: thread gateway-verified caller pubkey through to the handler.
    // Absent when the gateway could not verify a BAP signature.
    ...(event.callerPubkey != null ? { callerPubkey: event.callerPubkey } : {}),
  };
  let result: TaskResult<TOutput>;
  try {
    result = await withTimeout(
      handler.handleTask(req, ctx),
      timeoutMs,
      `handler_timeout: exceeded ${timeoutMs}ms`,
    );
  } catch (err) {
    const reason = `handler_error: ${(err as Error).message}`;
    logger.error("handler threw", { taskId, reason });
    await safeFail(chain, taskId, reason, logger);
    return;
  }

  // 3. Commit.
  if (result.status === "success") {
    try {
      await chain.completeTask({ taskId, output: result.output });
      logger.info("task completed", { taskId });
    } catch (err) {
      logger.error("completeTask failed", {
        taskId,
        error: (err as Error).message,
      });
    }
  } else {
    await safeFail(chain, taskId, result.reason, logger);
  }
}

async function safeFail(
  chain: RuntimeChain,
  taskId: string,
  reason: string,
  logger: Logger,
): Promise<void> {
  try {
    await chain.failTask({ taskId, reason });
  } catch (err) {
    logger.error("failTask submission failed", {
      taskId,
      error: (err as Error).message,
    });
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    // Make sure a never-resolving handler doesn't keep the event loop alive.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* TODO(post-FN-053): replace InMemoryEventSource with a real Beckn-program  */
/* RPC log subscriber, and InMemoryChain with the actual SVM tx submitter.    */
/* -------------------------------------------------------------------------- */
