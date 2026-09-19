<#
.SYNOPSIS
    StackPilot Universal Interactive Installer for Windows.
    Enables 1-line installation via: irm https://get.stackpilot.dev/install.ps1 | iex

.DESCRIPTION
    Analyzes host hardware (RAM, CPU, Disk), guides the user through profile selection,
    allows fine-grained component picking, generates tailored environment configuration,
    and bootstraps StackPilot with maximum resource efficiency.
#>

param(
    [switch]$DryRun,
    [string]$Profile = "",
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

function Write-Color {
    param(
        [string]$Text,
        [ConsoleColor]$Color = [ConsoleColor]::White,
        [switch]$NoNewline
    )
    if ($NoNewline) {
        Write-Host $Text -ForegroundColor $Color -NoNewline
    } else {
        Write-Host $Text -ForegroundColor $Color
    }
}

function Show-Banner {
    Clear-Host
    Write-Color "=================================================================" "Cyan"
    Write-Color "           [+] StackPilot Universal Low-Spec Installer           " "Yellow"
    Write-Color "       Deploy Any Web App | Autonomous Healing | Zero-Bloat       " "White"
    Write-Color "=================================================================" "Cyan"
    Write-Host ""
}

Show-Banner

# --- 1. System Discovery --------------------------------------------------------
Write-Color "[*] Discovering system hardware..." "Cyan"

$totalRamBytes = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize * 1024
$totalRamGb = [math]::Round($totalRamBytes / 1GB, 1)
$cpuCount = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$freeDiskBytes = (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq "C:\" } | Select-Object -First 1).Free
$freeDiskGb = [math]::Round($freeDiskBytes / 1GB, 1)

Write-Host "  * Total System RAM : " -NoNewline; Write-Color "$totalRamGb GB" "Green"
Write-Host "  * CPU Logical Cores: " -NoNewline; Write-Color "$cpuCount Cores" "Green"
Write-Host "  * Available Disk   : " -NoNewline; Write-Color "$freeDiskGb GB" "Green"
Write-Host ""

# Check Docker Installation
Write-Color "[*] Verifying Docker runtime..." "Cyan"
$dockerInstalled = $false
try {
    $dockerVer = docker --version 2>$null
    if ($dockerVer) {
        $dockerInstalled = $true
        Write-Host "  * Docker Engine    : " -NoNewline; Write-Color "$dockerVer" "Green"
    }
} catch {
    $dockerInstalled = $false
}

# Ensure StackPilot repository exists
if (-not (Test-Path "docker-compose.yml")) {
    Write-Color "[*] StackPilot repository not detected in current directory." "Cyan"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Color "[*] Installing git via winget..." "Cyan"
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    }
    Write-Color "[*] Cloning StackPilot from GitHub..." "Cyan"
    git clone https://github.com/AdityaRoy999/StackPilot.git stackpilot
    Set-Location stackpilot
}

if (-not $dockerInstalled) {
    Write-Color "[-] Docker is not installed or not in PATH." "Yellow"
    $installDocker = Read-Host "Would you like to install Docker Desktop via winget? (Y/n)"
    if ($installDocker -ne "n" -and $installDocker -ne "N") {
        Write-Color "[*] Installing Docker Desktop via winget..." "Cyan"
        winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
        Write-Color "[+] Docker Desktop installed! Please launch Docker Desktop, ensure WSL 2 is enabled, and re-run this script." "Green"
        exit 0
    } else {
        Write-Host "    Please install Docker Desktop for Windows from: https://www.docker.com/products/docker-desktop/"
        Write-Host "    Ensure WSL 2 integration is enabled."
        exit 1
    }
}

# Check if Docker daemon is responsive
try {
    docker info >$null 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Color "[-] Docker daemon is not running. Please start Docker Desktop and retry." "Red"
        exit 1
    }
} catch {
    Write-Color "[-] Docker daemon check failed. Please ensure Docker Desktop is running." "Red"
    exit 1
}

