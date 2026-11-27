// Декларации, которые импортирует копия app/src/shared/catalog-schema.ts из тега v0.1.5.
import { z } from "zod";

export const providerSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
export const personalIdSchema = z.enum([
  "openai-api", "anthropic-api", "google-api", "deepseek-api", "zai-api", "zai-coding",
  "moonshot-api", "minimax-api", "dashscope-api", "groq-api", "mistral-api", "custom-api",
  "kimi-code", "alibaba-coding", "opencode-go", "synthetic", "ollama-cloud"
]);
export const nativeIdSchema = z.enum(["github-copilot", "openai", "opencode", "xai"]);
