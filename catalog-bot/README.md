# vsemkod · бот-каталог бесплатных моделей

Бот обновляет [каталог бесплатных предложений](data/catalog.json) для десктопного приложения vsemkod. [Лента изменений](data/changes.json) хранит последние 200 событий. [Состояние](data/state.json) хранит хеши страниц, уже обработанные новости, кэш LLM и счётчики проверок.

Приложение может по умолчанию показывать активные предложения для моделей уровня `top`. Известные модели и провайдеры ведутся в курируемом реестре. Бесплатные модели вне реестра получают уровень `new`, когда API OpenRouter, Kilo или Numes подтверждает поддержку tools и контекст от 128 000 токенов. Бот исключает служебные модели, роутеры и модели с явно указанным размером меньше 20 млрд параметров. Остальные неподтверждённые предложения сохраняются в `candidates`. Извлечение из страниц и новостей включается при наличии ключа LLM.

Отдельный [радар OpenCode Zen](data/radar.json) отмечает новые бесплатные модели Zen. Пропавшие модели остаются в файле со статусом `active: false` на 30 дней. Файл не переписывается, когда меняются только отметки времени. Предложения Zen используются только внутри OpenCode и не попадают в каталог приложения.

Бот проверяет список [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis) (CC0, файл `data.json`) раз в сутки. Первая успешная проверка сохраняет список в `data/state.json`. Новые провайдеры после неё появляются в `data/radar.json` и в уведомлении Telegram.

Бот проверяет снимок Free-LLM, когда с предыдущей попытки прошло больше 20 часов. В `data/radar.json` поле `freeLlm` показывает провайдеров с совпадениями по моделям уровня `top` или `good`, по числу совпавших `top`-моделей. Первая успешная проверка заполняет радар без уведомлений. Совпадения у провайдеров из реестра без предложения в каталоге выводятся в журнал проверки.

## Рейтинг и скорость моделей

