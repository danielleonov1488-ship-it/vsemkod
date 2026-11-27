import type { ProviderId } from "../schema.js";
import type { Observation, SourceResult } from "../sources/common.js";

export const registryReviewMs = 14 * 24 * 60 * 60 * 1000;

type RegistryRoute = Pick<Observation, "providerModelId" | "contextWindow" | "supportsTools" | "reviewBy" | "expiresAt">;

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
  // 2026-11-27: https://integrate.api.nvidia.com/v1/models;
  // https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer
  "nvidia-nim": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "nvidia/nemotron-3-ultra-550b-a55b", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "nvidia/nemotron-3.5-super-vl-120b-a12b", contextWindow: 1048576, supportsTools: true },
    ],
  },
  // 2026-11-27: https://www.requesty.ai/models/free;
  // https://router.requesty.ai/v1/models
  "requesty": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "nvidia/nemotron-3-ultra-550b-a55b", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "nvidia/nemotron-3.5-lightning-30b-a3b", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "nvidia/muse-glimmer-30b", contextWindow: 131072, supportsTools: true },
      { providerModelId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", contextWindow: 131072, supportsTools: true },
      { providerModelId: "google/gemma-4-31b-it", contextWindow: 262144, supportsTools: true },
    ],
  },
  // 2026-11-27: https://docs.cohere.com/docs/compatibility-api;
  // https://docs.cohere.com/docs/command-a
  "cohere": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "command-a-03-2025", contextWindow: 256000, supportsTools: true },
    ],
  },
  // 2026-11-27: https://api.ifm.ai/v1/models;
  // https://docs.ifm.ai/llms-full.txt
  "ifm": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "IFM/K2-Horizon-375B-A23B", contextWindow: 524288, supportsTools: true },
      { providerModelId: "IFM/Jais-3-MoVA-36B-A4B", contextWindow: 524288, supportsTools: true },
    ],
  },
  // 2026-11-27: https://zro.moonmath.ai/;
  // https://zro.moonmath.ai/docs/models;
  // https://zro.moonmath.ai/docs/api
  "zro": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "deepseek-v4.1-flash", contextWindow: 1048576, supportsTools: true },
    ],
  },
  // 2026-11-27: https://wusrouter.com/v1/models;
  // https://mimo.xiaomi.com/mimo-v2-5
  "wusrouter": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "mimo-v2.5:free", contextWindow: 1048576, supportsTools: true },
    ],
  },
  // 2026-11-27: https://api.orcarouter.ai/v1/models;
  // https://www.orcarouter.ai/blog/tencent-hy4-vs-tencent-hy4-preview
  "orcarouter": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "deepseek/deepseek-v4.1-flash-free", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "tencent/hy4-preview-free", contextWindow: 1048576, supportsTools: true },
      { providerModelId: "z-ai/glm-5.3-flash-free", contextWindow: 1048576, supportsTools: true },
    ],
  },
  // 2026-11-27: https://gonkarouter.io/docs;
  // https://gonkarouter.io/pricing
  "gonkarouter": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "zai-org/GLM-5.3-Flash", contextWindow: 200000, supportsTools: true },
      { providerModelId: "MiniMaxAI/MiniMax-M2.7", contextWindow: 200000, supportsTools: true },
      { providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731", contextWindow: 200000, supportsTools: true },
    ],
  },
  // 2026-11-27: https://kenari.id/v1/models;
  // https://kenari.id/en/docs/quickstart
  "kenari": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "nemotron-3-ultra-550b-a55b:free", contextWindow: 1000000, supportsTools: true },
      { providerModelId: "glm-4-7-flash:free", contextWindow: 200000, supportsTools: true },
      { providerModelId: "nemotron-3-5-lightning:free", contextWindow: 1000000, supportsTools: true },
      { providerModelId: "hy4-flash:free", contextWindow: 1048576, supportsTools: true },
    ],
  },
  // 2026-11-27: https://inference.dahl.global/v1/models;
  // https://inference.dahl.global/docs/api
  "dahl": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "MiniMaxAI/MiniMax-M2.7", contextWindow: 204800, supportsTools: true },
      { providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731", contextWindow: 1048576, supportsTools: true },
    ],
  },
  // 2026-11-27: https://docs.exaone.ai/en/docs/k-exaone-2.5;
  // https://docs.exaone.ai/en/docs/changelog
  "k-exaone": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "k-exaone_v2.5", contextWindow: 524288, supportsTools: true },
    ],
  },
  // 2026-11-27: https://api.berget.ai/v1/models;
  // https://berget.ai/en/serverless-inference
  "berget": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "moonshotai/Kimi-K3.1-Pro", contextWindow: 327680, supportsTools: true },
      { providerModelId: "zai-org/GLM-5.3-Flash", contextWindow: 262144, supportsTools: true },
    ],
  },
  // 2026-11-27: https://cent-ai.dev/docs/api/models;
  // https://cent-ai.dev/docs/api/chat-completions;
  // https://cent-ai.dev/event
  "cent-ai": {
    verifiedAt: "2026-11-27T00:00:00Z",
    routes: [
      { providerModelId: "hy4-flash:free", contextWindow: 1048576, supportsTools: true, expiresAt: "2026-11-30T23:59:59Z" },
    ],
  },
} satisfies Record<ProviderId, { hash?: string; verifiedAt: string; routes: RegistryRoute[] }>;

// Записи из approve ожидают проверки точных API ID и условий.
export const draftOffers: Partial<Record<ProviderId, {
  providerModelId: string; expiresAt: string | null; supportsTools?: boolean; sources: string[];
}[]>> = {
  // Конец черновиков approve
};

type RegistryProvider = keyof typeof registryPages;

export function registryPageHash(providerId: ProviderId): string | undefined {
  if (!Object.hasOwn(registryPages, providerId)) return;
  const page = registryPages[providerId as RegistryProvider];
  return "hash" in page ? page.hash : undefined;
}

export function registryBatches(): SourceResult[] {
  return (Object.keys(registryPages) as RegistryProvider[]).map((providerId) => {
    const id = "registry:" + providerId;
    const { verifiedAt, routes }: { verifiedAt: string; routes: RegistryRoute[] } = registryPages[providerId];
    const reviewBy = new Date(Date.parse(verifiedAt) + registryReviewMs).toISOString();
    const observations: Observation[] = routes.map((route) => ({
      ...route, providerId, confidence: "page", source: id, promo: !!route.expiresAt, expiresAt: route.expiresAt ?? null,
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
