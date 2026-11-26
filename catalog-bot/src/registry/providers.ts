import type { Provider, ProviderId } from "../schema.js";

export const numesPublicModelsUrl = "https://numes.ai/api/public-catalogue/models";

export const providers: Record<ProviderId, Provider> = {
  // 2026-11-24: https://openrouter.ai/docs/guides/overview/auth/oauth
  // https://openrouter.ai/api/v1/models; https://openrouter.ai/docs/api_reference/limits
  // https://openrouter.ai/docs/guides/privacy/data-collection
  openrouter: {
    id: "openrouter", name: "OpenRouter", api: "openai", baseUrl: "https://openrouter.ai/api/v1",
    auth: { type: "oauth_pkce", authorizeUrl: "https://openrouter.ai/auth", exchangeUrl: "https://openrouter.ai/api/v1/auth/keys" },
    loginMethods: ["github", "google"], signupUrl: "https://openrouter.ai/", keyPageUrl: null, keyPattern: null,
    clicksToConnect: 1, freeLimits: { rpm: 20, rpd: 50, note: "1000 запросов в сутки после покупки не менее $10 кредитов" },
    dataPolicy: "Бесплатные маршруты могут сохранять запросы. Политика зависит от поставщика модели.",
    termsUrl: "https://openrouter.ai/terms", notes: "OAuth PKCE для сторонних приложений.",
  },
  // 2026-11-24: https://kilo.ai/docs/gateway/models-and-providers
  // https://kilo.ai/docs/gateway/authentication; https://kilo.ai/docs/gateway/usage-and-billing
  kilo: {
    id: "kilo", name: "Kilo Gateway", api: "openai", baseUrl: "https://ai-gateway.kilo.ai/api/v1",
    auth: { type: "none" }, loginMethods: [], signupUrl: "https://kilo.ai/gateway",
    keyPageUrl: null, keyPattern: null, clicksToConnect: 0, freeLimits: { rph: 200, note: "На IP-адрес" },
    dataPolicy: "Политика хранения зависит от маршрута и поставщика модели.",
    termsUrl: "https://kilo.ai/terms", notes: "Бесплатные модели доступны анонимно.",
  },
  // 2026-11-24: https://numes.ai/docs/models.md; https://numes.ai/docs/account/api-keys.md
  // https://numes.ai/auth/login; https://numes.ai/docs/privacy/data-retention
  // Публичный JSON загружает https://numes.ai/models без cookies. Совместимый /models вернул 401 без ключа.
  numes: {
    id: "numes", name: "Numes", api: "openai", baseUrl: "https://api.numes.ai/api/v1",
    auth: { type: "manual_key" }, loginMethods: ["apple", "github", "google"],
    signupUrl: "https://numes.ai/auth/login", keyPageUrl: "https://numes.ai/dashboard/keys",
    keyPattern: "^sk-[A-Za-z0-9_-]+$", clicksToConnect: 3,
    freeLimits: { note: "Отдельная квота для бесплатных запросов. Требуется подтверждённый email." },
    dataPolicy: "Numes хранит метаданные, обработка содержимого зависит от выбранного поставщика.",
    termsUrl: "https://numes.ai/legal/terms", notes: "Ключ привязан к USD или BTC. Публичный каталог показывает USD.",
  },
  // 2026-11-24: https://www.runcrate.ai/inference; https://www.runcrate.ai/inference/free
  // https://www.runcrate.ai/blog/free-inference; https://www.runcrate.ai/privacy
  runcrate: {
    id: "runcrate", name: "Runcrate", api: "openai", baseUrl: "https://api.runcrate.ai/v1",
    auth: { type: "manual_key" }, loginMethods: ["github", "google"],
    signupUrl: "https://www.runcrate.ai/inference/free", keyPageUrl: "https://www.runcrate.ai/dashboard/api-keys",
    keyPattern: "^rc_live_[A-Za-z0-9_-]+$", clicksToConnect: 3,
    freeLimits: { note: "Общая квота рабочего пространства, обновляется по понедельникам. Вход через Google требует карту, сверх квоты возможна автодоплата." },
    dataPolicy: "Запросы обслуживают сторонние поставщики на своих условиях.",
    termsUrl: "https://www.runcrate.ai/terms",
    notes: "Для бесплатного доступа без карты аккаунт GitHub должен быть старше 30 дней. При входе через Google нужна карта, сверх квоты возможна автодоплата.",
  },
  // 2026-11-24: https://docs.z.ai/guides/develop/http/introduction
  // https://docs.z.ai/guides/overview/pricing; https://docs.z.ai/api-reference/rate-limit
  zai: {
    id: "zai", name: "Z.ai", api: "openai", baseUrl: "https://api.z.ai/api/paas/v4",
    auth: { type: "manual_key" }, loginMethods: ["google"], signupUrl: "https://z.ai/",
    keyPageUrl: "https://z.ai/manage-apikey/apikey-list", keyPattern: null, clicksToConnect: 3,
    freeLimits: { note: "GLM-4.7-Flash бесплатна. Ограничение параллельных запросов смотрите в кабинете API." },
    dataPolicy: "Действуют условия обработки данных API Z.ai.", termsUrl: "https://docs.z.ai/legal-agreement/terms-of-use", notes: "Бесплатный GLM-4.7-Flash доступен на платформе API.",
  },
  // 2026-11-24: https://www.modelscope.cn/docs/model-service/API-Inference/limits.md
  // https://modelscope.cn/docs/model-service/API-Inference/intro; https://developer.aliyun.com/article/1644361
  // 2000 вызовов/сутки из старого объявления заменены в актуальных правилах на списание Magicubes.
  modelscope: {
    id: "modelscope", name: "ModelScope", api: "openai", baseUrl: "https://api-inference.modelscope.cn/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://modelscope.cn/",
    keyPageUrl: "https://modelscope.cn/my/myaccesstoken", keyPattern: "^ms-[A-Za-z0-9_-]+$", clicksToConnect: 3,
    freeLimits: { note: "До 250 бесплатных Magicubes в день за ежедневный вход и привязку Alibaba Cloud. Вызов расходует 0,5–2 Magicubes. Нужны подтверждённый email и верифицированный аккаунт Alibaba Cloud." },
    dataPolicy: "Запросы обрабатываются на вычислительных ресурсах Alibaba Cloud.",
    termsUrl: "https://www.modelscope.cn/docs/model-service/API-Inference/limits",
    notes: "Некоммерческое использование. Нужен привязанный аккаунт Alibaba Cloud с подтверждённой личностью.",
  },
  // 2026-11-24: https://console.groq.com/docs/openai; https://console.groq.com/docs/rate-limits
  // https://console.groq.com/docs/your-data
  groq: {
    id: "groq", name: "Groq", api: "openai", baseUrl: "https://api.groq.com/openai/v1",
    auth: { type: "manual_key" }, loginMethods: ["google"], signupUrl: "https://console.groq.com/login",
    keyPageUrl: "https://console.groq.com/keys", keyPattern: "^gsk_[A-Za-z0-9]+$", clicksToConnect: 3,
    freeLimits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000, note: "Бесплатный план для gpt-oss-120b, gpt-oss-20b и Qwen3.8-27B" },
    dataPolicy: "Политика Groq зависит от функции API и настроек организации.",
    termsUrl: "https://groq.com/terms-of-use", notes: "Только для коротких задач из-за лимита токенов в минуту.",
  },
};

