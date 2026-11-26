import { z } from "zod";
import { providerIdSchema } from "./catalog-schema";

export const personalIdSchema = z.enum([
  "openai-api", "anthropic-api", "google-api", "deepseek-api", "zai-api", "zai-coding",
  "moonshot-api", "minimax-api", "dashscope-api", "groq-api", "mistral-api", "custom-api",
  "kimi-code", "alibaba-coding", "opencode-go", "synthetic", "ollama-cloud"
]);
/** Свои поставщики, которых пользователь добавил сам (их может быть несколько): custom-<8 символов a-z0-9>. */
export const customIdSchema = z.string().regex(/^custom-[a-z0-9]{8}$/);
export const keyIdSchema = z.union([providerIdSchema, personalIdSchema, customIdSchema]);
export const nativeIdSchema = z.enum(["github-copilot", "openai", "opencode", "xai"]);
export type PersonalId = z.infer<typeof personalIdSchema>;
export type CustomId = z.infer<typeof customIdSchema>;
export type KeyId = z.infer<typeof keyIdSchema>;
export type NativeId = z.infer<typeof nativeIdSchema>;

export type PersonalProvider = {
  id: PersonalId;
  name: string;
  /** api — оплата за токены; plan — подписка на кодинг-план с ключом. */
  kind: "api" | "plan";
  note?: string;
  baseUrl?: string;
  keyPageUrl?: string;
  keyPattern?: string;
  models?: RemoteModel[];
};

export const personalProviders: PersonalProvider[] = [
  { kind: "api", id: "openai-api", name: "OpenAI", baseUrl: "https://api.openai.com/v1", keyPageUrl: "https://platform.openai.com/api-keys", keyPattern: "^sk-(?:(?:proj-|svcacct-)[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{48})$" },
  { kind: "api", id: "anthropic-api", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", keyPageUrl: "https://platform.claude.com/settings/keys", keyPattern: "^sk-ant-api[0-9]+-[A-Za-z0-9_-]{32,}$" },
  { kind: "api", id: "google-api", name: "Google AI Studio", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyPageUrl: "https://aistudio.google.com/apikey", keyPattern: "^AIza[A-Za-z0-9_-]{35}$" },
  { kind: "api", id: "deepseek-api", name: "DeepSeek", baseUrl: "https://api.deepseek.com", keyPageUrl: "https://platform.deepseek.com/api_keys", keyPattern: "^sk-[a-f0-9]{32}$" },
  { kind: "api", id: "zai-api", name: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4", keyPageUrl: "https://z.ai/manage-apikey/apikey-list", keyPattern: "^[A-Za-z0-9]{24,}\\.[A-Za-z0-9]{8,}$" },
  { id: "zai-coding", kind: "plan", name: "GLM Coding Plan (Z.ai)", baseUrl: "https://api.z.ai/api/coding/paas/v4", keyPageUrl: "https://z.ai/manage-apikey/apikey-list", keyPattern: "^[A-Za-z0-9]{24,}\\.[A-Za-z0-9]{8,}$" },
  { kind: "api", id: "moonshot-api", name: "Moonshot / Kimi", baseUrl: "https://api.moonshot.ai/v1", keyPageUrl: "https://platform.moonshot.ai/console/api-keys", keyPattern: "^sk-[A-Za-z0-9]{40,}$" },
  { kind: "api", id: "minimax-api", name: "MiniMax", baseUrl: "https://api.minimax.io/v1", keyPageUrl: "https://platform.minimax.io/user-center/basic-information/interface-key", keyPattern: "^sk-(?:api|cp)-[A-Za-z0-9_-]{24,}$" },
  { kind: "api", id: "dashscope-api", name: "Qwen / DashScope", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyPageUrl: "https://modelstudio.console.alibabacloud.com/", keyPattern: "^sk-[a-f0-9]{32}$" },
  { kind: "api", id: "groq-api", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyPageUrl: "https://console.groq.com/keys", keyPattern: "^gsk_[A-Za-z0-9]{40,}$" },
  { kind: "api", id: "mistral-api", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyPageUrl: "https://console.mistral.ai/api-keys", keyPattern: "^[A-Za-z0-9]{32}$" },
  { id: "custom-api", kind: "api", name: "Свой OpenAI-совместимый" },
  // Кодинг-планы, которые официально разрешают сторонние агенты (вендоры прямо называют OpenCode, Cline, Kilo и др.).
  { id: "kimi-code", kind: "plan", name: "Kimi Code", baseUrl: "https://api.kimi.ai/coding/v1", keyPageUrl: "https://www.kimi.com/code/console",
    models: [
      { id: "kimi-for-coding", name: "Kimi for Coding", context: 1_000_000 },
      { id: "k3-256k", name: "Kimi K3 256K", context: 256_000 },
      { id: "kimi-for-coding-highspeed", name: "Kimi for Coding HighSpeed" }
    ] },
  { id: "alibaba-coding", kind: "plan", name: "Alibaba Coding Plan (Qwen)", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", keyPageUrl: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan", keyPattern: "^sk-sp-[A-Za-z0-9_-]{16,}$" },
  { id: "opencode-go", kind: "plan", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", keyPageUrl: "https://opencode.ai/auth" },
  { id: "synthetic", kind: "plan", name: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", keyPageUrl: "https://synthetic.new/user-settings/api" },
  { id: "ollama-cloud", kind: "plan", name: "Ollama Cloud", baseUrl: "https://ollama.com/v1", keyPageUrl: "https://ollama.com/settings/keys" }
];

export const nativeNames: Record<NativeId, string> = {
  "github-copilot": "GitHub Copilot", openai: "ChatGPT Plus / Pro", opencode: "OpenCode Zen", xai: "SuperGrok"
};

export const remoteModelsSchema = z.array(z.object({
  id: z.string().min(1).max(512), name: z.string().min(1).max(512),
  context: z.int().positive().optional(), output: z.int().positive().optional(), vision: z.boolean().optional()
})).max(1000);
export type RemoteModel = z.infer<typeof remoteModelsSchema>[number];
/** api — платный ключ, plan — кодинг-план с ключом, subscription — вход в аккаунт (ChatGPT, Copilot, SuperGrok), custom — свой поставщик, zen — OpenCode Zen. */
export type PersonalKind = "api" | "plan" | "subscription" | "custom" | "zen";
export type PersonalModel = RemoteModel & { providerId: KeyId | NativeId; providerName: string; upstreamId?: string; kind?: PersonalKind };
