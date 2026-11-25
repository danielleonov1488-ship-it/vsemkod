# Этап C — установщики, релизы, автообновления

Продолжаем `app/` (этапы A и B готовы, см. `app/README.md`). Код не раздувать.

## 1. Сборка установщиков (electron-builder)
- Доработай существующий `app/electron-builder.yml`: appId `ru.vsemkod.app`, productName `vsemkod`, иконка из `../brand/avatar.png` (скопируй в `app/build/icon.png` 1024×1024; electron-builder сам сделает .ico/.icns).
- Цели: **Windows** NSIS x64 (установка в профиль пользователя без прав администратора, ярлык, выбор папки не нужен), **macOS** dmg arm64 + x64 (без подписи — пометить в README), **Linux** AppImage x64.
- **Фиксированные имена файлов без версии**, чтобы сайт мог давать постоянные ссылки `releases/latest/download/...`: `vsemkod-windows-x64.exe`, `vsemkod-macos-arm64.dmg`, `vsemkod-macos-x64.dmg`, `vsemkod-linux-x64.AppImage` (+ файлы `latest*.yml` и `.blockmap` для автообновлений).
- Бинарник движка OpenCode под каждую платформу/архитектуру кладётся в `extraResources` (доработай `scripts/fetch-engine.mjs`: аргументы `--platform --arch`, проверка sha256, кэш). Встроенная копия `resources/catalog.json` обновляется перед сборкой из `../catalog-bot/data/catalog.json`.
- Скрипты: `dist:win`, `dist:mac`, `dist:linux`.

## 2. GitHub Actions: `.github/workflows/release.yml` (в корне репозитория)
- Триггер: push тега `v*` + `workflow_dispatch`.
- Матрица: `windows-latest`, `macos-latest` (собрать arm64 и x64), `ubuntu-latest`; `working-directory: app`; `npm ci` (с кэшами, как в проекте), fetch-engine для нужной платформы, `electron-vite build`, electron-builder `--publish always` с `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, permissions `contents: write`.
- Публикация в GitHub Releases репозитория `danielleonov1488-ship-it/vsemkod` как **черновик (draft)** — владелец сам нажимает Publish. Версия берётся из тега (синхронизируй `app/package.json` с тегом или проверяй совпадение и падай с понятной ошибкой).
- Используй актуальные мажорные версии actions (проверь теги через `git ls-remote --tags`).

## 3. Автообновления (electron-updater)
- Провайдер GitHub (тот же репозиторий). Проверка при запуске и раз в 6 часов, фоновая загрузка, тост «Доступна версия X.Y — Перезапустить» в стиле приложения; кнопка в настройках «Проверить обновления».
- Windows/Linux — полноценное автообновление. macOS без подписи автообновляться не может — там тост «Вышла новая версия — Скачать» со ссылкой на `releases/latest`.
- В dev-режиме обновления отключены.

## 4. Проверка (обязательно)
- `npm test`, `npm run typecheck`, `npm run build` проходят.
- Локально собери Windows-версию (`npm run dist:win`) — убедись, что получился `vsemkod-windows-x64.exe` и папка `win-unpacked`; **запусти `win-unpacked/vsemkod.exe`** на ~30 с и проверь по логам, что встроенный движок и роутер стартовали из упакованных ресурсов (без dev-зависимостей). Установщик НЕ запускай (не ставь программу в систему).
- Проверь YAML workflow (actionlint, если доступен без установки, иначе внимательно вручную).
- Обнови `app/README.md`: как собрать, как выпустить релиз (поставить тег `v0.1.0` → дождаться Actions → опубликовать черновик), про отсутствие подписи (предупреждение Windows SmartScreen / macOS Gatekeeper и как его пройти).

## Ограничения
Только `app/` и `.github/workflows/release.yml`. Не коммить, не пушь, не создавай теги и релизы. Ничего не устанавливай в систему.
