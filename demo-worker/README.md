# Демо-чат vsemkod.ru

Cloudflare Worker на TypeScript обслуживает `GET /status`, `POST /session` и `POST /chat` по протоколу сайта. Чат отдаёт SSE-события `delta`, `done` и `error`. В `remaining` у сессии и `done` приходит остаток сообщений на текущие сутки UTC. Ошибки `auth` и `bad_request` в `/chat` идут с HTTP 401 и 400, лимит и занятый чат — отдельными SSE-событиями.

Сессия действует 15 минут и привязана к IP и User-Agent. Durable Objects на SQLite ограничивают IP одним активным стримом, шестью сообщениями за скользящие 60 секунд, 30 сообщениями и 10 сессиями за сутки UTC. В полночь UTC сессия сохраняет срок, а IP получает новую суточную соль. Хранилище содержит только счётчики, время, метаданные блокировки стрима и признак закрытой квоты. Текст чата используется в памяти при обработке запроса. Ошибки в логах представлены только кодами. [SQLite-хранилище Cloudflare](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Workers AI использует GPT‑OSS 120B, затем GLM‑4.7‑Flash. Идентификаторы `AI_MODEL`, `AI_BACKUP_MODEL` и название `AI_MODEL_NAME` задаются в `wrangler.jsonc`. На первый байт у каждой модели есть до 20 секунд, на всю цепочку — до 60 секунд. После начала ответа модель закрепляется за запросом. Если исчерпаны квоты всех настроенных источников, демо закрывается до 00:00 UTC. На плане Workers Free Workers AI даёт 10 000 нейронов в сутки. [GPT‑OSS 120B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/), [GLM‑4.7‑Flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/), [квоты Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## Локальная проверка

Из папки `demo-worker/` с Node.js 22.12 или новее:

```sh
npm install --cache ./.npm-cache
npm run typecheck
npm test
npm run smoke
```

`npm run smoke` запускает `wrangler dev --local` с чистыми хранилищами, `DEV=1`, `UPSTREAM_MOCK=1` и одноразовым локальным `SESSION_SECRET`. Воркер отправляет публичный тестовый токен в настоящий Siteverify. Ответ модели фиксированный. Проверка проходит `status`, выдачу сессии, два SSE-фрагмента и `done`, отказ на седьмом сообщении за минуту и отказ для чужого `Origin`. [Локальный сервер Wrangler](https://developers.cloudflare.com/workers/local-development/), [тестовые ключи Turnstile](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)

Для ручной проверки в браузере добавьте в локальный файл `.dev.vars` переменные `DEV=1`, `UPSTREAM_MOCK=1`, `TURNSTILE_SECRET=1x0000000000000000000000000000000AA` и отдельный случайный `SESSION_SECRET`. `npm run dev` запускает `wrangler dev --local`. Используйте сайт на `http://localhost:<порт>` с локальным URL воркера и тестовым sitekey `1x00000000000000000000AA`. Публичный тестовый секрет принимается только для `localhost` в режиме разработки.

## Деплой для владельца

1. Создайте аккаунт Cloudflare на плане Workers Free и выполните `npx wrangler login` из `demo-worker/`.
2. В панели Cloudflare откройте Turnstile и создайте виджет в режиме **Invisible**. Добавьте хосты `vsemkod.ru` и `www.vsemkod.ru`. Скопируйте sitekey и secret key. [Настройка виджета](https://developers.cloudflare.com/turnstile/get-started/widget-management/)
3. Выполните `npx wrangler secret put TURNSTILE_SECRET` и вставьте secret key виджета. При первом запуске Wrangler может предложить создать Worker `vsemkod-demo`.
4. Сгенерируйте секрет командой `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`. Выполните `npx wrangler secret put SESSION_SECRET` и вставьте результат. Храните его в Cloudflare Secrets.
5. Выполните `npx wrangler deploy` и скопируйте выданный URL `https://vsemkod-demo.<поддомен>.workers.dev`.
6. В `site/app.js` укажите этот URL в `DEMO_API`, а публичный sitekey виджета в `TURNSTILE_SITEKEY`. Опубликуйте сайт обычным способом и проверьте ответ в демо-чате на своём домене.

Внешний резерв включается секретом `FALLBACK_API_KEY` через `npx wrangler secret put FALLBACK_API_KEY`. `FALLBACK_BASE_URL` задаёт HTTPS-базу API до `/chat/completions`, а `FALLBACK_MODEL` — модель этого провайдера. В конфигурации указаны параметры Groq для `openai/gpt-oss-120b`. Перед включением внешнего резерва включите у провайдера Zero Data Retention для чата. Квота и условия тарифа внешнего провайдера действуют отдельно. [Режим Zero Data Retention в Groq](https://console.groq.com/docs/your-data)
