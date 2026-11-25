# vsemkod — бот-каталог бесплатных моделей (спецификация v1)

## Зачем
vsemkod — бесплатное десктоп-приложение для AI-кодинга (как Claude Code). Модели в нём — топовые нейронки, которые прямо сейчас бесплатно раздают разные провайдеры. Пользователь подключает провайдеров своим аккаунтом (у каждого своя бесплатная квота), приложение само роутит запросы.

**Бот-каталог** круглосуточно ищет бесплатные раздачи и публикует один JSON-файл `catalog.json`, который скачивают все копии приложения. Требования заказчика: работать без присмотра, тратить копейки, показывать пользователям только топовые модели.

## Стек и структура
- Node.js 24, TypeScript (ESM), запуск через `tsx`. Зависимости минимальные: `zod` (схемы), `tsx`, `typescript`, `vitest` (тесты). HTTP — встроенный `fetch`. Без тяжёлых фреймворков.
- Устанавливай пакеты с локальным кэшем: `npm install --cache ./.npm-cache` (папка в `.gitignore`).
- Структура:

```
catalog-bot/
  package.json, tsconfig.json, .gitignore, .env.example, README.md (на русском)
  src/
    schema.ts            # zod-схемы + TS-типы каталога (их потом переиспользует приложение)
    config.ts            # чтение env, лимиты
    registry/providers.ts# курируемый список провайдеров (см. ниже)
    registry/models.ts   # курируемые канонические модели, уровни качества, алиасы
    sources/openrouter.ts# структурированный источник
    sources/kilo.ts      # структурированный источник
    sources/numes.ts     # структурированный (если есть ключ или публичный эндпоинт)
    sources/watchPages.ts# слежение за страницами бесплатных тарифов (хеш → LLM-разбор при изменении)
    sources/feeds.ts     # новости: HN Algolia, Reddit, GitHub-списки → LLM-разбор новых записей
    llm/client.ts        # OpenAI-совместимый клиент (по умолчанию DeepSeek), JSON-ответы
    llm/extract.ts       # промпты: «найди бесплатные раздачи в тексте» → структурированный JSON
    match.ts             # сопоставление id модели у провайдера → каноническая модель
    health.ts            # необязательная проверка живости (если заданы ключи мейнтейнера)
    merge.ts             # слияние наблюдений с прошлым каталогом, вычисление изменений
    publish.ts           # запись data/*.json, необязательная отправка в Telegram
    cli.ts               # команды
  data/
    catalog.json         # главный выход (то, что качает приложение)
    changes.json         # лента изменений (последние 200 событий)
    radar.json           # радар бесплатных моделей OpenCode Zen
    state.json           # служебное: хеши страниц, id уже обработанных новостей, счётчики
  tests/                 # vitest
  .github/workflows/catalog.yml
```

