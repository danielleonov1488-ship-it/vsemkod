import { MODEL_TIMEOUT_MS, MODEL_TIMEOUT_MESSAGE } from "../../shared/model-wait";

export class ModelWatchdog {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly update: (since: number | null) => void, private readonly timeout: (error: Error) => void) {}

  wait() {
    clearTimeout(this.timer);
    this.update(Date.now());
    this.timer = setTimeout(() => this.timeout(new Error(MODEL_TIMEOUT_MESSAGE)), MODEL_TIMEOUT_MS);
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.update(null);
  }
}
