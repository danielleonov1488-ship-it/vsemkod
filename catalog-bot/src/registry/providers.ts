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
  // 2026-11-27: https://docs.api.nvidia.com/nim/docs/api-quickstart;
  // https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317;
  // https://www.nvidia.com/en-us/about-nvidia/privacy-policy/
  "nvidia-nim": {
    id: "nvidia-nim", name: "NVIDIA Build", api: "openai", baseUrl: "https://integrate.api.nvidia.com/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://build.nvidia.com/",
    keyPageUrl: "https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b", keyPattern: "^nvapi-[A-Za-z0-9_-]+$", clicksToConnect: 3,
    freeLimits: {note: "Бесплатный доступ NVIDIA Developer Program для тестов. Квота зависит от модели и аккаунта."},
    dataPolicy: "Применяются условия пробного API NVIDIA и выбранной модели.",
    termsUrl: "https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf",
    notes: "Только тестирование и прототипирование. Корпоративные нагрузки требуют отдельной лицензии.",
  },
  // 2026-11-27: https://docs.requesty.ai/quickstart;
  // https://www.requesty.ai/pricing;
  // https://www.requesty.ai/privacy
  requesty:  {
    id: "requesty", name: "Requesty", api: "openai", baseUrl: "https://router.requesty.ai/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://app.requesty.ai/sign-up",
    keyPageUrl: "https://app.requesty.ai/api-keys", keyPattern: null, clicksToConnect: 3,
    freeLimits: {rpd: 200,note: "200 запросов в день на бесплатных моделях, карта не нужна."},
    dataPolicy: "Обработка зависит от маршрута. Политика Requesty допускает использование содержимого запросов к некоторым моделям бесплатного плана для обучения.",
    termsUrl: "https://www.requesty.ai/terms",
    notes: "Используйте ключ бесплатного плана.",
  },
  // 2026-11-27: https://docs.cohere.com/docs/compatibility-api;
  // https://docs.cohere.com/docs/rate-limits;
  // https://cohere.com/pricing;
  // https://cohere.com/privacy;
  // https://cohere.com/model-training-privacy-notice
  cohere:  {
    id: "cohere", name: "Cohere", api: "openai", baseUrl: "https://api.cohere.ai/compatibility/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://dashboard.cohere.com/login",
    keyPageUrl: "https://dashboard.cohere.com/api-keys", keyPattern: null, clicksToConnect: 3,
    freeLimits: {rpm: 20,note: "До 1000 вызовов в месяц с пробным ключом."},
    dataPolicy: "Для пробного аккаунта применяются политика конфиденциальности и правила обучения Cohere.",
    termsUrl: "https://cohere.com/terms-of-use",
    notes: "Только личное использование. Пробный ключ для некоммерческих тестов и прототипов.",
  },
  // 2026-11-27: https://docs.ifm.ai/quickstart/;
  // https://docs.ifm.ai/limits/;
  // https://docs.ifm.ai/;
  // https://mbzuai.ac.ae/privacy-policy
  ifm:  {
    id: "ifm", name: "IFM", api: "openai", baseUrl: "https://api.ifm.ai/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://platform.ifm.ai/",
    keyPageUrl: "https://platform.ifm.ai/api-keys", keyPattern: null, clicksToConnect: 3, trust: "community",
    freeLimits: {tpd: 10000000,allModelsFree: true,note: "10 млн токенов на ключ в сутки, сброс в 00:00 UTC."},
    dataPolicy: "Действует политика MBZUAI, ссылка опубликована в документации API.",
    termsUrl: "https://platform.ifm.ai/",
    notes: "Для кодинга доступны текстовые модели IFM. Ключ создаётся в IFM Platform.",
  },
  // 2026-11-27: https://zro.moonmath.ai/;
  // https://zro.moonmath.ai/docs/api;
  // https://zro.moonmath.ai/docs/privacy
  zro:  {
    id: "zro", name: "Zro (MoonMath)", api: "openai", baseUrl: "https://zro.moonmath.ai/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://zro.moonmath.ai/sign-up",
    keyPageUrl: "https://zro.moonmath.ai/docs/quickstart", keyPattern: null, clicksToConnect: 3, trust: "community",
    freeLimits: {note: "Бесплатная квота DeepSeek V4.1 Flash обновляется ежедневно."},
    dataPolicy: "Zro заявляет нулевое хранение запросов и ответов и отсутствие обучения на них.",
    termsUrl: "https://zro.moonmath.ai/terms",
    notes: "Создайте ключ в Account → API keys.",
  },
  // 2026-11-27: https://wusrouter.com/v1/models;
  // https://wusrouter.com/models;
  // https://wusrouter.com/terms
  wusrouter:  {
    id: "wusrouter", name: "WusRouter", api: "openai", baseUrl: "https://wusrouter.com/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://wusrouter.com/",
    keyPageUrl: "https://wusrouter.com/", keyPattern: null, clicksToConnect: 3, trust: "community",
    freeLimits: {note: "Бесплатный маршрут из публичного списка. Доступность и квоту проверяйте в кабинете."},
    dataPolicy: "Условия сервиса заявляют отсутствие хранения запросов и ответов. Запросы проходят через шлюз и поставщика модели.",
    termsUrl: "https://wusrouter.com/terms",
    notes: "Создайте собственный ключ WusRouter. Бесплатные маршруты меняются.",
  },
  // 2026-11-27: https://www.orcarouter.ai/privacy.html;
  // https://api.orcarouter.ai/v1/models
  orcarouter:  {
    id: "orcarouter", name: "OrcaRouter", api: "openai", baseUrl: "https://api.orcarouter.ai/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://www.orcarouter.ai/login",
    keyPageUrl: "https://www.orcarouter.ai/solutions/api-keys", keyPattern: null, clicksToConnect: 3, trust: "community",
    freeLimits: {note: "У бесплатных моделей ID заканчивается на -free. Список и квоты могут меняться."},
    dataPolicy: "Шлюз передаёт запросы поставщикам моделей. Хранение зависит от поставщика и настроек журнала.",
    termsUrl: "https://www.orcarouter.ai/terms.html",
    notes: "Для бесплатной программы может требоваться привязка собственного GitHub-аккаунта.",
  },
  // 2026-11-27: https://gonkarouter.io/;
  // https://gonkarouter.io/docs;
  // https://gonkarouter.io/privacy-policy
  gonkarouter:  {
    id: "gonkarouter", name: "GonkaRouter", api: "openai", baseUrl: "https://api.gonkarouter.io/v1",
    auth: { type: "manual_key" }, loginMethods: ["google"], signupUrl: "https://gonkarouter.io/",
    keyPageUrl: "https://gonkarouter.io/docs", keyPattern: null, clicksToConnect: 3, trust: "community",
    freeLimits: {note: "Стартовая квота 1 млн токенов, без карты. Актуальный баланс доступен в кабинете."},
    dataPolicy: "Сервис может временно хранить запросы и ответы для диагностики и безопасности.",
    termsUrl: "https://gonkarouter.io/terms-of-service",
    notes: "Разовая стартовая квота. Дальнейшее использование оплачивается с пополненного баланса.",
  },
  // 2026-11-27: https://kenari.id/;
  // https://kenari.id/privacy;
  // https://kenari.id/v1/models
  kenari:  {
    id: "kenari", name: "Kenari", api: "openai", baseUrl: "https://kenari.id/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://kenari.id/login",
    keyPageUrl: "https://kenari.id/en/docs/authentication", keyPattern: "^kn-[A-Za-z0-9_-]+$", clicksToConnect: 3, trust: "community",
    freeLimits: {rpm: 5,rpd: 50,note: "50 бесплатных запросов в день без пополнения."},
    dataPolicy: "Kenari заявляет, что не сохраняет текст запросов и ответов. Действуют также условия поставщика модели.",
    termsUrl: "https://kenari.id/terms",
    notes: "Используйте собственный ключ Kenari и маршруты :free.",
  },
  // 2026-11-27: https://inference.dahl.global/docs/quickstart/;
  // https://inference.dahl.global/docs/api;
  // https://inference.dahl.global/privacy
  dahl:  {
    id: "dahl", name: "Dahl Inference", api: "openai", baseUrl: "https://inference.dahl.global/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://inference.dahl.global/",
    keyPageUrl: "https://inference.dahl.global/account", keyPattern: "^dahl_[A-Za-z0-9_-]+$", clicksToConnect: 3, trust: "community",
    freeLimits: {note: "100 млн токенов при регистрации. Бесплатные токены сгорают после 7 дней без запросов."},
    dataPolicy: "Данные обрабатывает FROMZERO OÜ и поставщики инфраструктуры по политике Dahl.",
    termsUrl: "https://inference.dahl.global/terms",
    notes: "Выделите токены из стартового баланса на свой ключ.",
  },
  // 2026-11-27: https://docs.exaone.ai/en/docs/changelog;
  // https://docs.exaone.ai/en/docs/rate-limits;
  // https://docs.exaone.ai/en/docs/k-exaone-2.5;
  // https://docs.exaone.ai/en/terms/privacy-policy
  "k-exaone": {
    id: "k-exaone", name: "K-EXAONE", api: "openai", baseUrl: "https://api.exaone.ai/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://docs.exaone.ai/en/docs/overview",
    keyPageUrl: "https://docs.exaone.ai/en/docs/quick-start", keyPattern: null, clicksToConnect: 3, trust: "community",
    freeLimits: {note: "API пока бесплатен. Суточная квота зависит от согласия на использование данных."},
    dataPolicy: "По условиям платформы добровольное согласие позволяет использовать запросы и ответы для обучения.",
    termsUrl: "https://docs.exaone.ai/en/terms/terms-of-service",
    notes: "Некоммерческое использование. Ключ действует 30 дней.",
  },
  // 2026-11-27: https://berget.ai/en/pricing;
  // https://docs.berget.ai/quickstart;
  // https://berget.ai/en/privacy;
  // https://api.berget.ai/v1/models
  berget:  {
    id: "berget", name: "Berget AI", api: "openai", baseUrl: "https://api.berget.ai/v1",
    auth: { type: "manual_key" }, loginMethods: [], signupUrl: "https://console.berget.ai/",
    keyPageUrl: "https://console.berget.ai/", keyPattern: null, clicksToConnect: 3, trust: "community",
    freeLimits: {note: "€5 стартового баланса на пробном плане, лимиты общие для аккаунта."},
    dataPolicy: "Инференс работает на инфраструктуре в Швеции. Применяется политика Berget AI.",
    termsUrl: "https://berget.ai/en/terms",
    notes: "Указанные модели расходуют стартовые кредиты. Дальнейший доступ требует платного плана.",
  },
  // 2026-11-27: https://cent-ai.dev/;
  // https://cent-ai.dev/event;
  // https://cent-ai.dev/docs/api/models;
  // https://cent-ai.dev/docs/privacy
  "cent-ai": {
    id: "cent-ai", name: "Cent AI", api: "openai", baseUrl: "https://api.cent-ai.dev/v1",
    auth: { type: "manual_key" }, loginMethods: ["github","google"], signupUrl: "https://cent-ai.dev/login",
    keyPageUrl: "https://cent-ai.dev/keys", keyPattern: "^cai_[A-Za-z0-9_-]+$", clicksToConnect: 3, trust: "community",
    freeLimits: {note: "Акция HY4 Flash до 30 ноября 2026 года."},
    dataPolicy: "Успешные запросы по умолчанию не сохраняются. Запросы с ошибками могут попасть в диагностические журналы.",
    termsUrl: "https://cent-ai.dev/legal/terms",
    notes: "Бесплатный ID акции — hy4-flash:free.",
  },
};

// Записи из approve ожидают ручной проверки перед включением в каталог.
export const draftProviders: Partial<Record<ProviderId, Provider>> = {
  // Конец черновиков approve
};

type ProviderUnderReview = Omit<Provider, "id"> & { id: string };

// Дополнительные провайдеры для сверки радаром.
export const providersUnderReview = {
  "nvidia-nim": providers["nvidia-nim"],
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
