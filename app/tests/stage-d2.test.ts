import { describe, expect, it, vi } from "vitest";
import bundled from "../resources/catalog.json";
import { ModelWatchdog } from "../src/main/engine/model-watchdog";
import { defaultModel } from "../src/shared/catalog";
import { catalogSchema } from "../src/shared/catalog-schema";
import { MODEL_TIMEOUT_MESSAGE, modelWaitState } from "../src/shared/model-wait";
import { groupTurns, turnContent } from "../src/renderer/turns";
import type { ChatPart } from "../src/shared/api";

describe("этап D2", () => {
  it("сворачивает ход после ответа, сохраняя ответ и действия", () => {
    const parts: ChatPart[] = [
      { id: "u", kind: "user", text: "Проверь" },
      { id: "r", kind: "reasoning", text: "Проверяю" },
      { id: "p", kind: "text", text: "Запущу тесты" },
      { id: "t", kind: "tool", tool: "shell", target: "npm test", status: "completed" },
      { id: "a", kind: "text", text: "Тесты прошли" },
      { id: "end", kind: "turn", seconds: 72 }
    ];
    const [{ agent, end }] = groupTurns(parts);
    expect(turnContent(agent, true).collapsed).toBe(false);
    const complete = turnContent(agent, false, end);
    expect(complete).toMatchObject({ actions: 1, seconds: 72, collapsed: true });
    expect(complete.work.map(part => part.id)).toEqual(["r", "p", "t"]);
    expect(complete.answer.map(part => part.text)).toEqual(["Тесты прошли"]);
  });

  it("отсчитывает 20 и 120 секунд от последнего токена и приостанавливает таймер", () => {
    vi.useFakeTimers({ now: 100 });
    try {
      let since: number | null = null;
      const timeout = vi.fn();
      const watchdog = new ModelWatchdog(value => { since = value; }, timeout);
      watchdog.wait();
      vi.advanceTimersByTime(19_999);
      expect(modelWaitState(since, Date.now())).toBe("waiting");
      vi.advanceTimersByTime(1);
      expect(modelWaitState(since, Date.now())).toBe("slow");
      watchdog.wait();
      expect(modelWaitState(since, Date.now())).toBe("waiting");
      vi.advanceTimersByTime(119_999);
      expect(timeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(modelWaitState(since, Date.now())).toBe("timeout");
      expect(timeout).toHaveBeenCalledWith(new Error(MODEL_TIMEOUT_MESSAGE));
      watchdog.wait();
      watchdog.pause();
      vi.advanceTimersByTime(120_000);
      expect(modelWaitState(since, Date.now())).toBe("idle");
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("предпочитает быстрые модели с активным предложением без ключа и с инструментами", () => {
    const catalog = catalogSchema.parse(bundled);
    expect(defaultModel(catalog)?.id).toBe("nemotron-3.5-lightning");
    for (const offer of catalog.offers) {
      if (offer.modelId === "nemotron-3.5-lightning") offer.expiresAt = "2020-01-01T00:00:00Z";
      if (offer.modelId === "beam-free") offer.supportsTools = false;
    }
    expect(defaultModel(catalog)?.id).toBe("ernie-5.5-flash-preview");
    const kilo = catalog.providers.find(provider => provider.id === "kilo")!;
    kilo.auth = { type: "manual_key" };
    expect(defaultModel(catalog)?.id).not.toBe("ernie-5.5-flash-preview");
  });
});
