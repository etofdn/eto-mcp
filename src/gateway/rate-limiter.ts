import { config } from "../config.js";
import { McpError } from "../errors/index.js";

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number; // tokens per second
}

/**
 * In-memory token bucket rate limiter.
 * Phase 1: simple in-memory. Phase 2: Redis-backed.
 */
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();

  check(key: string, category: "read" | "write" | "deploy"): void {
    const maxPerMinute = category === "read"
      ? config.rateLimits.readPerMinute
      : category === "deploy"
        ? config.rateLimits.deployPerMinute
        : config.rateLimits.writePerMinute;

    const bucket = this.getOrCreate(key, maxPerMinute);
    this.refill(bucket);

    if (bucket.tokens < 1) {
      throw new McpError(
        "RATE_001", "policy",
        "Rate limit exceeded",
        `You've exceeded the rate limit of ${maxPerMinute} ${category} requests per minute. Wait a moment and retry.`,
        [{ action: "retry", description: "Wait a few seconds and try again" }],
        true,
        Math.ceil((1 / bucket.refillRate) * 1000),
      );
    }

    bucket.tokens -= 1;
  }

  private getOrCreate(key: string, maxPerMinute: number): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: maxPerMinute,
        lastRefill: Date.now(),
        maxTokens: maxPerMinute,
        refillRate: maxPerMinute / 60, // per second
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
    bucket.lastRefill = now;
  }

  /** Clean up old buckets periodically */
  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > 300_000) { // 5 min inactive
        this.buckets.delete(key);
      }
    }
  }
}

export const rateLimiter = new RateLimiter();
