/**
 * FN-105: MemoBlockIngester — live logsSubscribe → ingestBatch pipeline.
 *
 * Subscribes to the ETO node's WebSocket `logsSubscribe` filtered to the
 * SPL Memo Program v2, hydrates each notification via `getTransaction`,
 * parses memo instructions, and batches the resulting MemoEntry records
 * into `MemoIndex.ingestBatch()`.
 *
 * Lifecycle: start() → logsSubscribe loop → stop() (SIGTERM/SIGINT).
 * Reconnect: exponential backoff bounded by reconnectMaxMs.
 * Checkpoint: slot persisted after every successful ingestBatch flush.
 */

import type { MemoEntry, MemoIndex } from "./memo-index.js";
import { extractMemoEntries, MEMO_PROGRAM_ID } from "./parse-memo-instructions.js";
import type { MemoIngesterCheckpointStore } from "./memo-ingester-checkpoint.js";
import { createCheckpointStoreFromEnv } from "./memo-ingester-checkpoint.js";
import { InMemoryMemoIndex } from "./memo-index.js";
import { MemoIngesterError } from "./memo-ingester-checkpoint.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoBlockIngesterDeps {
  readonly index: MemoIndex;
  readonly checkpoint: MemoIngesterCheckpointStore;
  readonly rpc: { getTransaction(sig: string): Promise<unknown> };
  readonly wsUrl: string;
  readonly id: string;
  readonly batchSize: number;
  readonly flushIntervalMs: number;
  readonly reconnectInitialMs: number;
  readonly reconnectMaxMs: number;
  readonly rpcConcurrency: number;
  readonly logger?: (
    level: "info" | "warn" | "error",
    msg: string,
    meta?: object,
  ) => void;
  /** Injectable for tests — defaults to global WebSocket */
  readonly wsFactory?: (url: string) => WebSocket;
}

export interface IngesterStats {
  connected: boolean;
  pendingBatch: number;
  lastFlushedSlot: number | null;
  reconnects: number;
  rpcErrors: number;
  parseErrors: number;
  flushed: number;
}

// ---------------------------------------------------------------------------
// MemoBlockIngester
// ---------------------------------------------------------------------------

export class MemoBlockIngester {
  private readonly deps: MemoBlockIngesterDeps;

  // state
  private _connected = false;
  private _lastFlushedSlot: number | null = null;
  private _reconnects = 0;
  private _rpcErrors = 0;
  private _parseErrors = 0;
  private _flushed = 0;

  private pendingBatch: MemoEntry[] = [];
  private ws: WebSocket | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private reconnectAttempt = 0;

  constructor(deps: MemoBlockIngesterDeps) {
    this.deps = deps;
  }

  stats(): IngesterStats {
    return {
      connected: this._connected,
      pendingBatch: this.pendingBatch.length,
      lastFlushedSlot: this._lastFlushedSlot,
      reconnects: this._reconnects,
      rpcErrors: this._rpcErrors,
      parseErrors: this._parseErrors,
      flushed: this._flushed,
    };
  }

