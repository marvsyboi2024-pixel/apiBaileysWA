import config from "@/config";

/**
 * Global Webhook Queue to prevent memory leaks and EMFILE errors
 * during traffic spikes or when the webhook server is slow/down.
 */

class ConcurrencyQueue {
  private concurrency: number;
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get pending() {
    return this.queue.length;
  }
}

// Allow up to concurrent webhook delivery fetches globally.
// This prevents NodeJS from crashing with EMFILE or OOM during massive spikes.
// Can be customized via WEBHOOK_CONCURRENCY in .env
export const webhookQueue = new ConcurrencyQueue(config.webhook.concurrency);

/**
 * Token-bucket rate limiter PER RECEIVER URL.
 *
 * When many events fire for the same webhook endpoint (e.g. a busy chat with
 * a burst of messages.update), the global concurrency queue alone does not
 * stop us from hammering one third-party server with a flood of requests —
 * which can get our IP rate-limited or banned by the receiver.
 *
 * Design:
 * - One logical bucket per URL, capacity `ratePerMin` tokens, refilled
 *   continuously (ratePerMin tokens per 60s).
 * - waitForSlot() resolves when a token is available; if the bucket is empty
 *   it waits until the next refill, bounded by maxWaitMs. On timeout it
 *   proceeds anyway (fail-open: we never drop events, only delay them).
 * - Buckets are evicted after `idleTtlMs` of inactivity so long-lived
 *   processes do not accumulate unbounded state for many distinct URLs.
 *
 * Enabled only when WEBHOOK_RATE_PER_MIN > 0; default 0 = disabled (legacy).
 */
class PerUrlRateLimiter {
  private buckets = new Map<
    string,
    { tokens: number; lastRefill: number; lastUsed: number }
  >();
  private readonly ratePerMin: number;
  private readonly maxWaitMs: number;
  private readonly idleTtlMs = 5 * 60 * 1000;

  constructor(ratePerMin: number, maxWaitMs: number) {
    this.ratePerMin = ratePerMin;
    this.maxWaitMs = maxWaitMs;
  }

  get enabled() {
    return this.ratePerMin > 0;
  }

  private bucketFor(url: string) {
    const now = Date.now();
    let bucket = this.buckets.get(url);
    if (!bucket) {
      bucket = { tokens: this.ratePerMin, lastRefill: now, lastUsed: now };
      this.buckets.set(url, bucket);
      return bucket;
    }
    // Refill continuously based on elapsed time.
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 60000) * this.ratePerMin;
      bucket.tokens = Math.min(this.ratePerMin, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
    bucket.lastUsed = now;
    return bucket;
  }

  private sweepIdle() {
    const now = Date.now();
    for (const [url, b] of this.buckets) {
      if (now - b.lastUsed > this.idleTtlMs) this.buckets.delete(url);
    }
  }

  /**
   * Wait until a token is available (or maxWaitMs elapses). Resolves with the
   * number of ms actually waited. Callers should then proceed to send.
   */
  async waitForSlot(url: string): Promise<number> {
    if (!this.enabled) return 0;
    const bucket = this.bucketFor(url);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    // Bucket empty — wait for the next refill interval, bounded.
    const started = Date.now();
    while (Date.now() - started < this.maxWaitMs) {
      await new Promise((r) => setTimeout(r, 250));
      const b = this.bucketFor(url); // refills as time passes
      if (b.tokens >= 1) {
        b.tokens -= 1;
        break;
      }
    }
    this.sweepIdle();
    return Date.now() - started;
  }

  get stats() {
    return { buckets: this.buckets.size, ratePerMin: this.ratePerMin };
  }
}

export const webhookRateLimiter = new PerUrlRateLimiter(
  config.webhook.ratePerMin,
  config.webhook.rateMaxWaitMs,
);
