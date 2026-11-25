export const SLOW_MODEL_MS = 20_000;
export const MODEL_TIMEOUT_MS = 120_000;
export const MODEL_TIMEOUT_MESSAGE = "Модель не прислала ни одного токена за 2 минуты. Повторите запрос или смените модель.";

export function modelWaitState(since: number | null, now: number) {
  if (since === null) return "idle";
  if (now - since >= MODEL_TIMEOUT_MS) return "timeout";
  return now - since >= SLOW_MODEL_MS ? "slow" : "waiting";
}
