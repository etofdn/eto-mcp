import { rpc } from "../read/rpc-client.js";

export class NonceManager {
  private nonces = new Map<string, { current: number; pendingCount: number; fetchedAt: number }>();
  private ttlMs = 300_000; // 5 min TTL

  async getNextNonce(evmAddress: string): Promise<number> {
    const addr = evmAddress.toLowerCase();
    const entry = this.nonces.get(addr);

    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) {
      const next = entry.current + entry.pendingCount;
      entry.pendingCount++;
      return next;
    }

    // Fetch from chain
    const hexNonce = await rpc.ethGetTransactionCount(addr);
    const onChainNonce = parseInt(hexNonce, 16);
    this.nonces.set(addr, { current: onChainNonce, pendingCount: 1, fetchedAt: Date.now() });
    return onChainNonce;
  }

  releaseNonce(evmAddress: string, nonce: number): void {
    const addr = evmAddress.toLowerCase();
    const entry = this.nonces.get(addr);
    if (entry && entry.pendingCount > 0) {
      entry.pendingCount--;
    }
  }

  async resetNonce(evmAddress: string): Promise<void> {
    this.nonces.delete(evmAddress.toLowerCase());
  }
}

export const nonceManager = new NonceManager();