В `data/benchmarks.json` бот сохраняет Intelligence Index, скорость генерации в токенах в секунду и время до первого токена в секундах из [Data API Artificial Analysis](https://artificialanalysis.ai/data-api/docs). Для каждой модели каталога бот берёт вариант с максимальным индексом и его же замеры скорости. При показе данных обязательна видимая атрибуция «Source: Artificial Analysis» со ссылкой на источник.

Бот запрашивает данные при наличии `AA_API_KEY`. Между попытками проходит больше 20 часов. При ошибке сохраняется предыдущий файл. Если опубликованные значения и версия индекса совпали, файл сохраняет прежний `generatedAt`. GitHub Pages публикует `benchmarks.json` после первого успешного обновления.

## Запуск

Установите Node.js 24. Запускайте команды из папки проекта. Для запуска только с публичными источниками ключи не нужны.

```bash
npm install --cache ./.npm-cache
npm run update -- --no-llm
npm run validate
npm test
```

В PowerShell можно заменить `npm` на `npm.cmd`, если политика запуска блокирует `npm.ps1`. Команды загружают TypeScript через `tsx`. Для ограниченных Windows-процессов есть обработка ошибки libuv при чтении имени пользователя.

- `npm run update` запускает полный цикл. При наличии ключей он также выполняет проверку живости и может отправлять уведомление.
- `npm run update -- --dry-run` выводит сводку и изменения без записи файлов, health-check и Telegram. Если ключ LLM задан, запросы к нему возможны. Добавьте `--no-llm`, чтобы обновить структурированные источники и проверить страницы реестра по хешам без обращения к LLM.
- `npm run update -- --only=openrouter` обновляет один источник. Также доступны `kilo`, `numes`, `opencode-zen`, `watchPages`, `page:runcrate`, `page:zai`, `page:modelscope`, `page:groq`, `page:numes`, `feeds`, `hn`, `reddit`, `github`, `benchmarks`, `free-list` и `free-llm`. Для последних трёх источников действуют обычные интервалы проверки.
- `npm run typecheck` запускает проверку типов.

Пропуски считаются только по успешно обработанным источникам, которые раньше видели соответствующее предложение. По умолчанию после шести пропусков предложение заканчивается, ещё через семь дней оно удаляется из каталога. Известная дата окончания акции срабатывает независимо от счётчика. Если изменились только `generatedAt` и `lastSeen`, файл каталога сохраняет прежние байты и дату записи. При существенном изменении в него попадут свежие отметки наблюдений.

## Курируемые раздачи

[Реестр предложений](src/registry/offers.ts) добавляет в `offers` известные бесплатные маршруты Runcrate, Z.ai, ModelScope и Groq даже при пустом `LLM_API_KEY`. У них `confidence: "page"`, источник `registry:<provider>`, дата ручной проверки `verifiedAt` и дата следующей проверки `reviewBy`. По умолчанию между ними 14 дней. Эти два поля необязательны в схеме каталога v1.

Бот проверяет хеши официальных страниц при каждом полном запуске, в том числе с `--no-llm`. Если срок перепроверки наступил или хеш отличается от проверенного вручную, предложение остаётся в `offers` со статусом `unverified` до актуального подтверждения. При изменении страницы предыдущий разбор и прежний health-check теряют силу для подтверждения. Разбор текущей страницы обновляет поля совпадающего предложения, а свежий успешный health-check подтверждает его доступность. Приложение показывает рабочими предложения со статусом `active`.

После ручной перепроверки тарифов и API ID обновите записи провайдера, `verifiedAt` и проверенный хеш в `src/registry/offers.ts`. Последний хеш прочитанной страницы доступен в `pageChecks` файла `data/state.json`.

В реестре бота также описаны NVIDIA NIM и OVH AI Endpoints. Во время проверки Free-LLM бот читает их публичные `/models` и выводит совпавшие ID в журнал. Для публикации этих провайдеров нужна версия приложения с поддержкой их идентификаторов. [Реестр](src/registry/providers.ts), [NVIDIA API Catalog](https://docs.api.nvidia.com/nim/docs/api-quickstart), [OVHcloud AI Endpoints](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started).

## Источники

- Free-LLM, MIT. Снимок провайдеров и моделей для радара. [Репозиторий](https://github.com/nejib1/Free-LLM), [лицензия](THIRD_PARTY.md).
- awesome-free-llm-apis, CC0. Список поставщиков бесплатных API. [Репозиторий](https://github.com/mnfst/awesome-free-llm-apis).
- Source: Artificial Analysis. При показе индекса и скорости обязательна видимая ссылка на источник. [Artificial Analysis](https://artificialanalysis.ai/).

## Источники, проверенные 24 ноября 2026 года

| Провайдер | API и бесплатные условия |
| --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1`. Публичный `GET /models` вернул бесплатный `nvidia/nemotron-3-ultra-550b-a55b:free`. OAuth PKCE использует `/auth` и `POST /api/v1/auth/keys`. Для `:free` указаны 20 запросов в минуту и 50 в сутки. После покупки $10 кредитов лимит повышается до 1000 в сутки. [Каталог](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth), [лимиты](https://openrouter.ai/docs/api_reference/limits) |
| Kilo Gateway | `https://ai-gateway.kilo.ai/api/v1`. Публичный `GET /models` вернул бесплатные Nemotron 3 Ultra и Nemotron 3.5 Super VL. Бесплатный доступ без входа ограничен 200 запросами в час на IP. [Каталог](https://kilo.ai/docs/gateway/models-and-providers), [лимиты](https://kilo.ai/docs/gateway/usage-and-billing) |
| Numes | `https://api.numes.ai/api/v1`. Документированный `GET /models` без ключа вернул HTTP 401. Бот без ключа использует [публичный JSON страницы каталога](https://numes.ai/api/public-catalogue/models), загружаемый без cookie и авторизации, и читает все страницы. В ответе есть Kimi K3.1 Pro, DeepSeek V4.1 Flash и другие бесплатные `:free` маршруты. Для запросов к моделям нужен ключ и подтверждённый email, а видимый набор зависит от валюты ключа. [Модели и условия](https://numes.ai/docs/models.md), [создание ключа](https://numes.ai/docs/account/api-keys.md) |
| Runcrate | `https://api.runcrate.ai/v1`. Публичный список моделей вернул HTTP 200. Официальная страница перечисляет DeepSeek V4.1 Flash, GLM 5.3, GLM 5.3 Flash, gpt-oss-120b и Qwen3.8 Flash с общей недельной квотой. Нужен GitHub-аккаунт старше 30 дней для доступа без карты. Для Google требуется карта, сверх бесплатной квоты возможна автодоплата. [API](https://www.runcrate.ai/inference), [бесплатная квота](https://www.runcrate.ai/inference/free) |
| Z.ai | `https://api.z.ai/api/paas/v4`. Документация подтверждает бесплатный `glm-4.7-flash`. Эндпоинт без ключа вернул HTTP 401. Числовой лимит параллельных запросов для конкретного аккаунта доступен в кабинете и в этом запуске не проверялся. [Базовый URL](https://docs.z.ai/guides/develop/http/introduction), [цены](https://docs.z.ai/guides/overview/pricing), [лимиты аккаунта](https://z.ai/manage-apikey/rate-limits) |
| ModelScope | `https://api-inference.modelscope.cn/v1`. Публичный `GET /models` вернул `ZhipuAI/GLM-5.2`, `moonshotai/Kimi-K3.1-Pro`, `deepseek-ai/DeepSeek-V4.1-Flash` и `MiniMax/MiniMax-M3`. Вызовы расходуют 0,5–2 Magicubes. Провайдер начисляет 200 Magicubes за ежедневный вход и ещё 50 за привязку Alibaba Cloud при ежедневном входе. Для API нужны подтверждённый email и верифицированный аккаунт Alibaba Cloud. API предназначен для некоммерческого использования. [Лимиты API](https://www.modelscope.cn/docs/model-service/API-Inference/limits.md), [начисление Magicubes](https://www.modelscope.cn/docs/magicube/intro.md) |
| Groq | `https://api.groq.com/openai/v1`. Эндпоинт без ключа вернул HTTP 401. Бесплатный план для gpt-oss-120b, gpt-oss-20b и Qwen3.8-27B указывает 30 запросов в минуту, 1000 в сутки и 8000 токенов в минуту. Подходит для коротких задач. [API](https://console.groq.com/docs/openai), [лимиты](https://console.groq.com/docs/rate-limits) |

Первое обновление с курируемым реестром без ключей добавило в [catalog.json](data/catalog.json) 13 предложений по официальным страницам. Ещё 9 предложений пришли из публичных API OpenRouter, Kilo и Numes. Из новостных источников ранее ответили HN Algolia и README GitHub, а Reddit вернул HTTP 403 с User-Agent бота. Ошибка одного источника не отменяет результаты остальных.

## Переменные окружения

Скопируйте [.env.example](.env.example) в `.env`, если понадобятся необязательные настройки. При одинаковом имени переменные процесса имеют приоритет.

| Переменная | Назначение |
| --- | --- |
| `LLM_API_KEY` | Ключ для разбора изменившихся страниц тарифов и новостей. Без него работают структурированные каталоги, курируемые предложения и проверка хешей страниц. |
| `LLM_BASE_URL`, `LLM_MODEL` | OpenAI-совместимый адрес и ID модели. По умолчанию `https://api.deepseek.com` и `deepseek-flash`, это DeepSeek V4.1 Flash. |
| `LLM_MAX_TOKENS_PER_RUN` | Бюджет разбора за запуск, по умолчанию 150 000 токенов. |
| `AA_API_KEY` | Ключ Data API Artificial Analysis для обновления индекса и скорости моделей. |
| `NUMES_API_KEY` | Ключ для документированного API списка моделей Numes. Если пусто, используется публичный каталог USD. |
| `OFFER_MISSING_RUNS`, `OFFER_ENDED_RETENTION_DAYS` | Число пропусков и дней хранения завершённых офферов. По умолчанию 6 и 7. |
| `HEALTH_INTERVAL_HOURS`, `HEALTH_FAILURE_THRESHOLD` | Интервал между проверками и порог последовательных ошибок. По умолчанию 6 часов и 2 ошибки. |
| `HEALTH_KILO_KEY`, `HEALTH_OPENROUTER_KEY`, `HEALTH_NUMES_KEY`, `HEALTH_RUNCRATE_KEY`, `HEALTH_ZAI_KEY`, `HEALTH_MODELSCOPE_KEY`, `HEALTH_GROQ_KEY` | Необязательные ключи мейнтейнера. Запрос ограничен восемью выходными токенами. Для заявленной поддержки tools бот отправляет ещё один короткий тест. Проверки расходуют квоту соответствующего ключа. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Включают одно сообщение на запуск с новыми подтверждёнными предложениями для `top`, новыми моделями Zen и новыми провайдерами радаров awesome-free-llm-apis и Free-LLM. Нужны обе переменные. |

DeepSeek указывает для `deepseek-flash` цены за миллион токенов. Вне пика вход без кэша стоит $0.15, вход из кэша $0.003, выход $0.60. В пик цены удваиваются. Разбор с 10 000 входных и 2 000 выходных токенов стоит примерно $0.0027 вне пика или $0.0054 в пик. Запуск без LLM стоит $0 по этому тарифу. В конце запуска бот показывает токены и приблизительную стоимость. Для собственного OpenAI-совместимого сервиса цена зависит от его тарифа. [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)

## Круглосуточный запуск

### GitHub Actions

[Workflow](../.github/workflows/catalog.yml) запускается каждые 30 минут и вручную через Actions → Update catalog → Run workflow. Он ставит зависимости из lock-файла, обновляет и валидирует каталог, затем коммитит изменившиеся файлы данных от имени `github-actions[bot]`. Одновременные обновления одной ветки выполняются по очереди.

Когда репозиторий будет готов, включите Actions и разрешите `GITHUB_TOKEN` запись в ветку с каталогом. Ключи и параметры Telegram добавляются в Actions Secrets, настройки без секретов — в Actions Variables. Стандартные GitHub-hosted runners бесплатны для публичного репозитория. В приватном репозитории расходуется лимит минут плана. [Тарификация Actions](https://docs.github.com/en/actions/concepts/billing-and-usage)

Создайте ключ в [кабинете Artificial Analysis](https://artificialanalysis.ai/data-api/docs#getting-started). В GitHub откройте Settings → Secrets and variables → Actions → New repository secret и сохраните ключ под именем `AA_API_KEY`. Для локального запуска задайте его в `.env`.

### Свой VPS через cron

Установите Node.js 24, выполните `npm ci --cache ./.npm-cache` в папке проекта и при необходимости настройте `.env`. Добавьте в `crontab -e` запуск раз в 30 минут. Укажите свои абсолютные пути к проекту и к каталогу Node.js.

```cron
PATH=/usr/local/bin:/usr/bin:/bin
7,37 * * * * cd /opt/catalog-bot && flock -n .npm-cache/update.lock npm run update >> .npm-cache/update.log 2>&1
```

Приложению нужен HTTPS-доступ к `data/catalog.json` и при необходимости к `data/changes.json`. Состояние `data/state.json` и настройки `.env` используются только процессом бота.