## Формат `catalog.json` (схема в `src/schema.ts`)
```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-24T12:00:00Z",
  "models": [
    {
      "id": "kimi-k3.1-pro",            // канонический id
      "name": "Kimi K3.1 Pro",
      "vendor": "Moonshot AI",
      "tier": "top",                      // top | good | new | basic
      "description": "Лучшая для сложных задач", // короткая строка на русском для меню выбора модели
      "contextWindow": 262144,
      "capabilities": ["code", "tools", "reasoning"],
      "rank": 10                           // порядок в меню (меньше = выше)
    }
  ],
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "api": "openai",                     // формат API: openai | anthropic
      "baseUrl": "https://openrouter.ai/api/v1",
      "auth": {
        "type": "oauth_pkce",              // none | oauth_pkce | device_code | manual_key
        "authorizeUrl": "https://openrouter.ai/auth",
        "exchangeUrl": "https://openrouter.ai/api/v1/auth/keys"
      },
      "loginMethods": ["google", "github"],
      "signupUrl": "https://openrouter.ai/",
      "keyPageUrl": null,                  // для manual_key: прямая ссылка на страницу создания ключа
      "keyPattern": null,                  // для manual_key: regex ключа, чтобы приложение поймало его из буфера обмена
      "clicksToConnect": 1,
      "freeLimits": { "rpm": 20, "rpd": 50, "note": "1000 запросов/день после разовой покупки $10" },
      "dataPolicy": "Бесплатные модели могут логировать запросы",
      "termsUrl": "https://openrouter.ai/terms",
      "notes": "Официальный OAuth для сторонних приложений"
    }
  ],
  "offers": [
    {
      "modelId": "nemotron-3-ultra",
      "providerId": "openrouter",
      "providerModelId": "nvidia/nemotron-3-ultra:free",
      "free": true,
      "promo": false,                      // временная акция?
      "expiresAt": null,                   // дата окончания акции, если известна
      "supportsTools": true,
      "contextWindow": 262144,
      "limits": { "rpm": 20, "rpd": 50 },
      "status": "active",                  // active | unverified | degraded | ended
      "confidence": "structured",          // structured (из API провайдера) | page (со страницы тарифов) | news (из новостей, LLM)
      "sources": ["openrouter:/api/v1/models"],
      "firstSeen": "...", "lastSeen": "...", "lastVerified": null
    }
  ],
  "candidates": [ /* то же, что offers, но не подтверждено: из новостей/LLM, неизвестная модель и т.п. Приложение их НЕ показывает */ ]
}
```
Правила:
- В `offers` попадают только предложения с `confidence` = `structured` или `page`, либо подтверждённые health-check. Всё из новостей/LLM — в `candidates`, пока не подтвердится структурированным источником или проверкой.
- Бесплатная модель вне реестра получает `tier: "new"` и активное предложение `structured`, если API подтверждает tools и контекст от 128 000 токенов. Утилиты, роутеры и явно меньшие 20B модели исключаются. Записи `new` идут после реестра, уступают появившейся записи реестра и удаляются вместе с последним предложением. Для добавления используется `offer_added` с текстом «Новая модель: X бесплатно у Y».
- Если оффер не видели N запусков подряд (по умолчанию 6) — `status: "ended"`; через 7 дней после окончания — удалить из файла. Акция с прошедшим `expiresAt` → `ended`.
- `changes.json`: события `offer_added`, `offer_ended`, `offer_changed` (лимиты/статус), `candidate_added`, `model_tier_changed` — с датой и коротким текстом на русском («Kimi K3.1 Pro теперь бесплатно у Numes»). Это лента для уведомлений «Новая раздача» в приложении.
- Вывод детерминированный: сортировка ключей и массивов, чтобы диффы в git были чистыми. Если по сути ничего не изменилось (кроме `generatedAt`/`lastSeen`) — файл не переписывать (чтобы не плодить коммиты), но `state.json` обновлять можно.

## Курируемый реестр (src/registry)
### Провайдеры (стартовый набор; ВСЕ URL и лимиты проверь по официальной документации, в коде оставь комментарий с источником и датой проверки)
| id | Авторизация | Что известно (ноябрь 2026, проверить) |
|---|---|---|
| `kilo` | `none` (анонимно) | Kilo Gateway, бесплатные `:free` модели, 200 запросов/час на IP; найти базовый URL и эндпоинт списка моделей в kilo.ai/docs/gateway |
| `openrouter` | `oauth_pkce` | `GET https://openrouter.ai/api/v1/models` публичный; `:free` модели, 20 rpm, 50 rpd (1000 после $10); OAuth PKCE: `/auth` + `POST /api/v1/auth/keys` |
| `numes` | `manual_key` | OpenAI-совместимый API `https://api.numes.ai/api/v1`, суффикс `:free`, вход Google/GitHub/Apple; доки в markdown: `https://numes.ai/docs/<page>.md`, индекс `/docs/llms.txt`; `GET /models` вероятно требует ключ — поддержи `NUMES_API_KEY`, а без ключа попробуй найти публичный эндпоинт каталога (сайт numes.ai/models показывает каталог без входа) |
| `runcrate` | `manual_key` | вход через GitHub (аккаунт старше 30 дней), недельная бесплатная квота на DeepSeek V4.1 Flash, GLM 5.3, GLM 5.3 Flash, gpt-oss 120B, Qwen3.8 Flash; страница `https://www.runcrate.ai/inference/free` |
| `zai` | `manual_key` | Z.ai, бесплатная GLM-4.7-Flash (без лимита токенов, 1 параллельный запрос), вход Google; страница тарифов docs.z.ai/guides/overview/pricing |
| `modelscope` | `manual_key` | 2000 вызовов/день, сильные модели (GLM-5.2, Kimi-K3.1-Pro, DeepSeek-V4.1-Flash, MiniMax-M3); условие «некоммерческое использование» — записать в `notes` |
| `groq` | `manual_key` | бесплатно gpt-oss-120b/20b, Qwen3.8-27B; 1000 rpd, но 8K токенов/мин — `notes`: «только для коротких задач» |

