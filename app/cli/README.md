# vsemkod CLI

## Установка

Linux и macOS. Команда появится в `~/.local/bin`. Если этой папки нет в `PATH`, установщик подскажет, как её добавить.

```sh
curl -fsSL https://vsemkod.ru/install.sh | sh -s -- --cli
```

Windows x64, PowerShell. Установщик добавляет `%LOCALAPPDATA%\vsemkod-cli\bin` в `PATH` пользователя.

```powershell
$env:VSEMKOD_CLI=1; irm https://vsemkod.ru/install.ps1 | iex
```

Установщики сверяют SHA-256 бинарника из последнего выпуска GitHub. Исходники установщиков лежат в `site/install.sh` и `site/install-windows.ps1`. OpenCode 2.4.1 скачивается при первом запуске.

## Использование

```sh
vsemkod
vsemkod run "Ответь одним словом: pong" --dir .
vsemkod run "Объясни структуру проекта" --model auto --json
vsemkod models --all
vsemkod connect --list
vsemkod connect openrouter
vsemkod disconnect openrouter
vsemkod doctor
vsemkod update
```

`run --json` выводит события OpenCode по одному объекту JSON на строку. `--model` принимает идентификатор из `vsemkod models`. По умолчанию работает «Автовыбор».

Для CI задайте `VSEMKOD_<ID>_KEY`, заменив дефисы в ID подчёркиваниями. Например, `VSEMKOD_NUMES_KEY` или `VSEMKOD_KIMI_CODE_KEY`. Также доступны `OPENROUTER_API_KEY` и `GROQ_API_KEY`. Ключи из окружения имеют приоритет над сохранёнными.

CLI хранит каталог, историю OpenCode и подключения в `~/.vsemkod` или `%LOCALAPPDATA%\vsemkod-cli`. Для другого профиля задайте `VSEMKOD_HOME`. Файл `keys.json` содержит ключи в открытом виде с правами `0600` на Linux и macOS. Для своего совместимого сервера используйте `vsemkod connect custom-api --url https://example.com/v1`.

`vsemkod serve` и `vsemkod web` на OpenCode 2.4.1 поднимают один сервер со встроенным веб-интерфейсом. По умолчанию адрес `127.0.0.1:4096`. Имя пользователя — `opencode`. Укажите `OPENCODE_SERVER_PASSWORD` или `--password`, иначе vsemkod напечатает автоматически созданный пароль. Для доступа по SSH используйте `ssh -L 4096:127.0.0.1:4096 <сервер>` и откройте `http://127.0.0.1:4096`.

## Сборка и Docker

Выполните из `app/`. Сборка `vsemkod.mjs` требует Node.js 20+. Готовый бинарник обновляется командой `vsemkod update`. Для CI можно передать путь к уже установленному движку через `VSEMKOD_ENGINE`.

```sh
npm ci --ignore-scripts
npm run build:cli
node out/cli/vsemkod.mjs doctor
npm run build:cli:binaries
```

Для `build:cli:binaries` нужен Bun. Передайте `-- bun-windows-x64`, чтобы собрать только Windows x64. Бинарники и список SHA-256 появятся в `out/cli`.

Пример сборки своего образа из выпущенного бинарника и разового запуска с проектом из текущей папки.

```sh
docker build -t vsemkod-cli -f cli/Dockerfile .
docker run --rm -v "$PWD:/work" -v vsemkod-data:/home/vsemkod/.vsemkod \
  vsemkod-cli run "Ответь одним словом: pong"
```

Чтобы выбрать конкретный релиз, передайте при сборке `--build-arg VSEMKOD_RELEASE=v<версия>`.
