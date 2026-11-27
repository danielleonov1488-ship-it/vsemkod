# Этап J2: готовые коннекторы (MCP) и навыки в один клик

Цель: как в Claude Code и Cline — зашёл в настройки, нажал «Подключить», и у агента появился новый инструмент (документация библиотек, браузер, GitHub, Supabase, Vercel…) или готовый навык. Новичку не нужно знать, что такое MCP.

Эта задача — только внутренняя часть: `src/main/**` (кроме `src/main/engine/service.ts` и `src/main/engine/config.ts`), `src/preload/**`, `resources/**`, `tests/**`, `THIRD_PARTY_NOTICES.md`, `electron-builder.yml`.

**Не трогай:**
- `src/renderer/**` — интерфейс делает Claude;
- `src/main/engine/service.ts` и `src/cli/**` — там параллельно работает другой этап;
- `src/shared/api.ts` — типы уже добавлены. Если очень нужно поле — допиши и объясни.

## Уже сделано Claude
В `src/shared/api.ts`:
- типы `Connector`, `ConnectorState`, `SkillEntry`;
- методы `DesktopApi`: `connectors`, `installConnector`, `authorizeConnector`, `removeConnector`, `skillCatalog`, `installSkill`, `removeSkill`.

## 1. Каталог коннекторов `resources/connectors.json`
- **Формат:** массив `Connector` (см. тип). Подключи файл через `extraResources`.
- **Описания** — по-русски, одно предложение, без жаргона («Свежая документация библиотек, чтобы агент не выдумывал API»).
- **Версии.** Для локальных — точная версия пакета, без `@latest`: найди текущую в npm и проверь, что пакет существует.
- **Удалённые адреса** проверь `curl`-ом. Должен прийти ответ MCP-сервера или 401/405, не 404 и не DNS-ошибка.

Состав:

| id | Что | Транспорт и авторизация |
|---|---|---|
| `context7` | Документация библиотек | remote `https://mcp.context7.com/mcp`, auth none, popular |
| `deepwiki` | Вопросы по любому публичному репозиторию GitHub | remote `https://mcp.deepwiki.com/mcp`, none, popular |
| `exa` | Поиск по интернету и коду | remote `https://mcp.exa.ai/mcp`, none |
| `github` | Репозитории, задачи, pull request’ы | remote `https://api.githubcopilot.com/mcp/`, auth key (Personal Access Token в заголовке `Authorization: Bearer`), keyPageUrl `https://github.com/settings/personal-access-tokens/new`, popular |
| `supabase` | База данных и авторизация Supabase | remote `https://mcp.supabase.com/mcp?read_only=true`, oauth, readOnly |
| `vercel` | Деплой и логи Vercel | remote `https://mcp.vercel.com`, oauth |
| `cloudflare-docs` | Документация Cloudflare | remote `https://docs.mcp.cloudflare.com/mcp`, none |
| `sentry` | Ошибки из Sentry | remote `https://mcp.sentry.dev/mcp`, oauth |
| `linear` | Задачи Linear | remote `https://mcp.linear.app/mcp`, oauth |
| `notion` | Документы Notion | remote `https://mcp.notion.com/mcp`, oauth |
| `neon` | Postgres Neon | remote `https://mcp.neon.tech/mcp?readonly=true`, oauth, readOnly |
| `stripe` | Платежи Stripe (тестовый режим) | remote `https://mcp.stripe.com`, oauth |
| `figma` | Макеты Figma в код | remote `https://mcp.figma.com/mcp`, oauth (проверь, что работает) |
| `playwright` | Управление браузером: открыть сайт, нажать, проверить | local `npx -y @playwright/mcp@<версия>`, requires node, popular |
| `chrome-devtools` | Отладка страницы в Chrome: консоль, сеть, скорость | local `npx -y chrome-devtools-mcp@<версия>`, requires node + chrome |
| `shadcn` | Готовые UI-компоненты shadcn/ui | local `npx -y shadcn@<версия> mcp`, requires node |
| `memory` | Долгая память агента о проекте | local `npx -y @modelcontextprotocol/server-memory@<версия>`, requires node |

Записи, которые не прошли проверку, выброси и перечисли в итоге.

## 2. Работа коннекторов (main)
- **`connectors:list(directory)`** — каталог + состояние:
  - `installed`: есть в нашем `mcp.json` под тем же именем; `status`/`error` из `mcpList`;
  - `missing`: `node`, если `node --version` не запускается из PATH (кэш на 1 минуту); `chrome` — нет Chrome в стандартных путях.
