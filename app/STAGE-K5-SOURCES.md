# Этап K5: ещё больше бесплатных источников (по итогам большого поиска)

Пять исследований (агрегаторы, Китай, Запад, Россия, трекеры раздач) нашли около 70 кандидатов. Claude уже проверил адреса вживую 2026-11-27, результаты ниже.

Задача:
- добавить рабочие источники в реестр бота;
- научить приложение двум особым провайдерам (GigaChat, Cloudflare);
- расширить слежку за раздачами.

Работаешь в `catalog-bot/**` и `app/**`. Не коммить и ничего не публикуй. Рабочие копии — только в `%TEMP%`.

## 0. Совместимость (важно)
Приложение 0.1.5 читает `catalog-v2.json`:
- неизвестный тип `auth` пропускает (провайдер отбрасывается);
- провайдер парсится строгой схемой (`.strict()`), поэтому **любое новое поле** у провайдера ломает весь каталог.

Значит:
- **Не добавляй новых полей** провайдера/раздачи в `catalog-v2.json`. Дополнительные сведения (доступность из России, сроки) — в существующие строки `freeLimits.note`/`notes`.
- **Новые типы `auth`** (`gigachat`, `cloudflare`) можно: 0.1.5 их пропустит.
- **В новой версии приложения** сделай схему провайдера и раздачи терпимой к неизвестным полям (`.passthrough()` или `.strip()` вместо `.strict()`, при этом валидация известных полей остаётся). Тогда в будущем новые поля не будут ломать старые версии. Тест обязателен.

## 1. Новые провайдеры в реестре (`catalog-bot/src/registry/providers.ts`, `offers.ts`)
**Для каждого:**
- найди на официальном сайте страницу ключа, условия, лимиты и политику данных, как у существующих;
- ещё раз проверь `GET <baseUrl>/models` без ключа;
- раздачи — бесплатные модели **с инструментами** (если список `/models` публичный — из него, по признакам ниже, иначе по документации);
- `trust: "community"` — для всех, кроме крупных компаний (Meituan, SenseTime, Shanghai AI Lab, Tencent, AMD, Vercel, Cloudflare, Сбер, Hetzner, Nous Research, Pollinations).

| Провайдер | Базовый URL | Проверка 27.11 | Бесплатное |
|---|---|---|---|
| **Pollinations (анонимно)** | `https://text.pollinations.ai/openai` | `/models` 200; chat **без ключа** вернул `tool_calls` (модель `openai-fast`) | `auth: none`, `clicksToConnect: 0`. Как Kilo: работает сразу. Узнай лимиты (примерно 1 запрос в 15 с на IP?) и запиши. |
| AIHubMix | `https://aihubmix.com/v1` | 200, 44 бесплатных | `*-free`: coding-glm-5.3-free, coding-glm-5.3-flash-free, xiaomi-mimo-v2.6-pro-free, intern-s2-free, nemotron-3.5-*-free, ling-3.2-flash-free… |
| CrowLLM | `https://crowllm.com/v1` | 200, 31 бесплатная | `:free`: longcat-2.5, k2-horizon-375b-a23b, ernie-5.5-flash-preview, laguna-xs-2.1, deepseek-v4-flash-0731-thinking… |
| BazaarLink | `https://api.bazaarlink.ai/v1` | 200, 13 бесплатных | `:free` и `-free` |
| Nous Portal | `https://inference-api.nousresearch.com/v1` | 200, 3 бесплатных | upstage/solar-mini4:free, tencent/hy4-flash:free, stepfun/step-3.7-flash:free. Узнай, нужна ли карта. |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | 200, 6 бесплатных | ежемесячный бесплатный кредит; nemotron-3.5-lightning-free, beam-free, flint-v1.0… |
| Meituan LongCat | `https://api.longcat.chat/openai/v1` | 401 | дневная квота или кредит на LongCat-2.5 |
| SenseNova Token Plan | `https://token.sensenova.cn/v1` | 401 | бесплатно на время беты; узнай про регистрацию иностранцев |
| Intern InkStone | `https://discovery-api.intern-ai.org.cn/v1` | 401 | intern-s2, agents-a1 бесплатно; узнай про телефон |
| Tencent TokenHub (междунар.) | `https://tokenhub.tencentmaas.com/v1` | 401 | 1M токенов на модель до 2026-12-31 (`expiresAt`) |
| AxForge | `https://api.axforge.ai/v1` | 401 | 3M токенов на 30 дней |
| Hetzner Inference | `https://inference.hetzner.com/api/v1` | 401 | бесплатно до 2026-12-08 (`expiresAt`) |
| InferX | `https://model.inferx.net/endpoints/v1` | 401 | 60 RPM, 2000 RPD |
| AMD Token Lab | `https://api.tokenlab.amd.com/v1` | 401 | программа AMD, 30 дней |
| BeatAPI | `https://api.beatapi.io/v1` | 401 | 2000 запросов в день |
| TokenRouter | `https://api.tokenrouter.com/v1` | 401 | уточни |
| Gonka Broker | `https://proxy.gonkabroker.com/v1` | 200 | около 1M токенов в месяц, SMS |
| Synap | `https://synap402.com/v1` | 200 | 50 запросов в день |
| CheapLLM | `https://cheapllm.shop/v1` | 200 | deepseek-v4.1-flash, по одному запросу |
| LLM7 | `https://api.llm7.io/v1` | `/models` 200, анонимный chat теперь 401 | бесплатный токен на token.llm7.io |

