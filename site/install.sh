#!/bin/sh
# vsemkod — установка из терминала на macOS и Linux.
#
#   Приложение:          curl -fsSL https://vsemkod.ru/install.sh | sh
#   Терминальная версия: curl -fsSL https://vsemkod.ru/install.sh | sh -s -- --cli
#
# Что делает скрипт: берёт последнюю версию с GitHub Releases, проверяет контрольную сумму
# и ставит vsemkod для текущего пользователя. Исходник:
# https://github.com/danielleonov1488-ship-it/vsemkod/blob/main/site/install.sh
set -eu

RELEASES="https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest/download"
MODE=app
[ "${1:-}" = "--cli" ] && MODE=cli

say() { printf '%s\n' "$*"; }
fail() { printf 'vsemkod: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "нужна программа $1 — установите её и запустите команду ещё раз."; }

need curl
need uname
OS=${VSEMKOD_OS:-$(uname -s)}
ARCH=${VSEMKOD_ARCH:-$(uname -m)}
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "архитектура $ARCH не поддерживается." ;;
esac
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t vsemkod)
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() { curl -fsSL --retry 3 "$1" -o "$2" || fail "не удалось скачать $1"; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

sha512_base64() {
  if command -v openssl >/dev/null 2>&1; then openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n'
  elif command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n'
  else shasum -a 512 "$1" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n'; fi
}

# sha512 файла из latest*.yml (формат electron-builder).
manifest_sha() {
  awk -v file="$2" '
    $1 == "-" && $2 == "url:" { current = $3; next }
    $1 == "sha512:" && current == file { print $2; exit }
  ' "$1"
}

if [ "$MODE" = cli ]; then
  case "$OS" in
    Linux) NAME="vsemkod-cli-linux-$ARCH" ;;
    Darwin) NAME="vsemkod-cli-macos-$ARCH" ;;
    *) fail "система $OS не поддерживается." ;;
  esac
  BIN="${VSEMKOD_BIN:-$HOME/.local/bin}"
  mkdir -p "$BIN"
  say "vsemkod: скачиваю терминальную версию…"
  fetch "$RELEASES/vsemkod-cli-checksums.txt" "$TMP/sums"
  EXPECTED=$(grep " \*\{0,1\}$NAME\$" "$TMP/sums" | cut -d' ' -f1 | head -n1)
  [ -n "$EXPECTED" ] || fail "в релизе нет терминальной версии для $OS $ARCH."
  fetch "$RELEASES/$NAME" "$TMP/vsemkod"
  [ "$(sha256 "$TMP/vsemkod")" = "$EXPECTED" ] || fail "файл повреждён при загрузке: контрольная сумма не совпала. Запустите команду ещё раз."
  chmod +x "$TMP/vsemkod"
  if [ "$OS" = Darwin ]; then xattr -c "$TMP/vsemkod" 2>/dev/null || true; codesign -s - -f "$TMP/vsemkod" >/dev/null 2>&1 || true; fi
  mv -f "$TMP/vsemkod" "$BIN/vsemkod"
  say "Готово: $BIN/vsemkod"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "Добавьте $BIN в PATH, например: echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile" ;;
  esac
  say "Перейдите в папку проекта и запустите: vsemkod   (справка: vsemkod help)"
  exit 0
fi

case "$OS" in
  Darwin)
    need unzip
    say "vsemkod: ищу последнюю версию…"
    fetch "$RELEASES/latest-mac.yml" "$TMP/latest.yml"
    FILE="vsemkod-macos-$ARCH.zip"
    EXPECTED=$(manifest_sha "$TMP/latest.yml" "$FILE")
    [ -n "$EXPECTED" ] || fail "в релизе нет сборки для macOS $ARCH."
    say "Скачиваю $FILE (около 250 МБ)…"
    fetch "$RELEASES/$FILE" "$TMP/$FILE"
    [ "$(sha512_base64 "$TMP/$FILE")" = "$EXPECTED" ] || fail "файл повреждён при загрузке: контрольная сумма не совпала. Запустите команду ещё раз."
    [ "${VSEMKOD_DRY_RUN:-}" = 1 ] && { say "Проверка: файл скачан, контрольная сумма совпала. Установка пропущена."; exit 0; }
    unzip -q "$TMP/$FILE" -d "$TMP/app"
    DEST=/Applications
    [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
    if pgrep -x vsemkod >/dev/null 2>&1; then say "Закрываю запущенный vsemkod…"; osascript -e 'quit app "vsemkod"' >/dev/null 2>&1 || true; sleep 2; fi
    rm -rf "$DEST/vsemkod.app"
    mv "$TMP/app/vsemkod.app" "$DEST/vsemkod.app"
    # Файлы, скачанные curl, не помечаются карантином; на всякий случай снимаем метку и подписываем локально.
    xattr -cr "$DEST/vsemkod.app" 2>/dev/null || true
    codesign --force --deep -s - "$DEST/vsemkod.app" >/dev/null 2>&1 || true
    say "Готово: vsemkod установлен в $DEST. Запускаю…"
    open "$DEST/vsemkod.app"
    ;;
  Linux)
    [ "$ARCH" = x64 ] || fail "приложение для Linux пока собирается только под x86_64. Терминальная версия есть и для arm64: добавьте --cli."
    say "vsemkod: ищу последнюю версию…"
    fetch "$RELEASES/latest-linux.yml" "$TMP/latest.yml"
    FILE="vsemkod-linux-x86_64.AppImage"
    EXPECTED=$(manifest_sha "$TMP/latest.yml" "$FILE")
    [ -n "$EXPECTED" ] || fail "в релизе нет сборки для Linux."
    say "Скачиваю $FILE (около 300 МБ)…"
    fetch "$RELEASES/$FILE" "$TMP/$FILE"
    [ "$(sha512_base64 "$TMP/$FILE")" = "$EXPECTED" ] || fail "файл повреждён при загрузке: контрольная сумма не совпала. Запустите команду ещё раз."
    [ "${VSEMKOD_DRY_RUN:-}" = 1 ] && { say "Проверка: файл скачан, контрольная сумма совпала. Установка пропущена."; exit 0; }
    APPS="$HOME/Applications"
    BIN="$HOME/.local/bin"
    mkdir -p "$APPS" "$BIN" "$HOME/.local/share/applications"
    chmod +x "$TMP/$FILE"
    mv -f "$TMP/$FILE" "$APPS/vsemkod.AppImage"
    ln -sf "$APPS/vsemkod.AppImage" "$BIN/vsemkod-app"
    cat > "$HOME/.local/share/applications/vsemkod.desktop" <<EOF
[Desktop Entry]
Name=vsemkod
Comment=Бесплатный ИИ-агент для кода
Exec="$APPS/vsemkod.AppImage" %U
Terminal=false
Type=Application
Categories=Development;
EOF
    say "Готово: $APPS/vsemkod.AppImage (ярлык — в меню приложений)."
    if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
      say "Для AppImage нужна библиотека FUSE 2. Ubuntu/Debian: sudo apt install libfuse2t64 (или libfuse2)."
    fi
    nohup "$APPS/vsemkod.AppImage" >/dev/null 2>&1 &
    ;;
  *) fail "система $OS не поддерживается. Для Windows: irm https://vsemkod.ru/install.ps1 | iex" ;;
esac