- **`connectors:install(directory, id, { key? })`** — записывает конфиг MCP через существующую очередь `mcp:change`:
  - remote → `{ type: "remote", url, headers }`;
  - local → `{ type: "local", command: [...] }`.

  Ключ для `auth: "key"` обязателен. Он хранится в зашифрованном `KeyStore` под отдельным id, например `mcp:github`, а не в `mcp.json`. В конфиг движка попадает при сборке `settings().mcp`. Если для этого нужна правка `service.ts`, сделай её через функцию в `index.ts`, которая подставляет заголовки перед передачей.

  Без `missing`-зависимостей устанавливать нельзя — понятная ошибка «Нужен Node.js: nodejs.org». После записи — проверка (`mcpCheck`). Вернуть новый список.
- **`connectors:authorize(directory, id)`** — OAuth для удалённых серверов.
  - Найди, как движок 2.4.1 делает вход в MCP по OAuth: `mcp.connect` в `@opencode/client`, статус `needs_auth`, команда `opencode mcp auth`. Используй это.
  - Браузер открывай через `shell.openExternal` только для `https:` адресов.
  - Промис завершается, когда статус стал `connected`, вход отменён или прошло 5 минут.
  - Проверь до шага «браузер открыт» хотя бы на Linear или Supabase, потом отмени.
  - Если движок не умеет OAuth для этого сервера, напиши в итоге, какие серверы работают.
- **`connectors:remove(directory, id)`** — удалить из `mcp.json`, стереть ключ, выйти из OAuth, если движок это умеет.
- Добавь всё в `preload` под именами из `DesktopApi`.

## 3. Каталог навыков `resources/skills-catalog/`
- **Состав.** Скопируй в папку проекта навыки, лицензия которых разрешает распространение. Проверь файл лицензии **каждого** навыка, а не README. Каждый — со своим `LICENSE`, сохраняя файлы навыка.
  - `anthropics/skills`: `frontend-design`, `webapp-testing`, `pdf`, `docx`, `xlsx`, `pptx`, `mcp-builder`, `skill-creator` — только те, где `LICENSE.txt` = Apache-2.0 или MIT.
  - `obra/superpowers` (MIT): `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `brainstorming`, `writing-plans`.
  - `vercel-labs/agent-skills` (MIT): `web-design-guidelines`, `react-best-practices`.
- **`index.json`:** `id`, `name` по-русски («Дизайн интерфейсов»), `description` по-русски одним предложением, `category`, `source` (URL репозитория и путь), `license`.
- **Сборка.** Подключи папку через `extraResources`. Допиши `THIRD_PARTY_NOTICES.md`.
- **IPC:**
  - `skills:catalog` — список + `installed`, если в папке навыков движка (`engine.configDirectory/skills/<id>`) есть такая папка с `SKILL.md`;
  - `skills:install(id)` — копирует папку, не перезаписывая изменённый пользователем навык без подтверждения, иначе ошибка;
  - `skills:remove(id)` — удаляет только установленное из каталога.
- **Проверь, что навыки реально доходят до агента.** В конфиге движка есть плагин `-opencode.skill` (отключён) и поле `skills`. Выясни, как приложение сейчас подключает навыки (настройки «Навыки», `TurnOptions.skill`). Если установленный навык не виден агенту, напиши, что нужно изменить, но `service.ts` не трогай.

## 4. Проверки
- **Тесты (vitest):**
  - схема `connectors.json` (уникальные id, `https`, версии без `latest`);
  - установка remote/local/key в поддельный `mcp.json`;
  - ключ не попадает в `mcp.json`;
  - навыки: install/remove/уже изменён.
- **Живая проверка:** собранное приложение через `playwright-core` `_electron` с временным `VSEMKOD_DEV_DATA`; вызовы через `window.vsemkod` в консоли страницы:
  - установить `context7` → статус `connected`, у агента появились его инструменты;
  - установить навык `frontend-design` → файл на месте.
- **Команды:** `npm test`, `npm run typecheck`, `npm run build`.
- **Не коммить.** Если песочница не даёт писать в существующие файлы, сложи изменения в `app/stage-j2.patch` (`git diff` от корня репозитория, включая новые файлы и бинарные навыки, если есть: `git diff --binary`).
- **В конце кратко:** что сделано, какие коннекторы и навыки прошли проверку, что не получилось.
