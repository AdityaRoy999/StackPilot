param([int]$Port=8077)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskEnvFile = Join-Path $taskRoot '.env'
if (-not $env:STACKPILOT_AI_SERVICE_TOKEN -and (Test-Path -LiteralPath $taskEnvFile)) {
    foreach ($taskLine in Get-Content -LiteralPath $taskEnvFile) {
        if ($taskLine -match '^STACKPILOT_AI_SERVICE_TOKEN=(.+)$') {
            $env:STACKPILOT_AI_SERVICE_TOKEN = $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
}
if (-not $env:STACKPILOT_AI_SERVICE_TOKEN) { throw 'Configure STACKPILOT_AI_SERVICE_TOKEN first.' }
$taskAvd = python (Join-Path $PSScriptRoot 'setup_android.py') | ConvertFrom-Json
$env:ANDROID_HOME = $taskAvd.sdk
$env:ANDROID_AVD_HOME = $taskAvd.avd_home
$env:STACKPILOT_NATIVE_PORT = "$Port"
$taskAdb = Join-Path $taskAvd.sdk 'platform-tools\adb.exe'
$taskDevices = & $taskAdb devices
if ($taskDevices -notmatch 'emulator-5580\s+device') {
    $taskEmulator = Join-Path $taskAvd.sdk 'emulator\emulator.exe'
    Start-Process -FilePath $taskEmulator -ArgumentList '-avd stackpilot-local -no-window -no-audio -no-snapshot -gpu swiftshader -port 5580 -no-boot-anim' -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskAvd.avd_home 'emulator.log') -RedirectStandardError (Join-Path $taskAvd.avd_home 'emulator-errors.log') | Out-Null
}
$taskWorker = Join-Path $PSScriptRoot 'android_worker.py'
$taskLog = Join-Path $taskAvd.avd_home 'worker.log'
$taskErrorLog = Join-Path $taskAvd.avd_home 'worker-errors.log'
$taskPython = (Get-Command python).Source
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList ('"' + $taskWorker + '"') -WindowStyle Hidden -RedirectStandardOutput $taskLog -RedirectStandardError $taskErrorLog -PassThru
Write-Output "Android worker starting at http://localhost:$Port (PID $($taskProcess.Id))."