  async start(): Promise<void> {
    if (this.stopped) return;

    // Load checkpoint
    const saved = await this.deps.checkpoint.load(this.deps.id);
    this._lastFlushedSlot = saved?.lastSlot ?? null;
    this.log("info", "[memo-ingester] starting", {
      id: this.deps.id,
      resumeSlot: this._lastFlushedSlot,
    });

    // Set up periodic flush timer
    this.flushTimer = setInterval(() => {
      if (this.pendingBatch.length > 0) {
        void this.flush();
      }
    }, this.deps.flushIntervalMs);

    await this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Best-effort unsubscribe
    if (this.ws && this._connected) {
      try {
        this.ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "logsUnsubscribe", params: [] }),
        );
      } catch {
        // ignore
      }
    }

    // Final flush
    if (this.pendingBatch.length > 0) {
      await this.flush().catch((e) =>
        this.log("error", "[memo-ingester] stop-flush error", { err: String(e) }),
      );
    }

    // Close socket
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    await this.deps.checkpoint.close();
    this.log("info", "[memo-ingester] stopped");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private log(level: "info" | "warn" | "error", msg: string, meta?: object): void {
    if (this.deps.logger) {
      this.deps.logger(level, msg, meta);
    } else {
      const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
  }

  private openWs(): WebSocket {
    if (this.deps.wsFactory) return this.deps.wsFactory(this.deps.wsUrl);
    return new WebSocket(this.deps.wsUrl);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const ws = this.openWs();
    this.ws = ws;

    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => {
        this._connected = true;
        this.reconnectAttempt = 0;
        this.log("info", "[memo-ingester] ws connected");

        // Send logsSubscribe for memo program
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
              { mentions: [MEMO_PROGRAM_ID] },
              { commitment: "confirmed" },
            ],
          }),
        );
        resolve();
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        void this.handleMessage(event.data as string);
      });

      ws.addEventListener("close", () => {
        this._connected = false;
        if (!this.stopped) {
          this.log("warn", "[memo-ingester] ws closed, reconnecting");
          void this.scheduleReconnect();
        }
      });

      ws.addEventListener("error", (e) => {
        this.log("error", "[memo-ingester] ws error", { err: String(e) });
        // close handler will schedule reconnect
      });
    });
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopped) return;
    this._reconnects++;
    const delay = Math.min(
      this.deps.reconnectInitialMs * Math.pow(2, this.reconnectAttempt),
      this.deps.reconnectMaxMs,
    );
    this.reconnectAttempt++;
    this.log("info", "[memo-ingester] reconnect in", { ms: delay, attempt: this.reconnectAttempt });
    await new Promise<void>((r) => setTimeout(r, delay));
    if (!this.stopped) await this.connect();
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const notification = msg as {
      method?: string;
      params?: {
        result?: {
          value?: { signature?: string; slot?: number; err?: unknown };
        };
      };
    };

    if (notification.method !== "logsNotification") return;

    const value = notification.params?.result?.value;
    if (!value?.signature || !value?.slot) return;

    const { signature, slot, err } = value;

    // Skip failed txs or already-seen slots
    if (err != null) return;
    if (this._lastFlushedSlot !== null && slot <= this._lastFlushedSlot) return;

    // Fetch and parse with retries
    let tx: unknown = null;
    const delays = [250, 1000, 4000];
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        tx = await this.deps.rpc.getTransaction(signature);
        if (tx !== null) break;
      } catch (e) {
        this._rpcErrors++;
        this.log("warn", "[memo-ingester] getTransaction error", {
          sig: signature,
          attempt,
          err: String(e),
        });
        if (attempt < 3) {
          await new Promise<void>((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    if (tx === null) {
      this.log("error", "[memo-ingester] giving up on tx after retries", { sig: signature });
      return;
    }

    let entries: MemoEntry[];
    try {
      entries = extractMemoEntries(tx as Parameters<typeof extractMemoEntries>[0], slot, null, signature);
    } catch (e) {
      this._parseErrors++;
      this.log("error", "[memo-ingester] parse error", { sig: signature, err: String(e) });
      return;
    }

    this.pendingBatch.push(...entries);

    if (this.pendingBatch.length >= this.deps.batchSize) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.pendingBatch.length === 0) return;

    const batch = this.pendingBatch.splice(0, this.pendingBatch.length);
    await this.deps.index.ingestBatch(batch);
    this._flushed += batch.length;

    // Update checkpoint to max slot in batch
    const maxSlot = batch.reduce((m, e) => Math.max(m, e.slot), 0);
    if (this._lastFlushedSlot === null || maxSlot > this._lastFlushedSlot) {
      this._lastFlushedSlot = maxSlot;
      try {
        await this.deps.checkpoint.save(this.deps.id, maxSlot);
      } catch (e) {
        this.log("warn", "[memo-ingester] checkpoint save failed", { err: String(e) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoBlockIngesterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MemoBlockIngester {
  const enabled = env["ETO_MEMO_INGESTER_ENABLED"] === "true";
  if (!enabled) {
    throw new MemoIngesterError(
      "INVALID_CHECKPOINT",
      "Memo ingester is disabled (set ETO_MEMO_INGESTER_ENABLED=true)",
    );
  }

  const wsUrl =
    env["ETO_WS_URL"] ??
    env["SOLANA_WS_URL"] ??
    "ws://127.0.0.1:8900";

  const id = env["ETO_MEMO_INGESTER_ID"] ?? "default";
  const batchSize = parseInt(env["ETO_MEMO_INGESTER_BATCH_SIZE"] ?? "25", 10);
  const flushIntervalMs = parseInt(env["ETO_MEMO_INGESTER_FLUSH_MS"] ?? "1000", 10);
  const reconnectInitialMs = parseInt(env["ETO_MEMO_INGESTER_RECONNECT_MS"] ?? "1000", 10);
  const reconnectMaxMs = parseInt(env["ETO_MEMO_INGESTER_RECONNECT_MAX_MS"] ?? "30000", 10);
  const rpcConcurrency = parseInt(env["ETO_MEMO_INGESTER_RPC_CONCURRENCY"] ?? "4", 10);

  const index = new InMemoryMemoIndex();
  const checkpoint = createCheckpointStoreFromEnv(
    env as Record<string, string | undefined>,
  );

  return new MemoBlockIngester({
    index,
    checkpoint,
    rpc: {
      async getTransaction(sig: string) {
        const { EtoRpcClient } = await import("../../read/rpc-client.js");
        const client = new EtoRpcClient(env["ETO_RPC_URL"] ?? "http://127.0.0.1:8899");
        return client.getTransaction(sig);
      },
    },
    wsUrl,
    id,
    batchSize,
    flushIntervalMs,
    reconnectInitialMs,
    reconnectMaxMs,
    rpcConcurrency,
  });
}