### Модели
Курируемый список канонических моделей с уровнем `tier`, описанием на русском, `rank` и **алиасами** (regex для сопоставления id у разных провайдеров, например `/kimi[-_.]?k3\.?1[-_.]?pro/i`). Стартовый набор `top`: Kimi K3.1 Pro, GLM 5.3, GLM 5.2, DeepSeek V4.1 Flash, Nemotron 3 Ultra, Qwen3.8 (крупная), MiniMax M3, gpt-oss-120b. `good`: GLM 5.3 Flash, GLM-4.7-Flash, Qwen3.8 Flash, Qwen3.8-27B, Nemotron 3.5 Super. `basic`: всё мелкое (gpt-oss-20b и т.п.). Проверь актуальные id моделей по живым ответам источников.

## Источники
1. **Структурированные** (без LLM, основной сигнал): OpenRouter `/api/v1/models` (бесплатно = `pricing.prompt == "0" && pricing.completion == "0"` или суффикс `:free`; `supported_parameters` содержит `tools` → `supportsTools`), Kilo (список моделей шлюза), Numes (если доступно). Таймауты 20 с, 2 повтора, понятные ошибки; падение одного источника не валит весь запуск.
2. **Страницы тарифов** (`watchPages.ts`): список URL в конфиге (Runcrate free, Z.ai pricing, ModelScope limits, Groq rate limits, Numes models docs). Скачать → вытащить текст → нормализовать → sha256. Если хеш изменился → отдать текст (обрезанный до ~12k символов) в LLM с просьбой извлечь бесплатные предложения по схеме → результат с `confidence: "page"`.
3. **Новости** (`feeds.ts`): HN Algolia (`https://hn.algolia.com/api/v1/search_by_date?query=...&tags=story`), Reddit (`https://www.reddit.com/r/LocalLLaMA/new.json`, свой User-Agent), README GitHub-списков бесплатных API (например `mnfst/awesome-free-llm-apis`, по хешу). Фильтр по ключевым словам (free, бесплатно, :free, promo, stealth, giveaway) до LLM, чтобы не тратить токены. Обработанные id хранить в `state.json`. Результат → только `candidates`.

## Радар OpenCode Zen

Публичный `GET https://opencode.ai/zen/v1/models` обновляет отдельный `data/radar.json`. В модели радара есть `source`, `id`, `name`, `description`, `contextWindow`, `tools`, `free`, `firstSeen`, `lastSeen` и `active`. Бесплатный маршрут имеет суффикс `-free` или нулевую цену входного и выходного текста. Записи сортируются по `id`. Модель помечается неактивной после успешной проверки, в которой она исчезла, и хранится ещё 30 дней. Новые записи попадают в Telegram. Радар публикуется отдельно от каталога и не меняется при обновлении одних лишь временных отметок.