# --- 2. Profile Determination --------------------------------------------------
$recommendedProfile = "standard"
if ($totalRamGb -le 3.5) {
    $recommendedProfile = "lite"
} elseif ($totalRamGb -ge 12.0) {
    $recommendedProfile = "enterprise"
}

Write-Color "[*] Hardware Recommendation: " -NoNewline
if ($recommendedProfile -eq "lite") {
    Write-Color "[LITE MODE] (< 4GB RAM detected: Core Deployer only ~180MB RAM)" "Yellow"
} elseif ($recommendedProfile -eq "standard") {
    Write-Color "[STANDARD MODE] (Core + AI Assistant + Remote Browser ~600MB RAM)" "Green"
} else {
    Write-Color "[ENTERPRISE MODE] (Full Stack + Observability ~1.5GB RAM)" "Magenta"
}
Write-Host ""

$selectedMode = $Profile
if (-not $selectedMode -and -not $NonInteractive) {
    Write-Color "Select an Installation Profile:" "White"
    Write-Host "  [1] Lite Mode       - Deployer + DB + Fast UI (~180MB RAM, for 2GB laptops / VPS)"
    Write-Host "  [2] Standard Mode   - Lite + AI Assistant + Cloud Browser (~600MB RAM)"
    Write-Host "  [3] Enterprise Mode - Full Stack + Local Sandbox + Observability (~1.8GB RAM)"
    Write-Host "  [4] Custom Selection- Choose exactly which components to run"
    Write-Host ""
    $choice = Read-Host "Enter choice [1-4] (Default is recommendation)"
    if ($choice -eq "1") { $selectedMode = "lite" }
    elseif ($choice -eq "2") { $selectedMode = "standard" }
    elseif ($choice -eq "3") { $selectedMode = "enterprise" }
    elseif ($choice -eq "4") { $selectedMode = "custom" }
    else { $selectedMode = $recommendedProfile }
} elseif (-not $selectedMode) {
    $selectedMode = $recommendedProfile
}

# --- 3. Component Selection ----------------------------------------------------
$enableCore = $true
$enableAi = $false
$enableBrowser = $false
$enableSearch = $false
$enableMonitoring = $false
$composeFile = "docker-compose.yml"

switch ($selectedMode) {
    "lite" {
        $enableCore = $true
        $enableAi = $false
        $enableBrowser = $false
        $enableSearch = $false
        $enableMonitoring = $false
        $composeFile = "docker-compose.lite.yml"
    }
    "standard" {
        $enableCore = $true
        $enableAi = $true
        $enableBrowser = $false # Defaults to AWS Remote for lower local load
        $enableSearch = $false
        $enableMonitoring = $false
        $composeFile = "docker-compose.yml"
    }
    "enterprise" {
        $enableCore = $true
        $enableAi = $true
        $enableBrowser = $true
        $enableSearch = $true
        $enableMonitoring = $true
        $composeFile = "docker-compose.yml"
    }
    "custom" {
        Write-Host ""
        Write-Color "Customize your StackPilot components:" "Cyan"
        
        $enableCore = $true
        Write-Host "  [X] Core Web & Deployer Engine + Database (Required)"
        
        $cAi = Read-Host "  Enable AI Chat & Autonomous Healing Assistant? (Y/n)"
        $enableAi = ($cAi -ne "n" -and $cAi -ne "N")
        
        $cBrowser = Read-Host "  Enable Local Browser Testing Sandbox (Chromium/Xvfb)? (y/N - 'N' uses Remote AWS)"
        $enableBrowser = ($cBrowser -eq "y" -or $cBrowser -eq "Y")
        
        $cSearch = Read-Host "  Enable Private Meta-Search Engine (SearXNG)? (y/N)"
        $enableSearch = ($cSearch -eq "y" -or $cSearch -eq "Y")
        
        $cMon = Read-Host "  Enable Observability Stack (Prometheus + Grafana + Loki)? (y/N)"
        $enableMonitoring = ($cMon -eq "y" -or $cMon -eq "Y")

        $composeFile = "docker-compose.yml"
    }
}

