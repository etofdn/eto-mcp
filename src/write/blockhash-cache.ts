import { rpc } from "../read/rpc-client.js";

export class BlockhashCache {
  private current: { blockhash: string; lastValidBlockHeight: number } | null = null;
  private fetchedAt = 0;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private refreshMs = 20_000; // 20 seconds

  async getBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    if (this.current && Date.now() - this.fetchedAt < this.refreshMs) {
      return this.current;
    }
    return this.refresh();
  }

  async refresh(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    try {
      this.current = await rpc.getRecentBlockhash();
      this.fetchedAt = Date.now();
      return this.current;
    } catch (err) {
      if (this.current) return this.current; // fallback to stale
      throw err;
    }
  }

  startRefresh(): void {
    if (this.refreshInterval) return;
    this.refreshInterval = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
  }

  stopRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  isValid(blockhash: string): boolean {
    return this.current?.blockhash === blockhash && Date.now() - this.fetchedAt < 60_000;
  }
}

export const blockhashCache = new BlockhashCache();
