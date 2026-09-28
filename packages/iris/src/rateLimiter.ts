/**
 * Token bucket: at most `perMinute` acquisitions per rolling minute, refilled continuously.
 * The DB API Marketplace free plan allows 60 calls/min; we default to 50 for headroom.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private queue: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60000) * this.perMinute);
    this.last = t;
  }

  /** Try to take a token immediately. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    if (this.queue.length === 0 && this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.schedule();
    });
  }

  private schedule() {
    if (this.timer) return;
    const waitMs = Math.max(10, ((1 - this.tokens) / this.perMinute) * 60000);
    this.timer = setTimeout(() => {
      this.timer = null;
      while (this.queue.length && this.tryAcquire()) this.queue.shift()!();
      if (this.queue.length) this.schedule();
    }, waitMs);
  }

  get pending(): number {
    return this.queue.length;
  }
}
