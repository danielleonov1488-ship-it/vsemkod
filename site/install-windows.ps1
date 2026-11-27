# vsemkod — установка из PowerShell, без браузера и без окна SmartScreen.
#
#   Запускается из install.ps1 (он ASCII, чтобы PowerShell 5.1 не испортил кириллицу):
#   Приложение:          irm https://vsemkod.ru/install.ps1 | iex
#   Терминальная версия: $env:VSEMKOD_CLI=1; irm https://vsemkod.ru/install.ps1 | iex
#
# Что делает скрипт: берёт последнюю версию с GitHub Releases, проверяет контрольную сумму,
# ставит vsemkod для текущего пользователя (без прав администратора) и запускает его.
# Исходник: https://github.com/danielleonov1488-ship-it/vsemkod/blob/main/site/install-windows.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Releases = 'https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest/download'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Get-Text([string]$Url) {
  # GitHub отдаёт файлы релиза как application/octet-stream: читаем байты и сами декодируем UTF-8.
  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing
  [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
}

function Save-File([string]$Url, [string]$Path) {
  # Invoke-WebRequest не ставит метку «из интернета», поэтому SmartScreen не вмешивается.
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
  Unblock-File -Path $Path -ErrorAction SilentlyContinue
}

function Get-Hash([string]$Path, [string]$Algorithm) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $hasher = [Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    return $hasher.ComputeHash($stream)
  } finally { $stream.Dispose() }
}

function Test-SmartAppControl {
  try {
    $state = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState' -ErrorAction Stop).VerifiedAndReputablePolicyState
    return $state -eq 1
  } catch { return $false }
}

if (-not [Environment]::Is64BitOperatingSystem) { throw 'vsemkod работает только на 64-битной Windows.' }

if ($env:VSEMKOD_CLI -eq '1') {
  # Терминальная версия: один файл vsemkod.exe в %LOCALAPPDATA%\vsemkod-cli\bin и в PATH пользователя.
  $name = 'vsemkod-cli-windows-x64.exe'
  $bin = Join-Path $env:LOCALAPPDATA 'vsemkod-cli\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $target = Join-Path $bin 'vsemkod.exe'
  $download = "$target.download"
  Say 'vsemkod: скачиваю терминальную версию…' Cyan
  $sums = Get-Text "$Releases/vsemkod-cli-checksums.txt"
  $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1)
  if (-not $line) { throw 'В релизе нет терминальной версии для Windows. Попробуйте позже.' }
  $expected = ($line -split '\s+')[0].ToLower()
  Save-File "$Releases/$name" $download
  $actual = (-join ((Get-Hash $download 'SHA256') | ForEach-Object { $_.ToString('x2') }))
  if ($actual -ne $expected) { Remove-Item $download -Force; throw 'Файл повреждён при загрузке: контрольная сумма не совпала. Запустите команду ещё раз.' }
  Move-Item -Force $download $target
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $bin)) {
    [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $bin), 'User')
    $env:Path = "$env:Path;$bin"
    Say "Добавил $bin в PATH. Откройте новое окно терминала, чтобы команда vsemkod появилась везде." DarkGray
  }
  Say "Готово. Перейдите в папку проекта и запустите: vsemkod" Green
  Say 'Справка: vsemkod help' DarkGray
  return
}

Say 'vsemkod: ищу последнюю версию…' Cyan
$manifest = Get-Text "$Releases/latest.yml"
$version = [regex]::Match($manifest, '(?m)^version:\s*(\S+)').Groups[1].Value
$file = [regex]::Match($manifest, '(?m)^path:\s*(\S+)').Groups[1].Value
$expected = [regex]::Match($manifest, '(?m)^sha512:\s*(\S+)').Groups[1].Value
if (-not $version -or -not $file -or -not $expected) { throw 'Не удалось прочитать описание релиза. Попробуйте позже.' }

$installer = Join-Path $env:TEMP "vsemkod-setup-$version.exe"
Say "Скачиваю vsemkod $version (около 250 МБ)…" Cyan
Save-File "$Releases/$file" $installer
$actual = [Convert]::ToBase64String((Get-Hash $installer 'SHA512'))
if ($actual -ne $expected) { Remove-Item $installer -Force; throw 'Файл повреждён при загрузке: контрольная сумма не совпала. Запустите команду ещё раз.' }
if ($env:VSEMKOD_DRY_RUN -eq '1') { Say "Проверка: vsemkod $version скачан, контрольная сумма совпала. Установка пропущена." Green; Remove-Item $installer -Force; return }

$running = Get-Process -Name 'vsemkod' -ErrorAction SilentlyContinue
if ($running) {
  Say 'vsemkod сейчас запущен. Для установки его нужно закрыть: незаконченный ответ агента прервётся.' Yellow
  $answer = Read-Host 'Закрыть vsemkod и продолжить? [Д/н]'
  if ($answer -match '^(н|n)') { Say 'Отменено.'; return }
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

Say 'Устанавливаю…' Cyan
try {
  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
} catch {
  if (Test-SmartAppControl) {
    Say 'Установку остановил Smart App Control: он блокирует программы без платной подписи даже из терминала.' Yellow
    Say 'Выключить: Параметры → Конфиденциальность и защита → Безопасность Windows → Управление приложениями и браузером → Smart App Control.' Yellow
  }
  throw
}
Remove-Item $installer -Force -ErrorAction SilentlyContinue
if ($process.ExitCode -ne 0) { throw "Установщик завершился с кодом $($process.ExitCode)." }

$exe = Join-Path $env:LOCALAPPDATA 'Programs\vsemkod\vsemkod.exe'
if (-not (Test-Path $exe)) { throw 'Установка не нашла vsemkod.exe. Попробуйте скачать установщик с vsemkod.ru.' }
Say "Готово: vsemkod $version установлен. Запускаю…" Green
Start-Process -FilePath $exe
