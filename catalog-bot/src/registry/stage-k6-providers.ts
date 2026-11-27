import type { Provider } from "../schema.js";

function provider(
  id: string, name: string, baseUrl: string, signupUrl: string, keyPageUrl: string | null, termsUrl: string,
  note: string, dataPolicy: string, notes: string,
  kind: "community" | "major" | "none" | "cloudflare" = "community", limits?: Provider["freeLimits"],
): Provider {
  const auth = { type: kind === "none" || kind === "cloudflare" ? kind : "manual_key" } as const;
  return {
    id, name, baseUrl, api: "openai", auth, loginMethods: [], signupUrl, keyPageUrl, termsUrl,
    keyPattern: null, clicksToConnect: kind === "none" ? 0 : 3,
    freeLimits: { ...limits, note }, dataPolicy, notes, ...(kind === "community" ? { trust: "community" } : {}),
  };
}

// Открытые списки /models и официальные страницы проверены 27.11.2026.
// Наличие провайдера в реестре не подтверждает цену или инструменты конкретной раздачи.
export const additionalProviders = {
  // https://text.pollinations.ai/models
  "pollinations": provider("pollinations", "Pollinations", "https://text.pollinations.ai/openai",
    "https://pollinations.ai", null, "https://pollinations.ai/terms",
    "Анонимный текстовый API. Числовой лимит старого маршрута не опубликован.", "Запросы проходят через Pollinations и поставщика модели.", "Анонимный openai-fast. Состав модели за этим псевдонимом может меняться.", "none"),
  // https://docs.aihubmix.com/en/blogs/free-ai-models
  "aihubmix": provider("aihubmix", "AIHubMix", "https://aihubmix.com/v1",
    "https://aihubmix.com", "https://aihubmix.com/token", "https://aihubmix.com/terms",
    "У coding-моделей обычно 5 запросов в минуту и 100–500 в сутки на модель.", "Данные обрабатывают шлюз и выбранный поставщик. Нулевое хранение зависит от маршрута.", "Используйте маршруты с пометкой free. Условия — в документации AIHubMix."),
  // https://crowllm.com/docs/authentication
  "crowllm": provider("crowllm", "CrowLLM", "https://crowllm.com/v1",
    "https://crowllm.com", "https://crowllm.com/keys", "https://crowllm.com/terms-of-service",
    "Бесплатный тариф ограничивает частоту запросов. Текущая квота в кабинете.", "Запросы обрабатывают CrowLLM и поставщик маршрута согласно условиям сервиса.", "Ключ аккаунта и точный ID с :free."),
  // https://bazaarlink.ai/free
  "bazaarlink": provider("bazaarlink", "BazaarLink", "https://api.bazaarlink.ai/v1",
    "https://bazaarlink.ai", "https://bazaarlink.ai/en/docs", "https://bazaarlink.ai/en/docs",
    "Без пополнения 10 запросов/мин, 60 взвешенных единиц/сутки. Платный режим отключается в кабинете.", "Политика хранения зависит от конкретного маршрута. В каталоге есть признак ZDR.", "Бесплатные маршруты делят квоту аккаунта.", "community", {"rpm":10,"concurrent":2}),
  // https://portal.nousresearch.com/privacy
  "nous": provider("nous", "Nous Portal", "https://inference-api.nousresearch.com/v1",
    "https://portal.nousresearch.com", "https://portal.nousresearch.com/", "https://portal.nousresearch.com/terms",
    "Выберите Free. Числовая квота и требование карты для Free не указаны.", "Действует политика Nous Portal и выбранного поставщика.", "Точные ID заканчиваются на :free.", "major"),
  // https://vercel.com/docs/ai-gateway/pricing
  "vercel": provider("vercel", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1",
    "https://vercel.com/ai-gateway", "https://vercel.com/d?to=%2F%5Bteam%5D%2F%2Fai-gateway%2Fapi-keys", "https://vercel.com/legal/terms",
    "Бесплатные маршруты и $5 кредита на 30 дней на Free. После покупки кредитов условия меняются.", "Хранение и обучение зависят от поставщика маршрута. Параметры ZDR и No Training видны в каталоге.", "Ключ создаётся в AI Gateway → API Keys.", "major"),
  // https://longcat.chat/platform/docs/ChangeLog.html
  "longcat": provider("longcat", "Meituan LongCat", "https://api.longcat.chat/openai/v1",
    "https://longcat.chat/platform", "https://longcat.chat/platform", "https://longcat.chat/platform/docs/FAQ.html",
    "Бесплатные токены LongCat. Объём зависит от уровня проверки аккаунта.", "Применяются политика LongCat и условия Meituan.", "Проверьте доступную квоту LongCat-2.5 в кабинете.", "major"),
  // https://www.sensenova.cn/en/token-plan
  "sensenova": provider("sensenova", "SenseNova Token Plan", "https://token.sensenova.cn/v1",
    "https://www.sensenova.cn/token-plan", "https://platform.sensenova.cn", "https://www.sensenova.cn/en/token-plan",
    "Бесплатно в публичной бете. Требуется проверка личности. Поддержка иностранных документов не подтверждена.", "Применяются условия SenseTime для аккаунта и вызовов API.", "Нужен ключ Token Plan. Поддержка tools в публичной документации бесплатного маршрута не подтверждена.", "major"),
  // https://discovery.intern-ai.org.cn/
  "inkstone": provider("inkstone", "Intern InkStone", "https://discovery-api.intern-ai.org.cn/v1",
    "https://discovery.intern-ai.org.cn/", "https://discovery.intern-ai.org.cn/", "https://discovery.intern-ai.org.cn/",
    "Бесплатные модели в программе InkStone. Условия регистрации и подтверждения телефона проверяйте в кабинете.", "Политика обработки запросов доступна в кабинете.", "API запрашивает ключ. Точные условия и инструменты требуют проверки.", "major"),
  // https://www.tencentcloud.com/document/product/1300/80423
  "tokenhub": provider("tokenhub", "Tencent TokenHub", "https://tokenhub-intl.tencentcloudmaas.com/v1",
    "https://www.tencentcloud.com/products/tokenhub", "https://console.tencentcloud.com/tokenhub/apikey", "https://www.tencentcloud.com/document/product/301",
    "Промо до 31.12.2026. До 1 млн токенов на модель по условиям предложения. Проверьте регион и аккаунт.", "Действуют условия Tencent Cloud и поставщика модели.", "Международный API. Проверьте остаток бесплатного пакета и настройку постоплаты.", "major"),
  // https://axforge.ai/models/
  "axforge": provider("axforge", "AxForge", "https://api.axforge.ai/v1",
    "https://axforge.ai/", "https://console.axforge.ai/", "https://axforge.ai/rules/",
    "3 млн бесплатных серверных токенов на 30 дней после проверки карты без списания.", "AxForge размещает модели в ЕС. Действуют условия AxForge.", "Используйте квоту своего аккаунта."),
  // https://docs.hetzner.com/general/company-and-policy/experiments/inference/
  "hetzner": provider("hetzner", "Hetzner Inference", "https://inference.hetzner.com/v1",
    "https://experiments.hetzner.com/inference", "https://experiments.hetzner.com/inference", "https://docs.hetzner.com/general/company-and-policy/experiments/inference/",
    "Эксперимент бесплатен до 08.12.2026. До 10 запросов в минуту на ключ.", "API в ЕС. Экспериментальный сервис, возможны изменения доступности.", "Токен создаётся в Hetzner Experiments.", "major", {"rpm":10}),
  // https://www.inferx.net/docs/quickstart
  "inferx": provider("inferx", "InferX", "https://model.inferx.net/endpoints/v1",
    "https://www.inferx.net/", "https://console.inferx.net/", "https://www.inferx.net/docs/quickstart",
    "Квота зависит от рабочего пространства и выбранного endpoint.", "Запросы обрабатываются InferX согласно условиям аккаунта.", "API требует ключ и контекст рабочего пространства."),
  // https://tokenlab.amd.com/
  "amd-token-lab": provider("amd-token-lab", "AMD Token Lab", "https://api.tokenlab.amd.com/v1",
    "https://tokenlab.amd.com", "https://tokenlab.amd.com", "https://www.amd.com/en/legal/privacy.html",
    "20 запросов в минуту. Пробный ключ даёт 10 баллов на 30 дней.", "Действуют правила программы AMD и политика обработки данных AMD.", "Ключ создаётся в AMD Token Lab.", "major"),
  // https://docs.beatapi.io/free-models
  "beatapi": provider("beatapi", "BeatAPI", "https://api.beatapi.io/v1",
    "https://beatapi.io", "https://beatapi.io/dashboard/apikeys", "https://beatapi.io/terms-of-service",
    "1 успешный запрос в минуту до пополнения. После пополнения до 10.", "BeatAPI маршрутизирует запросы к поставщикам моделей.", "Используйте точный ID с -free и ключ группы auto.", "community", {"rpm":1}),
  // https://api.tokenrouter.com/api/pricing
  "tokenrouter": provider("tokenrouter", "TokenRouter", "https://api.tokenrouter.com/v1",
    "https://www.tokenrouter.com", "https://www.tokenrouter.com/console/token", "https://www.tokenrouter.com/",
    "Бесплатные маршруты группы default. Числовая квота не опубликована.", "Запросы обрабатывают TokenRouter и поставщик модели.", "Используйте точный нулевой тариф из каталога."),
  // https://gonkabroker.com/free-llm-api/
  "gonkabroker": provider("gonkabroker", "Gonka Broker", "https://proxy.gonkabroker.com/v1",
    "https://gonkabroker.com", "https://gonkabroker.com", "https://gonkabroker.com/terms",
    "От 1 млн токенов в месяц после SMS-подтверждения. Платный баланс может использоваться после расходования бесплатного.", "Запросы обрабатывает брокер и инфраструктура сети Gonka.", "Бесплатный баланс распространяется на все модели. Проверьте остаток, если на аккаунте есть платные средства."),
  // https://www.synap402.com/free.html
  "synap": provider("synap", "Synap", "https://synap402.com/v1",
    "https://synap402.com", "https://synap402.com/", "https://synap402.com/terms",
    "Qwen3 Coder 30B: первые 7 дней до 50 запросов или 100 тыс. токенов в сутки, затем 10 запросов или 50 тыс. токенов.", "Применяется политика Synap для выбранной модели.", "Маршруты общего тарифа могут быть платными."),
  // https://cheapllm.shop/docs
  "cheapllm": provider("cheapllm", "CheapLLM", "https://cheapllm.shop/v1",
    "https://cheapllm.shop", "https://cheapllm.shop/signup", "https://cheapllm.shop/terms",
    "Бесплатная бета. После беты от 5000 входных и 1000 выходных токенов в час.", "Провайдер указывает, что не хранит API-промпты и ответы. Метаданные запросов сохраняются.", "Личный ключ. Бесплатная квота только для собственного использования."),
  // https://docs.llm7.io/quickstart.md
  "llm7": provider("llm7", "LLM7", "https://api.llm7.io/v1",
    "https://llm7.io", "https://token.llm7.io/", "https://github.com/chigwell/llm7.io/blob/main/TERMS.md",
    "Текущая бесплатная квота не подтверждена. Проверьте условия токена.", "Действуют условия LLM7 для аккаунта и выбранного поставщика.", "Анонимный чат требует ключ."),
  // https://developers.cloudflare.com/workers-ai/platform/pricing/
  "cloudflare": provider("cloudflare", "Cloudflare Workers AI", "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    "https://dash.cloudflare.com/", "https://dash.cloudflare.com/", "https://www.cloudflare.com/terms/",
    "10 000 нейронов в сутки на Free. Сброс в 00:00 UTC.", "Правила Workers AI и режим хранения зависят от модели. Смотрите Zero Data Retention в карточке модели.", "Дашборд → Workers AI → Use REST API. Нужны Account ID и API-токен.", "cloudflare"),
};
