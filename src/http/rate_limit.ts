/**
 * Sliding-window rate limiter for outbound HTTP.
 *
 * Allows at most `max` acquires within any rolling `windowMs` period.
 * Optionally enforces a minimum gap between consecutive acquires.
 */

export interface SlidingWindowOptions {
  /** Max requests in the rolling window. 0 / undefined = disabled. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Optional minimum interval between requests (ms). */
  minIntervalMs?: number;
}

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SlidingWindowOptions) {}

  get enabled(): boolean {
    return this.opts.max > 0 && this.opts.windowMs > 0;
  }

  /**
   * Serialize acquires so concurrent callers share one window correctly.
   */
  async acquire(): Promise<number> {
    if (!this.enabled) return 0;

    let waited = 0;
    const run = async () => {
      waited = await this.waitAndRecord();
    };
    // Queue acquires
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      await run();
    } finally {
      release();
    }
    return waited;
  }

  private async waitAndRecord(): Promise<number> {
    let totalWait = 0;
    for (;;) {
      const now = Date.now();
      const windowMs = this.opts.windowMs;
      this.timestamps = this.timestamps.filter((t) => now - t < windowMs);

      let waitMs = 0;
      const minInterval = this.opts.minIntervalMs ?? 0;
      if (minInterval > 0 && this.timestamps.length > 0) {
        const sinceLast = now - this.timestamps[this.timestamps.length - 1];
        if (sinceLast < minInterval) {
          waitMs = Math.max(waitMs, minInterval - sinceLast);
        }
      }

      if (this.timestamps.length >= this.opts.max) {
        // Wait until the oldest request falls out of the window
        const oldest = this.timestamps[0];
        waitMs = Math.max(waitMs, windowMs - (now - oldest) + 1);
      }

      if (waitMs <= 0) {
        this.timestamps.push(Date.now());
        return totalWait;
      }

      await new Promise((r) => setTimeout(r, waitMs));
      totalWait += waitMs;
    }
  }
}
