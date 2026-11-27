# Этап J1: vsemkod в терминале — для серверов, виртуалок и CI

Цель: тот же vsemkod (движок OpenCode + наш роутер бесплатных моделей), но **без окна**. Ставится одной командой на Linux, macOS и Windows, работает по SSH, в Docker и в CI. Ориентиры: `claude -p`, `codex exec`, `opencode run`/`serve`/`web`.

Работай только в `src/cli/**`, `scripts/**` (новые файлы), `tests/**`, `package.json` (scripts, devDependencies), `.github/workflows/release.yml` (в корне репозитория), `src/main/engine/config.ts` (новый) и в минимальной правке `src/main/engine/service.ts` (см. п. 2).

**Не трогай:**
- `src/renderer/**`;
- `src/main/index.ts`, `src/main/engine/adapter.ts`, `src/preload/**`;
- `src/shared/api.ts`;
- `resources/**`.

Параллельно с тобой Codex делает этап J2 в этих файлах.

## 1. Что получает пользователь
Команды (все сообщения — по-русски, коротко):
- **`vsemkod`** — в папке проекта открывает интерактивный интерфейс OpenCode (TUI). Модели идут через наш роутер. По умолчанию — «Автовыбор».
- **`vsemkod run "<задача>" [--model <id>] [--json] [--dir <папка>]`** — разовый запуск без интерфейса (`opencode run`). Печатает ответ, код выхода 0 при успехе. С `--json` — события построчно в JSON.
- **`vsemkod serve [--port 4096] [--hostname 127.0.0.1]`** и **`vsemkod web`** — сервер и веб-интерфейс OpenCode для работы с другого устройства.
  - Без `--password` пароль генерируется и печатается один раз (`OPENCODE_SERVER_PASSWORD`).
  - При `--hostname 0.0.0.0` — предупреждение, что доступ открыт в сеть и нужен пароль или SSH-туннель.
- **`vsemkod models [--all]`** — модели: бесплатные (с подключёнными источниками) и свои. Помечает выбранную по умолчанию.
- **`vsemkod connect <провайдер>`** — сохранить ключ (скрытый ввод). Также `vsemkod connect --list` и `vsemkod disconnect <провайдер>`.
  - Провайдеры — из каталога (`numes`, `openrouter`, `groq`…) и `personalProviders` (ключи, кодинг-планы).
  - Для безголового режима ключи читаются и из переменных окружения: `VSEMKOD_<ID>_KEY`, где ID в верхнем регистре, `-` → `_` (например, `VSEMKOD_NUMES_KEY`). Плюс привычные `OPENROUTER_API_KEY`, `GROQ_API_KEY`.
- **`vsemkod doctor`** — проверяет движок, доступ к каталогу, роутер и ключи; печатает, что исправить.
- **`vsemkod update`** — обновляет себя до последнего релиза GitHub с проверкой SHA-256.
- **`vsemkod --version`** и **`vsemkod help`**.

## 2. Как устроено
- **Точка входа** `src/cli/index.ts`, аргументы — без тяжёлых зависимостей (`node:util` `parseArgs`).
- **Повторное использование кода.** Используй существующие `src/main/router/*`, `src/main/connect-service.ts`, `src/main/catalog-service.ts`, `src/shared/*`. От Electron они не зависят, кроме `key-store.ts`.
- **Ключи.** Сделай `src/cli/file-keys.ts` с тем же интерфейсом, что `KeyStore`. Хранение — файл `keys.json` в папке данных CLI, права 0600 на POSIX. На Windows — в `%LOCALAPPDATA%`, этого достаточно.
- **Конфиг движка.** Вынеси сборку конфига OpenCode из `EngineService.config()` в `src/main/engine/config.ts` (`engineConfig(...)`). В `service.ts` замени тело метода вызовом этой функции, больше ничего там не меняй. CLI использует ту же функцию:
  - `provider vsemkod` → адрес роутера;
  - те же отключённые плагины, `share: "disabled"`, `update: "disable"`;
  - в интерактивном режиме доступ к файлам по умолчанию — «спрашивать», как в приложении.
- **Движок.**
  - Бинарник OpenCode той же версии, что в `scripts/fetch-engine.mjs`, скачивается при первом запуске в `<данные>/engine/<версия>/`.
  - SHA-256 проверяется (суммы возьми там же, вынеси их в общий модуль `scripts/engine-manifest.mjs` или `src/cli/engine.ts`). Повторно не скачивается.
  - Переопределение для CI: `VSEMKOD_ENGINE=<путь>`.
- **Запуск TUI.** Роутер стартует на `127.0.0.1` со случайным портом, конфиг передаётся через переменные окружения движка (найди поддерживаемый способ в 2.4.1: `OPENCODE_CONFIG_CONTENT` или временный файл `OPENCODE_CONFIG`). `stdio: "inherit"`. По выходу из TUI роутер закрывается, временные файлы удаляются.
- **Каталог.** Тот же, что у приложения (`CatalogService`: vsemkod.ru, зеркало GitHub, встроенная копия — положи `resources/catalog.json` в сборку CLI при сборке).
- **Папки данных.** `~/.vsemkod` (Linux/macOS), `%LOCALAPPDATA%\vsemkod-cli` (Windows); `VSEMKOD_HOME` переопределяет. С данными приложения не смешивать.

## 3. Сборка и выпуск
- **Сборка:** `npm run build:cli` — `esbuild` в один файл `out/cli/vsemkod.mjs` (Node ≥ 20).
- **Самостоятельные бинарники без Node:** `bun build --compile`, цели `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`.
  - Если Bun не годится (несовместимость с зависимостями), используй Node SEA и напиши почему.
  - Имена: `vsemkod-cli-linux-x64`, `vsemkod-cli-linux-arm64`, `vsemkod-cli-macos-arm64`, `vsemkod-cli-macos-x64`, `vsemkod-cli-windows-x64.exe`, плюс `vsemkod-cli-checksums.txt` (SHA-256).
- **`release.yml`:** добавь job, который собирает эти бинарники (одна машина ubuntu с `oven-sh/setup-bun` может кросс-компилировать) и загружает их в тот же черновик релиза, как сейчас делает `package.mjs` (`gh release upload` с токеном `GITHUB_TOKEN`). Существующие job не ломай.
- **Docker** — только файл `app/cli/Dockerfile` (debian-slim, скачивает бинарник из релиза) и пример в `app/cli/README.md`. Ничего не публикуй.

## 4. Проверки
- **Тесты (vitest):**
  - разбор аргументов;
  - `file-keys` (права, чтение ключей из переменных окружения);
  - `engineConfig` (`service.ts` даёт тот же конфиг, что раньше);
  - выбор пути движка, проверка SHA-256 на поддельном файле.
- **Живая проверка на этой машине (Windows):**
  - `node out/cli/vsemkod.mjs doctor`;
  - `node out/cli/vsemkod.mjs models`;
  - `node out/cli/vsemkod.mjs run "Ответь одним словом: pong"` через Kilo (без ключей) — ответ должен прийти;
  - `vsemkod serve` стартует и отвечает на `/` с паролем, затем останавливается.
- **Бинарник Bun для Windows** собери локально и повтори `run`, если Bun доступен (`npx bun` или установка в `%TEMP%`).
- **Команды:** `npm test`, `npm run typecheck`, `npm run build`, `npm run build:cli`.
- **Не коммить.** Если песочница не даёт писать в существующие файлы, сложи изменения в `app/stage-j1.patch` (`git diff` от корня репозитория, включая новые файлы).
- **В конце кратко:** что сделано, что не получилось, результаты проверок.
