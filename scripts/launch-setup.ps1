$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    $runner = Get-Command python -ErrorAction SilentlyContinue
    if (-not $runner) { $runner = Get-Command python3 -ErrorAction SilentlyContinue }
    if (-not $runner) {
        Write-Host 'Install Python 3.10+ from python.org (enable Add Python to PATH), then reopen this launcher.'
        Start-Process 'https://www.python.org/downloads/windows/'
        exit 1
    }
    & $runner.Source -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.10+ and enable Add Python to PATH, then reopen this launcher.' }
    & $runner.Source (Join-Path $PSScriptRoot 'setup_server.py')
    if ($LASTEXITCODE -ne 0) { throw 'Setup did not start. Review the error above.' }
} catch { Write-Host $_.Exception.Message; exit 1 }
