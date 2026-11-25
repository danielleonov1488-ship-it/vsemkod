export const clipboardLimit = 5 * 60_000;

export function keyFromClipboard(value: string, pattern: RegExp): string | undefined {
  if (value.length > 4096) return;
  const key = value.trim();
  if (key && pattern.test(key)) return key;
}

export class ClipboardWatch {
  private timer?: ReturnType<typeof setInterval>;
  private expires = 0;

  constructor(private readonly read: () => string | Promise<string>, private readonly now = Date.now) {}

  enable(pattern: string, found: (key: string) => void, expired: () => void) {
    this.pause();
    const regex = new RegExp("^(?:" + pattern + ")$");
    this.expires ||= this.now() + clipboardLimit;
    if (this.now() >= this.expires) { expired(); return; }
    let reading = false;
    const interval = setInterval(async () => {
      if (this.now() >= this.expires) {
        this.pause();
        expired();
        return;
      }
      if (reading) return;
      reading = true;
      let key: string | undefined;
      try { key = keyFromClipboard(await this.read(), regex); }
      catch { return; }
      finally { reading = false; }
      if (key && this.timer === interval && this.now() < this.expires) {
        this.pause();
        found(key);
      }
    }, 1000);
    this.timer = interval;
  }

  pause() { clearInterval(this.timer); this.timer = undefined; }
  close() { this.pause(); this.expires = 0; }
}