**Не добавлять:**
- Api.Airforce — раздаёт платные модели Mistral бесплатно, похоже на перепродажу;
- Codiv, APInex, Packet — 403 на `/models`, закрыты;
- VseGPT — бесплатны только картинки и поиск;
- Cloud.ru, Yandex, Cerebras, SambaNova, Mistral, GitHub Models, Hugging Face — нет бесплатного уровня или нужна карта;
- OpenCode Zen — условия разрешают бесплатные модели только в клиенте OpenCode;
- OVH — анонимный chat 403;
- AMD Developer Cloud — соединение сбрасывается.

**Признаки бесплатной модели** в публичном `/models` (используй в боте и в `isFreeModel` приложения, если чего-то не хватает): `:free`, `-free`, `free/`, `(free)`, `free: true`, `is_free: true`, `tier: "free"`, нулевые `pricing.prompt`/`completion` или `input`/`output`.

## 2. Доступ из России
По российским источникам (не проверено с российского IP):
- OpenRouter закрыт для России с 27.06.2026 (403);
- Groq — 403 из Москвы;
- Google AI Studio — Россия не в списке регионов;
- NVIDIA не принимает номера +7 для подтверждения.

Допиши в `freeLimits.note` этих провайдеров: «Из России может понадобиться VPN» (для NVIDIA — «Подтверждение по номеру +7 не принимается»). Новых полей не добавляй.

## 3. GigaChat (Сбер) — особый провайдер
Бесплатно для физлиц: 365M токенов на 12 месяцев (Freemium). Проверь актуальность на developers.sber.ru и в changelog — с 1 ноября 2026 новых клиентов могут переводить на cloud.ru.
- **Каталог:** новый тип `auth: { type: "gigachat", tokenUrl, scope }`. Приложение 0.1.5 его пропустит.
- **Ключ.** Пользователь вставляет «Authorization key» (base64 `client_id:secret`) из личного кабинета.
- **Токен.** Роутер получает токен доступа: `POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth`, заголовки `Authorization: Basic <ключ>` и `RqUID: <uuid>`, тело `scope=GIGACHAT_API_PERS`. Кэш до `expires_at` минус 60 с.
- **Сертификат.** Сервер использует «Russian Trusted Root CA». Положи публичный корневой сертификат Минцифры в `app/resources/certs/` (источник: gosuslugi.ru/crt). Запросы к хостам Сбера отправляй через `undici` `Agent` с `connect: { ca: [...] }` — только для этих хостов, глобальное доверие не меняй. Сверь отпечаток сертификата с официальным и запиши его в коде.
- **Формат.** `https://gigachat.devices.sberbank.ru/api/v1/chat/completions` похож на OpenAI, но вызов функций идёт через `functions`/`function_call`.
  - Сделай переходник: OpenAI `tools` → `functions`, ответ `function_call` → `tool_calls`; в потоке SSE тоже. Сообщения `role: "tool"` → формат GigaChat (`role: "function"`).
  - Сверься с документацией GigaChat API.