## LLM (llm/client.ts)
- OpenAI-совместимый клиент: `LLM_BASE_URL` (по умолчанию `https://api.deepseek.com`), `LLM_API_KEY`, `LLM_MODEL` (по умолчанию самая дешёвая быстрая модель DeepSeek — сверь точное имя V4.1 Flash по api-docs.deepseek.com и укажи в `.env.example`). Ответы — строго JSON (response_format json_object), валидировать zod; при невалидном ответе — одна повторная попытка, потом пропуск.
- Экономия: вызывать только на изменившихся страницах и новых новостях; бюджет на запуск `LLM_MAX_TOKENS_PER_RUN` (по умолчанию 150000), кэш по хешу контента в `state.json`; печатать в конце использованные токены и примерную стоимость.
- Без `LLM_API_KEY` бот работает в режиме «только структурированные источники» (это должно быть штатно, не ошибка).

## Health-check (health.ts, необязательно)
Если заданы ключи мейнтейнера (`HEALTH_OPENROUTER_KEY`, `HEALTH_NUMES_KEY` и т.п.) — раз в N часов слать к каждому активному офферу крошечный запрос (max_tokens 8, один простой tool-call-тест для `supportsTools`), записывать `lastVerified`, при стабильных ошибках → `degraded`. Без ключей — пропуск.

## Telegram (publish.ts, выключено по умолчанию)
Если заданы `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`, после запуска отправить одно сообщение с новыми подтверждёнными раздачами уровня `top` и строкой «Радар: в OpenCode Zen появилась бесплатная модель X» для каждой новой модели радара.

## CLI
- `npm run update` — полный цикл: источники → сопоставление → слияние → запись `data/*`.
- Флаги: `--dry-run` (ничего не писать, вывести дифф/сводку), `--no-llm`, `--only=<source>`.
- `npm run validate` — проверить `data/catalog.json` и `data/radar.json`, если радар уже создан.
- `npm test` — vitest.
- В конце запуска — человекочитаемая сводка: сколько офферов, что добавилось/закончилось, ошибки источников, токены LLM.

## GitHub Actions (.github/workflows/catalog.yml)
Крон каждые 30 минут + ручной запуск: checkout → setup-node 24 → `npm ci` → `npm run update` с секретами из env → если `data/` изменился — коммит от имени бота и push. `concurrency` чтобы запуски не пересекались. (Сам репозиторий и секреты заказчик создаст потом — ничего не публикуй.)

## Тесты (обязательно)
- сопоставление id → каноническая модель (разные написания у провайдеров);
- парсинг ответа OpenRouter (фикстура-JSON в `tests/fixtures`);
- merge: добавление, исчезновение (N запусков → ended), истечение `expiresAt`, детерминированная сортировка, «ничего не изменилось → не переписывать»;
- валидация схемы и обработка невалидного ответа LLM (замоканный клиент).

## Порядок работы для тебя (Codex)
1. Сначала проверь по официальной документации и живым запросам: эндпоинты OpenRouter/Kilo/Numes, имя модели DeepSeek V4.1 Flash и базовые URL провайдеров. Зафиксируй находки в комментариях реестра и в README.
2. Реализуй по спецификации, напиши тесты, `npm test` должен проходить.
3. Запусти `npm run update -- --no-llm` на живых источниках, убедись, что получился осмысленный `data/catalog.json` (бесплатные модели OpenRouter/Kilo реально попали в offers, сопоставились с каноническими моделями), и `npm run validate` проходит.
4. README на русском: что это, как запустить локально, переменные окружения, как развернуть 24/7 (GitHub Actions бесплатно / свой VPS через cron или systemd timer), сколько стоит LLM.

## Ограничения
- Работай только внутри папки `catalog-bot/`. Никаких git push, публикаций, регистраций аккаунтов, обхода капч и т.п.
- Никаких секретов в коде и в репозитории: только `.env` (в `.gitignore`) и `.env.example` с пустыми значениями.
- Не делай мультиаккаунтов, не используй чужие/утёкшие ключи, не дёргай закрытые API личных кабинетов — только публичные эндпоинты, документированные API и публичные страницы.
- В конце коротко перечисли: что сделано, что проверено вживую, что не удалось проверить.
