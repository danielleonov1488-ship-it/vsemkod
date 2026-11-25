import type { ProviderId } from "../schema.js";
import type { Observation, SourceResult } from "../sources/common.js";

export const registryReviewMs = 14 * 24 * 60 * 60 * 1000;

type RegistryRoute = Pick<Observation, "providerModelId" | "contextWindow" | "supportsTools" | "reviewBy">;

export const registryPages = {
  // https://www.runcrate.ai/inference/free; контекст и tools из https://api.runcrate.ai/v1/models
  runcrate: {
    hash: "7716ead50463b7a609a6be0bb539a643b92ec9613099ef1f1c36bb13cd7fa549",
    verifiedAt: "2026-11-24T00:00:00Z",
    routes: [
      { providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "zai-org/GLM-5.3", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "zai-org/GLM-5.3-Flash", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "openai/gpt-oss-120b", contextWindow: 131072, supportsTools: true },
      { providerModelId: "Qwen/Qwen3.8-Flash", contextWindow: 1000000, supportsTools: true },
    ],
  },
  // https://docs.z.ai/guides/overview/pricing; https://docs.z.ai/guides/llm/glm-4.7
  zai: {
    hash: "567997bd64b126bde95802f3b89ce19c02668f604244c22e04dbbda630a9bb72",
    verifiedAt: "2026-11-24T00:00:00Z",
    routes: [
      { providerModelId: "glm-4.7-flash", contextWindow: 200000, supportsTools: true },
    ],
  },
  // Бесплатные Magicubes и условия API-Inference
  // https://www.modelscope.cn/docs/magicube/intro.md; https://www.modelscope.cn/docs/model-service/API-Inference/limits.md
  // ID доступны на https://api-inference.modelscope.cn/v1/models — это API самой платформы.
  modelscope: {
    hash: "b84f5a2c3f6c54778285e39fb4d064fe92a05e29aca9a2244b7e906fec73c33f",
    verifiedAt: "2026-11-24T00:00:00Z",
    routes: [
      { providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash" },
      { providerModelId: "MiniMax/MiniMax-M3" },
      { providerModelId: "moonshotai/Kimi-K3.1-Pro" },
      { providerModelId: "ZhipuAI/GLM-5.2" },
    ],
  },
  // https://console.groq.com/docs/rate-limits; https://console.groq.com/docs/models
  // https://console.groq.com/docs/tool-use/overview
  groq: {
    hash: "34dcf2cfab29787fbf6996ff0beb94011ceb1dfe066670b92ed2458f37a2d4ad",
    verifiedAt: "2026-11-24T00:00:00Z",
    routes: [
      { providerModelId: "openai/gpt-oss-120b", contextWindow: 131072, supportsTools: true },
      { providerModelId: "openai/gpt-oss-20b", contextWindow: 131072, supportsTools: true },
      { providerModelId: "qwen/qwen3.8-27b", contextWindow: 131072, supportsTools: true },
    ],
  },
} satisfies Partial<Record<ProviderId, { hash: string; verifiedAt: string; routes: RegistryRoute[] }>>;

type RegistryProvider = keyof typeof registryPages;

export function registryPageHash(providerId: ProviderId): string | undefined {
  return Object.hasOwn(registryPages, providerId) ? registryPages[providerId as RegistryProvider].hash : undefined;
}

export function registryBatches(): SourceResult[] {
  return (Object.keys(registryPages) as RegistryProvider[]).map((providerId) => {
    const id = "registry:" + providerId;
    const { verifiedAt, routes }: { verifiedAt: string; routes: RegistryRoute[] } = registryPages[providerId];
    const reviewBy = new Date(Date.parse(verifiedAt) + registryReviewMs).toISOString();
    const observations: Observation[] = routes.map((route) => ({
      ...route, providerId, confidence: "page", source: id, promo: false, expiresAt: null,
      verifiedAt, reviewBy: route.reviewBy ?? reviewBy,
    }));
    return { id, observations };
  });
}

export function registryModelId(providerId: ProviderId, modelId: string): string {
  if (!Object.hasOwn(registryPages, providerId)) return modelId;
  const id = modelId.toLowerCase();
  const routes = registryPages[providerId as RegistryProvider].routes;
  const matching = routes.filter(({ providerModelId }) => {
    const officialId = providerModelId.toLowerCase();
    return id === officialId || id === officialId.split("/").at(-1);
  });
  return matching.length === 1 ? matching[0].providerModelId : modelId;
}
