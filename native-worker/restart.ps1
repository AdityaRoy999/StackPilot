param([int]$Port=8077)
$ErrorActionPreference = 'Stop'
$taskWorkerPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'android_worker.py'))
$taskProcesses = Get-CimInstance Win32_Process -Filter "name = 'python.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($taskWorkerPath,[StringComparison]::OrdinalIgnoreCase) -ge 0
}
foreach ($taskProcess in $taskProcesses) {
    Stop-Process -Id $taskProcess.ProcessId -ErrorAction Stop
}
& (Join-Path $PSScriptRoot 'start.ps1') -Port $Port
