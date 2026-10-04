param(
    [ValidateSet('base', 'core', 'full', 'monitoring')][string]$Profile = 'core',
    [string]$Directory = (Join-Path $env:USERPROFILE 'stackpilot'),
    [string]$Domain = '',
    [string]$Email = '',
    [switch]$ConfigureOnly
)
$ErrorActionPreference = 'Stop'
$PythonRunner = if ($env:STACKPILOT_SETUP_PYTHON) { $env:STACKPILOT_SETUP_PYTHON } else { 'python' }
foreach ($tool in @('git', 'docker', $PythonRunner)) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Install $tool before running this installer." }
}
& $PythonRunner -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop before running this installer.' }
docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required.' }
if ((Test-Path -LiteralPath 'docker-compose.yml') -and (Test-Path -LiteralPath 'stackpilot-cli')) { $Directory = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $Directory)) {
    git clone https://github.com/AdityaRoy999/StackPilot.git $Directory
    if ($LASTEXITCODE -ne 0) { throw 'Clone failed.' }
}
Push-Location -LiteralPath $Directory
try {
    if (-not (Test-Path -LiteralPath 'docker-compose.yml') -or -not (Test-Path -LiteralPath 'stackpilot-cli')) { throw 'Destination is not a StackPilot checkout.' }
    & $PythonRunner -m venv .stackpilot-venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create CLI environment.' }
    & ./.stackpilot-venv/Scripts/python.exe -m pip install --disable-pip-version-check ./stackpilot-cli
    if ($LASTEXITCODE -ne 0) { throw 'CLI installation failed.' }
    $setupArguments = @('init', '--yes', '--workspace', (Get-Location).Path, '--profile', $Profile)
    if ($Domain) { $setupArguments += @('--domain', $Domain, '--email', $Email) }
    & ./.stackpilot-venv/Scripts/stackpilot.exe @setupArguments
    if ($LASTEXITCODE -ne 0) { throw 'Configuration failed.' }
    if (-not $ConfigureOnly) {
        & ./.stackpilot-venv/Scripts/stackpilot.exe up --profile $Profile --build
        if ($LASTEXITCODE -ne 0) { throw 'StackPilot startup failed.' }
    }
    Write-Host 'Open the dashboard and configure your AI provider in Settings. Existing .env credentials are preserved.'
    Write-Host "CLI installed at $Directory\.stackpilot-venv\Scripts\stackpilot.exe"
} finally { Pop-Location }