type ProviderUnderReview = Omit<Provider, "id"> & { id: string };

// Идентификаторы для проверок бота. Приложение v0.1.0 принимает в catalog.json
// только значения из providerIdSchema.
export const providersUnderReview = {
  "nvidia-nim": {
    id: "nvidia-nim", name: "NVIDIA NIM", api: "openai", baseUrl: "https://integrate.api.nvidia.com/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://build.nvidia.com/",
    keyPageUrl: "https://build.nvidia.com/", keyPattern: null, clicksToConnect: 3,
    freeLimits: { note: "Ключ NVIDIA Developer Program даёт бесплатный доступ для прототипирования. Квоты зависят от модели и аккаунта." },
    dataPolicy: "Действуют условия NVIDIA API Catalog и выбранной модели.",
    termsUrl: "https://developer.nvidia.com/legal/terms",
    notes: "Free-LLM указывает, что при регистрации может потребоваться подтверждение телефона.",
  },
  "ovh-ai-endpoints": {
    id: "ovh-ai-endpoints", name: "OVH AI Endpoints", api: "openai",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://endpoints.ai.cloud.ovh.net/",
    keyPageUrl: "https://www.ovh.com/manager/#/public-cloud/", keyPattern: null, clicksToConnect: 3,
    freeLimits: { rpm: 2, note: "Бесплатно анонимно: 2 запроса в минуту на IP и модель. Запросы с ключом тарифицируются." },
    dataPolicy: "Запросы обрабатывает OVHcloud в рамках условий AI Endpoints.",
    termsUrl: "https://www.ovhcloud.com/en/terms-and-conditions/",
    notes: "Анонимный доступ открыт без ключа. Ключ создаётся в разделе AI Endpoints проекта Public Cloud.",
  },
} satisfies Record<string, ProviderUnderReview>;
