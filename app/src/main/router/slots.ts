
import type { KeyId } from "../../shared/providers";

type Pool = { count: number; limit?: { count: number; until: number }; waiters: Set<() => void> };

export class ProviderSlots {
  private pools = new Map<KeyId, Pool>();

  async acquire(id: KeyId, maximum: number | undefined, timeout: number, signal: AbortSignal) {
    let pool = this.pools.get(id);
    if (!pool) this.pools.set(id, pool = { count: 0, waiters: new Set() });
    const waiting = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    while (!waiting.aborted) {
      const learned = pool.limit && pool.limit.until > Date.now() ? pool.limit.count : Infinity;
      if (pool.count < Math.min(maximum ?? Infinity, learned)) {
        pool.count++;
        const active = pool;
        return {
          isCurrent: () => this.pools.get(id) === active,
          otherRequests: () => active.count - 1,
          learn: (count: number) => {
            if (this.pools.get(id) === active) active.limit = { count: Math.max(1, count), until: Date.now() + 600_000 };
          },
          release: () => {
            active.count--;
            for (const wake of active.waiters) wake();
          }
        };
      }
      const active = pool;
      await new Promise<void>(resolve => {
        const until = active.limit?.until ?? 0;
        const timer = until > Date.now() ? setTimeout(wake, until - Date.now()) : undefined;
        function wake() {
          clearTimeout(timer);
          active.waiters.delete(wake);
          waiting.removeEventListener("abort", wake);
          resolve();
        }
        active.waiters.add(wake);
        waiting.addEventListener("abort", wake, { once: true });
      });
      pool = this.pools.get(id) ?? pool;
    }
  }

  reset(id: KeyId) {
    const pool = this.pools.get(id);
    if (pool) {
      this.pools.set(id, { count: 0, waiters: new Set() });
      for (const wake of pool.waiters) wake();
    }
  }
}
