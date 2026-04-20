import { config } from "../config.js";

export interface WsSubscription {
  id: string;
  type: "account" | "logs" | "blocks";
  filter: any;
  callbacks: ((data: any) => void)[];
  active: boolean;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, WsSubscription>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsUrl: string;
  private connected = false;
  private messageBuffer: any[] = [];

  constructor() {
    if (config.etoWsUrl) {
      this.wsUrl = config.etoWsUrl;
    } else {
      const rpcUrl = config.etoRpcUrl;
      this.wsUrl = rpcUrl
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .replace(":8899", ":8900");
    }
  }

  async connect(): Promise<boolean> {
    try {
      this.ws = new WebSocket(this.wsUrl);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.connected = false;
          resolve(false);
        }, 5000);

        this.ws!.onopen = () => {
          clearTimeout(timeout);
          this.connected = true;
          console.error(`[ws-manager] Connected to ${this.wsUrl}`);
          // Re-subscribe all active subscriptions
          for (const [, sub] of this.subscriptions) {
            if (sub.active) this.sendSubscribe(sub);
          }
          resolve(true);
        };

        this.ws!.onmessage = (event) => {
          try {
            const data = JSON.parse(String(event.data));
            this.handleMessage(data);
          } catch {}
        };

        this.ws!.onclose = () => {
          this.connected = false;
          console.error("[ws-manager] Disconnected, scheduling reconnect");
          this.scheduleReconnect();
        };

        this.ws!.onerror = () => {
          clearTimeout(timeout);
          this.connected = false;
          resolve(false);
        };
      });
    } catch {
      return false;
    }
  }

  subscribe(
    type: "account" | "logs" | "blocks",
    filter: any,
    callback: (data: any) => void
  ): string {
    const id = crypto.randomUUID();
    const sub: WsSubscription = {
      id,
      type,
      filter,
      callbacks: [callback],
      active: true,
    };
    this.subscriptions.set(id, sub);

    if (this.connected) {
      this.sendSubscribe(sub);
    }

    return id;
  }

  unsubscribe(id: string): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;

    sub.active = false;
    this.subscriptions.delete(id);

    if (this.connected && this.ws) {
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "unsubscribe",
          params: [id],
        })
      );
    }

    return true;
  }

  getNotifications(id: string): any[] {
    // Return buffered messages for this subscription
    const filtered = this.messageBuffer.filter((m) => m.subscriptionId === id);
    this.messageBuffer = this.messageBuffer.filter(
      (m) => m.subscriptionId !== id
    );
    return filtered;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private sendSubscribe(sub: WsSubscription): void {
    if (!this.ws || !this.connected) return;

    const method =
      sub.type === "account"
        ? "accountSubscribe"
        : sub.type === "logs"
          ? "logsSubscribe"
          : "slotSubscribe";

    const params =
      sub.type === "account"
        ? [sub.filter.address]
        : sub.type === "logs"
          ? [sub.filter]
          : [];

    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sub.id,
        method,
        params,
      })
    );
  }

  private handleMessage(data: any): void {
    if (
      data.method === "accountNotification" ||
      data.method === "logsNotification" ||
      data.method === "slotNotification"
    ) {
      const notification = {
        type: data.method,
        subscriptionId: data.params?.subscription,
        result: data.params?.result,
        timestamp: Date.now(),
      };

      this.messageBuffer.push(notification);

      // Keep buffer bounded
      if (this.messageBuffer.length > 1000) {
        this.messageBuffer = this.messageBuffer.slice(-500);
      }

      // Call callbacks
      for (const [, sub] of this.subscriptions) {
        if (sub.active) {
          for (const cb of sub.callbacks) {
            try {
              cb(notification);
            } catch {}
          }
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, 5000);
  }
}

export const wsManager = new WebSocketManager();
