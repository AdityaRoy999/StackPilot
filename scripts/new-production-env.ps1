param(
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][string]$Email
)
$ErrorActionPreference = 'Stop'
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& python (Join-Path $PSScriptRoot 'configure.py') --domain $Domain --email $Email --workspace $rootDir
if ($LASTEXITCODE -ne 0) { throw 'Production configuration failed.' }
