export class DurableObject {
  constructor(protected ctx: { storage: MemoryStorage }) {}
}

export class MemoryStorage {
  values = new Map<string, unknown>();
  alarm: number | undefined;

  kv = {
    get: <T>(key: string) => structuredClone(this.values.get(key)) as T | undefined,
    put: (key: string, value: unknown) => this.values.set(key, structuredClone(value)),
  };

  async setAlarm(time: number) { this.alarm = time; }

  async deleteAll() {
    this.values.clear();
    this.alarm = undefined;
  }
}
