# vsemkod installer bootstrap (ASCII on purpose).
#
#   App:      irm https://vsemkod.ru/install.ps1 | iex
#   Terminal: $env:VSEMKOD_CLI=1; irm https://vsemkod.ru/install.ps1 | iex
#
# Windows PowerShell 5.1 may decode downloaded scripts as Latin-1, which breaks Russian text.
# This bootstrap downloads the real installer as raw bytes and runs it as UTF-8.
# Source: https://github.com/danielleonov1488-ship-it/vsemkod/blob/main/site/install-windows.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$response = Invoke-WebRequest -Uri 'https://vsemkod.ru/install-windows.ps1' -UseBasicParsing
$bytes = $response.RawContentStream.ToArray()
$script = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
Invoke-Expression $script
