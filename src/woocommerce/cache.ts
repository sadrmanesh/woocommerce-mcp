interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Small time-bounded LRU cache for GET responses. */
export class ResponseCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount += 1;
      return undefined;
    }
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) {
      this.missCount += 1;
      return undefined;
    }
    this.entries.set(key, entry);
    this.hitCount += 1;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): { enabled: boolean; ttlMs: number; entries: number; hits: number; misses: number } {
    return {
      enabled: this.enabled,
      ttlMs: this.ttlMs,
      entries: this.entries.size,
      hits: this.hitCount,
      misses: this.missCount,
    };
  }
}
