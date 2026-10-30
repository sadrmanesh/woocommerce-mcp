/**
 * Token bucket shared by every request to one store. Callers reserve a token
 * and wait for it to refill when the bucket is empty, so bursts are smoothed
 * into the configured rate instead of being rejected.
 */
export class RateLimiter {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.updatedAt = now();
  }

  get enabled(): boolean {
    return this.ratePerSecond > 0;
  }

  /** Reserves one request and returns how long the caller must wait before sending it. */
  reserve(): number {
    if (!this.enabled) return 0;
    const current = this.now();
    const elapsed = Math.max(0, current - this.updatedAt);
    this.updatedAt = current;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.ratePerSecond);
    this.tokens -= 1;
    if (this.tokens >= 0) return 0;
    return Math.ceil((-this.tokens / this.ratePerSecond) * 1000);
  }
}
