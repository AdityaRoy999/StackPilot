param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

$cliExecutable = Join-Path $PSScriptRoot '.stackpilot-venv\Scripts\stackpilot.exe'
if (Test-Path -LiteralPath $cliExecutable) {
    & $cliExecutable @Arguments
    exit $LASTEXITCODE
}

# Also support a checkout with dependencies installed in the active Python.
$previousPythonPath = $env:PYTHONPATH
try {
    $cliSource = Join-Path $PSScriptRoot 'stackpilot-cli'
    $env:PYTHONPATH = $cliSource
    if ($previousPythonPath) { $env:PYTHONPATH += [IO.Path]::PathSeparator + $previousPythonPath }
    python -m stackpilot_cli.cli @Arguments
    $cliExitCode = $LASTEXITCODE
} finally { $env:PYTHONPATH = $previousPythonPath }
exit $cliExitCode
