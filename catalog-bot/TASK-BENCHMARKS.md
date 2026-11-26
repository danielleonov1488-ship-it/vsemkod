# Задача: benchmarks.json (Artificial Analysis) и радар списка free-llm-api-resources

Работаем только в `catalog-bot/`. Не коммить.

## 1. benchmarks.json — рейтинг и скорость моделей
Приложение сортирует бесплатные модели по одному общему индексу и показывает скорость. Источник данных — бесплатный Data API Artificial Analysis.

**Запрос.** `GET https://artificialanalysis.ai/api/v2/language/models/free?page=N&page_size=200`, заголовок `x-api-key: $AA_API_KEY`.
- Документация: https://artificialanalysis.ai/data-api/docs и `/reference`.
- Ответ: `{ tier, intelligence_index_version, pagination, data: [...] }`.
- Из каждого элемента `data` читаем:
  - `id`, `slug`, `name`, `model_creator.name`;
  - `evaluations.artificial_analysis_intelligence_index`;
  - `performance_v3.mean_output_tokens_per_second`;
  - `performance_v3.mean_time_to_first_token_seconds`.
- Поле `performance` устарело, его **не** использовать.
- Разбор через zod с `passthrough`. Отсутствие любого поля не считается ошибкой: модель просто без этого значения.

**Лимиты.** На бесплатном тарифе 100 запросов в сутки, а бот запускается каждые 30 минут. Поэтому:
- обновляем, только если `data/benchmarks.json` нет или ему больше 20 часов;
- переменной `AA_API_KEY` нет → шаг пропускаем молча, с одной строкой в логе;
- ошибка сети, 401 или 429 → оставляем старый файл, бот не падает.

**Сопоставление с каталогом.** Нужен `catalog.json → models[].id`.
- Нормализуем имя и slug: нижний регистр, `.`, `_` и пробелы → `-`, без вендорского префикса.
- Используем существующую логику `src/match.ts` и алиасы, если они есть.
- Примеры: «Kimi K3.1 Pro» ↔ `kimi-k3-1-pro`; «DeepSeek V4.1 Flash» ↔ `deepseek-v4-1-flash`; «gpt-oss-120b (high)» ↔ `gpt-oss-120b`.
- Если у одной модели несколько вариантов (reasoning, high, low), берём **максимальный** индекс, а скорость — от того же варианта.
- Модели без пары в каталоге в файл не пишем.

**Формат `data/benchmarks.json`.** Ключи стабильно отсортированы, файл переписываем только при реальных изменениях:
```json
{ "schemaVersion": 1, "generatedAt": "ISO", "source": { "name": "Artificial Analysis", "url": "https://artificialanalysis.ai/", "indexVersion": "<intelligence_index_version>" },
  "models": { "<catalog modelId>": { "index": 62.1, "speed": 180.4, "ttft": 0.52 } } }
```
Числа округляем до 0.1, `ttft` — до 0.01.

**Команда `validate`** проверяет и этот файл, если он есть.

## 2. Радар: новые бесплатные провайдеры в cheahjs/free-llm-api-resources
Это сообщество поддерживает список **официальных** бесплатных LLM API (около 29 тысяч звёзд). Ключи там не раздают, только описывают лимиты. Бот следит за ним, чтобы мы узнавали о новых провайдерах.

**Что делаем.**
- Раз в сутки читаем `https://raw.githubusercontent.com/cheahjs/free-llm-api-resources/main/README.md` (с ETag, если удобно).
- Выделяем заголовки провайдеров: `###`-разделы внутри «Free Providers» и «Providers with trial credits». Сохраняем `{ name, section, url-якорь }`.
- Сравниваем со списком в `data/state.json` (новое поле `freeListProviders`).
- Новые провайдеры:
  - добавляем в `data/radar.json` в новый массив `providers: [{ name, section, firstSeen, source: "free-llm-api-resources" }]`;
  - схему радара расширяем совместимо, поле необязательное;
  - отправляем уведомление в Telegram тем же механизмом, что и Zen-радар: «Новый бесплатный провайдер в списке free-llm-api-resources: {name} ({section})».
- Первый запуск (список пуст) только запоминает текущее состояние и ничего не шлёт.
- Ошибки сети не валят бота.

## 3. Workflow и Pages
- `.github/workflows/catalog.yml` — добавь `AA_API_KEY: ${{ secrets.AA_API_KEY }}` рядом с остальными ключами. Убедись, что новый файл попадает в коммит: шаг уже делает `git add -A -- data/`.
- `.github/workflows/pages.yml`:
  - в триггеры добавь путь `catalog-bot/data/benchmarks.json`;
  - в шаг копирования добавь `benchmarks.json`. Если файла нет, шаг не должен падать (`[ -f … ] && cp …`).
- Эти два файла лежат вне `catalog-bot/`, их разрешено править. Если запись запрещена песочницей, приложи патч.

## Проверка
- **Юнит-тесты:**
  - разбор ответа AA по фикстуре из документации, включая варианты одной модели и пропущенные поля;
  - сопоставление имён;
  - правило 20 часов;
  - пропуск без ключа;
  - парсер README (фикстура: кусок реального README с 3–4 провайдерами);
  - первый запуск без уведомлений.
- `npm test`, `npm run typecheck` (если есть), сухой прогон бота без сети или с моками.
- Обнови `README.md` бота: откуда индекс, атрибуция «Source: Artificial Analysis» обязательна, как задать секрет `AA_API_KEY`.

## Ограничения
- Не трогай `data/catalog.json` вручную. Его схему не меняй: она strict, и приложение v0.1.0 сломается.
- Если Windows не даёт писать в существующие файлы, отдай патч `catalog-bot/benchmarks.patch` (формат git diff от корня репозитория).
