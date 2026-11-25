import { DurableObject } from "cloudflare:workers";
import { DAY, utcDay } from "./token";

const MINUTE = 60_000;
export const LEASE_MS = 65_000;
const DAILY_MESSAGES = 30;
const DAILY_SESSIONS = 10;

type Lease = { id: string; until: number };
type Counts = { sessions: number; messages: number; recent: number[]; lease?: Lease };

export class IpLimits extends DurableObject {
  private counts(): Counts {
    return this.ctx.storage.kv.get<Counts>("counts") ?? { sessions: 0, messages: 0, recent: [] };
  }

  private async save(counts: Counts, day: number) {
    this.ctx.storage.kv.put("counts", counts);
    await this.ctx.storage.setAlarm(day + DAY + LEASE_MS);
  }

  async session(day: number) {
    if (utcDay(Date.now()) !== day) return { code: "limit" } as const;
    const counts = this.counts();
    if (counts.sessions >= DAILY_SESSIONS) return { code: "limit" } as const;
    counts.sessions++;
    await this.save(counts, day);
    return { remaining: DAILY_MESSAGES - counts.messages };
  }

  async start(day: number, id: string, previous: number[]) {
    const now = Date.now();
    if (utcDay(now) !== day) return { code: "limit" } as const;
    const counts = this.counts();
    if (counts.lease && counts.lease.until > now) return { code: "busy" } as const;
    const recent = counts.recent.filter((time) => time > now - MINUTE);
    const previousCount = previous.filter((time) => time > now - MINUTE).length;
    if (counts.messages >= DAILY_MESSAGES || recent.length + previousCount >= 6) return { code: "limit" } as const;
    counts.messages++;
    counts.recent = [...recent, now];
    counts.lease = { id, until: now + LEASE_MS };
    await this.save(counts, day);
    return { remaining: DAILY_MESSAGES - counts.messages };
  }

  // Only used just after midnight to carry the previous day's stream and rolling window.
  holdPrevious(id: string) {
    const now = Date.now();
    const counts = this.ctx.storage.kv.get<Counts>("counts");
    if (!counts) return { recent: [] };
    if (counts.lease && counts.lease.until > now) return { code: "busy" } as const;
    counts.lease = { id, until: now + LEASE_MS };
    this.ctx.storage.kv.put("counts", counts);
    return { recent: counts.recent };
  }

  release(id: string) {
    const counts = this.ctx.storage.kv.get<Counts>("counts");
    if (counts?.lease?.id !== id) return;
    delete counts.lease;
    this.ctx.storage.kv.put("counts", counts);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

export class GlobalQuota extends DurableObject {
  isOpen(): boolean {
    return (this.ctx.storage.kv.get<number>("closedUntil") ?? 0) <= Date.now();
  }

  async close(day: number) {
    if (day !== utcDay(Date.now()) || !this.isOpen()) return;
    const until = day + DAY;
    this.ctx.storage.kv.put("closedUntil", until);
    await this.ctx.storage.setAlarm(until);
  }

  async alarm() {
    // An alarm from the prior day can be delivered after the demo closes again.
    if (this.isOpen()) await this.ctx.storage.deleteAll();
  }
}
