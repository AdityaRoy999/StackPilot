param([string]$Chrome, [switch]$ShowWindow)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskVenv = Join-Path $PSScriptRoot '.venv'
if (-not (Test-Path -LiteralPath (Join-Path $taskVenv 'Scripts/python.exe'))) {
    python -m venv $taskVenv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the browser worker environment' }
}
$taskPython = Join-Path $taskVenv 'Scripts/python.exe'
& $taskPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install browser worker dependencies' }
$taskEnvFile = Join-Path $taskRoot '.env'
$taskEnvText = if (Test-Path -LiteralPath $taskEnvFile) { [IO.File]::ReadAllText($taskEnvFile) } else { '' }
$taskTokenMatch = [regex]::Match($taskEnvText, '(?m)^HOST_BROWSER_TOKEN=([A-Za-z0-9_-]{32,})\s*$')
if ($taskTokenMatch.Success) {
    $taskToken = $taskTokenMatch.Groups[1].Value
} else {
    $taskRandomBytes = New-Object byte[] 32
    $taskRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
    $taskRandom.GetBytes($taskRandomBytes)
    $taskRandom.Dispose()
    $taskToken = [Convert]::ToBase64String($taskRandomBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    $taskEnvText = [regex]::Replace($taskEnvText, '(?m)^HOST_BROWSER_TOKEN=.*\r?\n?', '')
    $taskEnvText += "`nHOST_BROWSER_TOKEN=$taskToken`n"
}
if ($taskEnvText -notmatch '(?m)^HOST_BROWSER_CDP_URL=.+$') {
    $taskEnvText = [regex]::Replace($taskEnvText, '(?m)^HOST_BROWSER_CDP_URL=.*\r?\n?', '')
    $taskEnvText += "HOST_BROWSER_CDP_URL=http://host.docker.internal:9225`n"
}
[IO.File]::WriteAllText($taskEnvFile, $taskEnvText, [Text.UTF8Encoding]::new($false))
$env:HOST_BROWSER_TOKEN = $taskToken
$taskArgs = @((Join-Path $PSScriptRoot 'host.py'), '--bind', '0.0.0.0')
if ($Chrome) { $taskArgs += @('--chrome', $Chrome) }
if ($ShowWindow) { $taskArgs += '--show-window' }
Write-Host 'Starting the dedicated browser worker. Keep this process running, recreate ai-service once, and choose Host Chrome in Agent Settings for the current chat.'
& $taskPython @taskArgs