# --- 4. Environment Configuration Setup ----------------------------------------
Write-Host ""
Write-Color "[*] Generating environment configuration (.env)..." "Cyan"

$rootPath = (Resolve-Path "$PSScriptRoot\..").Path
$envFile = Join-Path $rootPath ".env"
$envExample = Join-Path $rootPath ".env.example"

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Host "  * Created .env from template."
    } else {
        $defaultEnv = @"
DB_USER=stackpilot_admin
DB_PASSWORD=dokscp_secret_2026
DB_NAME=stackpilot_platform
JWT_SECRET=stackpilot_$(Get-Random)_secure_jwt_token
NEXT_PUBLIC_API_BASE_URL=http://localhost:8090/api/v1
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8090
"@
        Set-Content -Path $envFile -Value $defaultEnv
        Write-Host "  * Created new minimal .env."
    }
} else {
    Write-Host "  * Existing .env file detected, preserving credentials."
}

# --- 5. Compose Command Construction ------------------------------------------
$composeArgs = @("-f", $composeFile)

if ($composeFile -eq "docker-compose.yml") {
    if ($enableAi) { $composeArgs += @("--profile", "ai") }
    if ($enableBrowser) { $composeArgs += @("--profile", "browser") }
    if ($enableSearch) { $composeArgs += @("--profile", "search") }
    if ($enableMonitoring) { $composeArgs += @("--profile", "monitoring") }
}

$composeArgs += @("up", "-d", "--build")

Write-Host ""
Write-Color "=================================================================" "Cyan"
Write-Color "Summary of Selected Stack Configuration:" "Yellow"
Write-Host "  * Profile Mode   : " -NoNewline; Write-Color "$selectedMode" "Green"
Write-Host "  * Compose File   : " -NoNewline; Write-Color "$composeFile" "Green"
Write-Host "  * Core Engine    : " -NoNewline; Write-Color "ENABLED (~75MB RAM)" "Green"
Write-Host "  * AI Assistant   : " -NoNewline; if ($enableAi) { Write-Color "ENABLED" "Green" } else { Write-Color "DISABLED (0 MB)" "DarkGray" }
Write-Host "  * Local Browser  : " -NoNewline; if ($enableBrowser) { Write-Color "ENABLED (Local)" "Green" } else { Write-Color "DISABLED (Uses Remote AWS)" "Yellow" }
Write-Host "  * Search Engine  : " -NoNewline; if ($enableSearch) { Write-Color "ENABLED" "Green" } else { Write-Color "DISABLED (0 MB)" "DarkGray" }
Write-Host "  * Observability  : " -NoNewline; if ($enableMonitoring) { Write-Color "ENABLED" "Green" } else { Write-Color "DISABLED (0 MB)" "DarkGray" }
Write-Color "=================================================================" "Cyan"
Write-Host ""

if ($DryRun) {
    Write-Color "[OK] Dry-run completed. Command that would execute:" "Yellow"
    Write-Host "docker compose $($composeArgs -join ' ')"
    exit 0
}

Write-Color "[*] Launching StackPilot containers..." "Cyan"
Set-Location $rootPath
& docker compose $composeArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Color "=================================================================" "Green"
    Write-Color "           [+] StackPilot is Successfully Running!               " "Green"
    Write-Color "=================================================================" "Green"
    Write-Host ""
    Write-Host "  -> Frontend Dashboard: " -NoNewline; Write-Color "http://localhost:3000" "Cyan"
    Write-Host "  -> Backend API Docs  : " -NoNewline; Write-Color "http://localhost:8090/api/v1/health" "Cyan"
    if ($enableMonitoring) {
        Write-Host "  -> Grafana Metrics   : " -NoNewline; Write-Color "http://localhost:3001" "Cyan"
    }
    Write-Host ""
    Write-Color "To view live logs: docker compose logs -f" "White"
    Write-Color "To stop:           docker compose down" "White"
    Write-Host ""
} else {
    Write-Color "[-] Failed to start some containers. Check output above." "Red"
    exit 1
}
