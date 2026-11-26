import { describe, expect, it } from "vitest";
import { isUncensored } from "../src/shared/model-tags";

describe("меню моделей", () => {
  it("узнаёт модели без цензуры по названию и id раздачи", () => {
    expect(isUncensored("DeepSeek V4.1 Flash", "dealignai/deepseek-v4.1-flash-uncensored-fp8:free")).toBe(true);
    expect(isUncensored("Kimi K3 Abliterated")).toBe(true);
    expect(isUncensored(undefined, "uniboshi/kimi-k3-abliterated-v1:free")).toBe(true);
    for (const name of ["DeepSeek V4.1 Flash", "GLM 5.3", "Nemotron 3 Ultra", "Qwen3.8 Coder"]) expect(isUncensored(name)).toBe(false);
  });

  it("раскладывает свои модели: подписка, план, ключ, свой поставщик, бесплатный список", async () => {
    const { personalKind } = await import("../src/shared/model-tags");
    const model = (providerId: string, kind?: "api" | "plan" | "subscription" | "custom" | "zen") =>
      ({ id: "x", name: "X", providerId, providerName: providerId, kind }) as Parameters<typeof personalKind>[0];
    const catalog = ["numes", "openrouter", "kilo"];
    expect(personalKind(model("openai"), catalog)).toBe("subscription");
    expect(personalKind(model("xai"), catalog)).toBe("subscription");
    expect(personalKind(model("opencode"), catalog)).toBe("zen");
    expect(personalKind(model("kimi-code"), catalog)).toBe("plan");
    expect(personalKind(model("deepseek-api"), catalog)).toBe("api");
    expect(personalKind(model("custom-a1b2c3d4"), catalog)).toBe("custom");
    expect(personalKind(model("custom-api"), catalog)).toBe("custom");
    expect(personalKind(model("numes"), catalog)).toBe("free");
    expect(personalKind(model("numes", "custom"), catalog)).toBe("custom");
  });

  it("обрезает адрес своего поставщика до базы", async () => {
    const { customBaseUrl } = await import("../src/shared/model-tags");
    expect(customBaseUrl(" https://api.example.com/v1/chat/completions ")).toBe("https://api.example.com/v1");
    expect(customBaseUrl("https://api.example.com/v1/models/")).toBe("https://api.example.com/v1");
    expect(customBaseUrl("https://api.example.com/compatible-mode/v1/")).toBe("https://api.example.com/compatible-mode/v1");
  });
});
