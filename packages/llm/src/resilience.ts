interface CircuitState {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

export class CircuitBreaker {
  #states = new Map<string, CircuitState>();
  constructor(
    readonly now: () => number,
    readonly failureThreshold = 3,
    readonly cooldownMs = 30_000,
  ) {}

  acquire(providerId: string): boolean {
    const state = this.#states.get(providerId);
    if (!state || state.openedAt === null) return true;
    if (this.now() - state.openedAt < this.cooldownMs || state.probing) return false;
    state.probing = true;
    return true;
  }

  success(providerId: string): void {
    this.#states.delete(providerId);
  }

  failure(providerId: string): void {
    const state = this.#states.get(providerId) ?? { failures: 0, openedAt: null, probing: false };
    state.failures += 1;
    if (state.failures >= this.failureThreshold) state.openedAt = this.now();
    state.probing = false;
    this.#states.set(providerId, state);
  }

  release(providerId: string): void {
    const state = this.#states.get(providerId);
    if (state) state.probing = false;
  }

  status(providerId: string): 'closed' | 'open' | 'half-open' {
    const state = this.#states.get(providerId);
    if (!state || state.openedAt === null) return 'closed';
    return this.now() - state.openedAt < this.cooldownMs ? 'open' : 'half-open';
  }
}

/** Local admission limiting. The queue additionally controls worker concurrency. */
export class ProviderRateLimiter {
  #buckets = new Map<string, { remaining: number; updatedAt: number }>();
  constructor(
    readonly now: () => number,
    readonly perMinute = 60,
    readonly burst = 10,
  ) {}
  acquire(providerId: string): boolean {
    const now = this.now();
    const bucket = this.#buckets.get(providerId) ?? { remaining: this.burst, updatedAt: now };
    bucket.remaining = Math.min(
      this.burst,
      bucket.remaining + (Math.max(0, now - bucket.updatedAt) * this.perMinute) / 60_000,
    );
    bucket.updatedAt = now;
    this.#buckets.set(providerId, bucket);
    if (bucket.remaining < 1) return false;
    bucket.remaining -= 1;
    return true;
  }
}
