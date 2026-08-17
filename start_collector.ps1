param(
    [int]$Port = 8790,
    [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCommand) {
    $pythonCommand = Get-Command python3 -ErrorAction SilentlyContinue
}
if (-not $pythonCommand) {
    throw "Python 3 was not found. Install Python 3.11+ or configure its path in start_collector.ps1."
}

# Use -HostAddress "0.0.0.0" to reach the mobile UI from a phone on your LAN.
Push-Location $projectRoot
try {
    & $pythonCommand.Source -m collector.server --host $HostAddress --port $Port
} finally {
    Pop-Location
}
