param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

& (Join-Path (Split-Path -Parent $PSScriptRoot) 'stackpilot.ps1') @Arguments
exit $LASTEXITCODE
