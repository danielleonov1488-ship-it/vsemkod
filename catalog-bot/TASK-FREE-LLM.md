# Задача: источник Free-LLM, чтобы у каждой модели было больше бесплатных источников

Работаем только в `catalog-bot/`. Не коммить.

## Зачем
Пользователь выбрал DeepSeek V4.1 Flash. Если Numes отказал, приложение должно взять **ту же модель** у другого провайдера.

Для этого каталогу нужно больше бесплатных источников на каждую сильную модель. Проект [nejib1/Free-LLM](https://github.com/nejib1/Free-LLM) (MIT, сайт free-llm.com) ежедневно обновляет машиночитаемый снимок: 87 провайдеров, ~458 моделей. Файл: `https://raw.githubusercontent.com/nejib1/Free-LLM/main/router/catalog.snapshot.json`.

Формат элемента `providers[]`:
- `slug`, `name`, `type`, `base_url`, `openai_base_url`, `openai_compatible`;
- `free_tier`: `truly_free` или `trial_credits`;
- `category`: `permanent`, `renewable` или `trial_credit`;
- `signup_requirement`: `no`, `registration`, `credit_card` или `phone_verification`;
- `verified`, `rate_limit`, `daily_limit`, `key_help_url`;
- `models[]`: `id`, `name`, `kind`, `context_tokens`.

## 1. Источник `src/sources/freeLlm.ts`
- Раз в сутки читаем снимок (правило «раз в 20 часов» и `state.freeLlmCheckedAt`, как у AA). Ошибка сети не валит бота.
- **Фильтр провайдеров:**
  - `free_tier === "truly_free"`;
  - `openai_compatible === true`;
  - `https` в базовом URL;
  - `signup_requirement` — `no` или `registration` (без карты и телефона);
  - `type` — не локальный (Ollama, LM Studio, llama.cpp, KoboldCpp, Jan, GPT4All, Text Generation WebUI, llamafile и т. п.);
  - провайдер не в `config.ts → freeLlmDenylist`. Изначально в списке неофициальные прокси и реселлеры: `api-airforce`, `pollinations` (без ключа и без SLA), `aihubmix`, `bazaarlink`, `token-harbor`, `llmtr`, `zro`. Комментарий в конфиге: почему.
- **Модели:** только `kind === "chat"`. Сопоставляем с моделями каталога через `match.ts` и нормализацию из `artificialAnalysis.ts`:
  - суффиксы дат `-0731`, `-1017` срезаем;
  - `:free` и `-free` срезаем;
  - вендорские префиксы `deepseek-ai/`, `zai-org/`, `nvidia/` срезаем;
  - `p` вместо точки (`glm-5p3`) превращаем в точку.

## 2. Что делаем с совпадениями
- **Провайдер уже есть в нашем реестре** (`src/registry`: kilo, openrouter, numes, modelscope, groq, zai, runcrate и т. д.), а у нас нет предложения для этой модели. Пишем это в лог проверки как «возможное предложение». Предложения сами **не** создаём: их создаёт существующий конвейер по API провайдера.
- **Провайдера нет в реестре.** Записываем в `data/radar.json`, в новый необязательный массив `freeLlm`:
  ```json
  [{ "provider": "OVH AI Endpoints", "slug": "ovh-ai-endpoints", "baseUrl": "...", "signup": "no", "rateLimit": "...", "keyHelpUrl": "...", "models": [{ "id": "DeepSeek-V4.1-Flash-1017", "catalogModelId": "deepseek-v4.1-flash" }], "firstSeen": "ISO" }]
  ```
  Только провайдеры, у которых совпала хотя бы одна модель каталога tier `top` или `good`. Сортировка по числу совпавших top-моделей.
- **Telegram** (тем же механизмом, что Zen-радар), только о **новых** записях: «Free-LLM: DeepSeek V4.1 Flash, GLM 5.3 Flash бесплатно у OVH AI Endpoints (без регистрации) — кандидат в каталог». Первый запуск только запоминает состояние.

## 3. Два провайдера сразу в реестр
У них официальный бесплатный доступ и сильные модели из нашего каталога. Добавь в `src/registry` по образцу существующих (`auth: manual_key`, страница ключа, базовый URL, `freeLimits` с честной заметкой) и проверь их `/models`-эндпоинт в тестах на фикстуре:
- **NVIDIA NIM** — `https://integrate.api.nvidia.com/v1`, ключ на https://build.nvidia.com. Бесплатный ключ разработчика. В снимке: `z-ai/glm-5.3-flash`, `nvidia/nemotron-3-ultra-550b-a55b`, `minimaxai/minimax-m3.1-flash` и др.
- **OVH AI Endpoints** — базовый URL и условия возьми из снимка и официальной страницы. Есть анонимный доступ с лимитом. В снимке: `DeepSeek-V4.1-Flash-1017`, `Qwen3.8-27B`.

Если для провайдера нет надёжного списка моделей через API, не добавляй его. Опиши причину в отчёте.

## 4. Атрибуция
- В `README.md` бота — раздел «Источники»: Free-LLM (MIT), awesome-free-llm-apis (CC0), Artificial Analysis (обязательная ссылка).
- Текст лицензии MIT Free-LLM положи в `catalog-bot/THIRD_PARTY.md`.

## Проверка
- **Юнит-тесты на фикстуре** — урезанный реальный снимок, 6–8 провайдеров, включая отфильтрованные:
  - фильтр;
  - сопоставление имён (`DeepSeek-V4.1-Flash-1017`, `deepseek-v4.1-flash:free`, `accounts/fireworks/models/glm-5p3`, `z-ai/glm-5.3-flash`);
  - запись в radar;
  - отсутствие повторных уведомлений;
  - правило «раз в сутки».
- `npm test`, `npm run typecheck`, `npm run validate`.
- Сухой прогон `update` с реальной сетью, если она доступна. Ключи не нужны.

## Ограничения
- Схему `catalog.json` не меняем: она strict, и приложение v0.1.0 сломается.
- Если запись в существующие файлы запрещена, отдай патч `catalog-bot/free-llm.patch`.
