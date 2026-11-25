import { z } from "zod";
import { providerIdSchema } from "./catalog-schema";

export const personalIdSchema = z.enum([
  "openai-api", "anthropic-api", "google-api", "deepseek-api", "zai-api", "zai-coding",
  "moonshot-api", "minimax-api", "dashscope-api", "groq-api", "mistral-api", "custom-api"
]);
export const keyIdSchema = z.union([providerIdSchema, personalIdSchema]);
export const nativeIdSchema = z.enum(["github-copilot", "openai", "opencode"]);
export type PersonalId = z.infer<typeof personalIdSchema>;
export type KeyId = z.infer<typeof keyIdSchema>;
export type NativeId = z.infer<typeof nativeIdSchema>;

export type PersonalProvider = {
  id: PersonalId;
  name: string;
  baseUrl?: string;
  keyPageUrl?: string;
  keyPattern?: string;
};

export const personalProviders: PersonalProvider[] = [
  { id: "openai-api", name: "OpenAI", baseUrl: "https://api.openai.com/v1", keyPageUrl: "https://platform.openai.com/api-keys", keyPattern: "^sk-(?:(?:proj-|svcacct-)[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{48})$" },
  { id: "anthropic-api", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", keyPageUrl: "https://platform.claude.com/settings/keys", keyPattern: "^sk-ant-api[0-9]+-[A-Za-z0-9_-]{32,}$" },
  { id: "google-api", name: "Google AI Studio", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyPageUrl: "https://aistudio.google.com/apikey", keyPattern: "^AIza[A-Za-z0-9_-]{35}$" },
  { id: "deepseek-api", name: "DeepSeek", baseUrl: "https://api.deepseek.com", keyPageUrl: "https://platform.deepseek.com/api_keys", keyPattern: "^sk-[a-f0-9]{32}$" },
  { id: "zai-api", name: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4", keyPageUrl: "https://z.ai/manage-apikey/apikey-list", keyPattern: "^[A-Za-z0-9]{24,}\\.[A-Za-z0-9]{8,}$" },
  { id: "zai-coding", name: "Z.ai Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", keyPageUrl: "https://z.ai/manage-apikey/apikey-list", keyPattern: "^[A-Za-z0-9]{24,}\\.[A-Za-z0-9]{8,}$" },
  { id: "moonshot-api", name: "Moonshot / Kimi", baseUrl: "https://api.moonshot.ai/v1", keyPageUrl: "https://platform.moonshot.ai/console/api-keys", keyPattern: "^sk-[A-Za-z0-9]{40,}$" },
  { id: "minimax-api", name: "MiniMax", baseUrl: "https://api.minimax.io/v1", keyPageUrl: "https://platform.minimax.io/user-center/basic-information/interface-key", keyPattern: "^sk-(?:api|cp)-[A-Za-z0-9_-]{24,}$" },
  { id: "dashscope-api", name: "Qwen / DashScope", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyPageUrl: "https://modelstudio.console.alibabacloud.com/", keyPattern: "^sk-[a-f0-9]{32}$" },
  { id: "groq-api", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyPageUrl: "https://console.groq.com/keys", keyPattern: "^gsk_[A-Za-z0-9]{40,}$" },
  { id: "mistral-api", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyPageUrl: "https://console.mistral.ai/api-keys", keyPattern: "^[A-Za-z0-9]{32}$" },
  { id: "custom-api", name: "Свой OpenAI-совместимый" }
];

export const nativeNames: Record<NativeId, string> = {
  "github-copilot": "GitHub Copilot", openai: "ChatGPT Plus / Pro", opencode: "OpenCode Zen"
};

export const remoteModelsSchema = z.array(z.object({
  id: z.string().min(1).max(512), name: z.string().min(1).max(512),
  context: z.int().positive().optional(), output: z.int().positive().optional(), vision: z.boolean().optional()
})).max(1000);
export type RemoteModel = z.infer<typeof remoteModelsSchema>[number];
export type PersonalModel = RemoteModel & { providerId: PersonalId | NativeId; providerName: string; upstreamId?: string };
