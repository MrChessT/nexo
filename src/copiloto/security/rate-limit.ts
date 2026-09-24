/** Token bucket en memoria por clave (usuario + ruta). Con varias réplicas: mover a Redis. */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Devuelve 0 si se permite, o los segundos a esperar. */
  take(key: string): number {
    const now = this.now();
    const refillPerMs = this.perMinute / 60_000;
    const bucket = this.#buckets.get(key) ?? { tokens: this.perMinute, updatedAt: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.#buckets.set(key, bucket);
      this.gc(now);
      return 0;
    }
    this.#buckets.set(key, bucket);
    return Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
  }

  private gc(now: number): void {
    if (this.#buckets.size < 10_000) return;
    for (const [key, bucket] of this.#buckets) if (now - bucket.updatedAt > 120_000) this.#buckets.delete(key);
  }
}
