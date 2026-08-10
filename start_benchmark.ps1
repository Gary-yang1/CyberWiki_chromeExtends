param(
    [int]$Port = 8765,
    [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if (Test-Path -LiteralPath $bundledPython) {
    $benchmarkPython = $bundledPython
} else {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) {
        throw "Python 3 was not found. Install Python 3.11+ or configure its path in start_benchmark.ps1."
    }
    $benchmarkPython = $pythonCommand.Source
}

Push-Location $projectRoot
try {
    & $benchmarkPython -m benchmark.server --host $HostAddress --port $Port
} finally {
    Pop-Location
}
