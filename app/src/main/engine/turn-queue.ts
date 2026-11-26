export class TurnQueue {
  private readonly active = new Set<string>();
  private readonly waiting = new Map<string, (run: boolean) => void>();

  constructor(private readonly limit = 3) {}

  async acquire(sessionId: string, queued: () => void): Promise<boolean> {
    if (this.has(sessionId)) throw new Error("Агент уже отвечает в этом чате.");
    if (this.active.size < this.limit) {
      this.active.add(sessionId);
      return true;
    }
    const ready = new Promise<boolean>(resolve => this.waiting.set(sessionId, resolve));
    queued();
    return ready;
  }

  has(sessionId: string) {
    return this.active.has(sessionId) || this.waiting.has(sessionId);
  }

  cancel(sessionId: string) {
    const resume = this.waiting.get(sessionId);
    if (!resume) return false;
    this.waiting.delete(sessionId);
    resume(false);
    return true;
  }

  release(sessionId: string) {
    if (!this.active.delete(sessionId)) return;
    const entry = this.waiting.entries().next().value;
    if (!entry) return;
    const [next, resume] = entry;
    this.waiting.delete(next);
    this.active.add(next);
    resume(true);
  }
}