- **Модели:** GigaChat-2 (Lite), GigaChat-2-Pro, GigaChat-2-Max — актуальные id возьми из `/models` в документации.
- **Ограничение:** 1 параллельный поток на ключ, `freeLimits.concurrent = 1`.
- **Тесты** — на поддельном сервере (токен, кэш, преобразование `tools` туда и обратно, SSE). Живую проверку с ключом не делаем, ключа нет. Перечисли в итоге, что проверено только тестами.

## 4. Cloudflare Workers AI
- **Бесплатно:** 10 000 «нейронов» в день по бесплатному аккаунту.
- **Адрес:** `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`. Нужны токен и Account ID.
- **Каталог:** `auth: { type: "cloudflare" }`, `baseUrl` с `{account_id}`.
- **Приложение:**
  - при подключении спрашивает два поля — «Account ID» и «API-токен»; Account ID хранится в профиле ключа;
  - роутер подставляет его в адрес;
  - в окне подключения подскажи, где их взять: дашборд → Workers AI → «Use REST API».
  - Если для этого нужна правка `src/renderer/connections.tsx` — сделай её минимально, в стиле существующего окна.
- **Раздачи:** бесплатные модели с инструментами по документации (llama-3.3-70b, gpt-oss-120b, glm-4.7-flash, qwen… — проверь id).

## 5. Слежка за раздачами
- **Telegram-каналы** — добавь в список по умолчанию: `freemodelradar` (появление и пропадание бесплатных моделей OpenRouter), `neuro_channel` (новости на русском).
- **Машиночитаемые источники** — новые, раз в сутки:
  - `https://raw.githubusercontent.com/mvalentsev/awesome-free-ai-coding/main/index.json` и `history.jsonl` (с датами окончания; проверь ветку и формат);
  - `https://raw.githubusercontent.com/ClawLabsAI/free-ai-models/main/data/models.json`;
  - `https://raw.githubusercontent.com/original0211/freemodel-radar/main/data.json`;
  - `nejib1/Free-LLM` (найди файл данных);
  - `peter123023/awesome-free-llm-api` (README или файл данных).

  Новые провайдеры и модели из них — в `radar.json.discovered` с живой проверкой, как источник `telegram`.
- **Публичные `/models` провайдеров из реестра** (AIHubMix, CrowLLM, BazaarLink, Nous, Vercel, Pollinations и другие с публичным списком): бот раз в сутки обновляет их бесплатные модели по признакам из п. 1. Новые модели — в раздачи как `new`, пропавшие заканчиваются по обычным правилам.

## 6. Проверки
- **Бот:**
  - `npm test`, `npm run typecheck`, `npm run update -- --dry-run --no-llm`;
  - `catalog.json` по-прежнему с 7 провайдерами;
  - `catalog-v2.json` проходит **строгую схему 0.1.5** — добавь тест, который валидирует файл копией старой схемы.
- **Приложение:**
  - `npm test`, `npm run typecheck`, `npm run build`, `npm run build:cli`;
  - живая проверка: собранный роутер отвечает через Pollinations без ключа (модель с инструментами);
  - тесты GigaChat и Cloudflare на поддельных серверах.
- **Если песочница не даёт писать** — `app/stage-k5.patch` (`git diff --binary` от корня, с новыми файлами).
- **В конце кратко:**
  - какие провайдеры добавлены и сколько раздач;
  - какие отброшены и почему;
  - что с GigaChat и Cloudflare;
  - результаты проверок.
