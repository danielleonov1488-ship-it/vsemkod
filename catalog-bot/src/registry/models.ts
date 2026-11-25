import type { Model } from "../schema.js";

type RegistryModel = Model & { aliases: RegExp[] };

// Контексты и варианты ID сверены 2026-11-24 по живым каталогам OpenRouter и Kilo.
// Контекст конкретного бесплатного маршрута хранится отдельно в offer.contextWindow.
export const modelRegistry: RegistryModel[] = [
  { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", vendor: "Moonshot AI", tier: "top", description: "Для сложных задач в больших проектах", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning"], rank: 10, aliases: [/^kimi-?k3[.-]?1-?pro(?:-highspeed)?$/i] },
  { id: "glm-5.3", name: "GLM 5.3", vendor: "Z.ai", tier: "top", description: "Для длинных задач со многими шагами", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning"], rank: 20, aliases: [/^glm-?5[.-]?3(?:-fast)?$/i] },
  { id: "glm-5.2", name: "GLM 5.2", vendor: "Z.ai", tier: "top", description: "Для разбора и исправления больших кодовых баз", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning"], rank: 30, aliases: [/^glm-?5[.-]?2(?:-fast)?$/i] },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", vendor: "DeepSeek", tier: "top", description: "Для быстрого анализа кода и отладки", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning"], rank: 40, aliases: [/^deepseek-(?:v?4[.-]?1-)?flash(?:-1017)?(?:-(?:ultra)?fast)?$/i] },
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", vendor: "NVIDIA", tier: "top", description: "Для задач с длинным контекстом и инструментами", contextWindow: 262144, capabilities: ["code", "tools", "reasoning"], rank: 50, aliases: [/^nemotron-3-ultra(?:-550b-a55b)?$/i] },
  { id: "qwen3.8", name: "Qwen3.8", vendor: "Alibaba", tier: "top", description: "Для больших рефакторингов и анализа кода", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning"], rank: 60, aliases: [/^qwen-?3[.-]?8(?:-max(?:-0902)?|-2[.-]4t-a95b)?$/i] },
  { id: "minimax-m3", name: "MiniMax M3", vendor: "MiniMax", tier: "top", description: "Для многошаговой разработки с инструментами", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning"], rank: 70, aliases: [/^minimax-m3$/i] },
  { id: "gpt-oss-120b", name: "gpt-oss-120b", vendor: "OpenAI", tier: "top", description: "Для генерации и проверки кода", contextWindow: 131072, capabilities: ["code", "tools", "reasoning"], rank: 80, aliases: [/^gpt-?oss-?120b$/i] },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", vendor: "Z.ai", tier: "good", description: "Быстрый вариант для повседневных правок", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning"], rank: 110, aliases: [/^glm-?5[.-]?3-flash$/i] },
  { id: "glm-4.7-flash", name: "GLM-4.7-Flash", vendor: "Z.ai", tier: "good", description: "Для небольших правок и вопросов по коду", contextWindow: 200000, capabilities: ["code", "tools", "reasoning"], rank: 120, aliases: [/^glm-?4[.-]?7-flash$/i] },
  { id: "qwen3.8-flash", name: "Qwen3.8 Flash", vendor: "Alibaba", tier: "good", description: "Для быстрых ответов и локальных изменений", contextWindow: 1000000, capabilities: ["code", "tools", "reasoning"], rank: 130, aliases: [/^qwen-?3[.-]?8-flash$/i] },
  { id: "qwen3.8-27b", name: "Qwen3.8-27B", vendor: "Alibaba", tier: "good", description: "Для небольших задач на генерацию кода", contextWindow: 1024000, capabilities: ["code", "tools", "reasoning"], rank: 140, aliases: [/^qwen-?3[.-]?8-27b$/i] },
  { id: "nemotron-3.5-super", name: "Nemotron 3.5 Super", vendor: "NVIDIA", tier: "good", description: "Для анализа длинного текста и изображений", contextWindow: 1048576, capabilities: ["code", "tools", "reasoning", "vision"], rank: 150, aliases: [/^nemotron-3[.-]5-super(?:-vl)?$/i] },
  { id: "gpt-oss-20b", name: "gpt-oss-20b", vendor: "OpenAI", tier: "basic", description: "Для коротких запросов и простых фрагментов кода", contextWindow: 131072, capabilities: ["code", "tools", "reasoning"], rank: 210, aliases: [/^gpt-?oss-?20b$/i] },
];

export const models: Model[] = modelRegistry.map(({ aliases: _aliases, ...model }) => model);
