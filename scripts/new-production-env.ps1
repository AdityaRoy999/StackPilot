param(
    [Parameter(Mandatory = $true)]
    [string]$Domain,

    [Parameter(Mandatory = $true)]
    [string]$Email
)

function New-Secret {
    $bytes = New-Object byte[] 48
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToBase64String($bytes)
}

$templatePath = Join-Path $PSScriptRoot "..\production.env.template"
$envPath = Join-Path $PSScriptRoot "..\.env"

if (Test-Path $envPath) {
    throw ".env already exists. Move it first if you want to generate a fresh production file."
}

$content = Get-Content $templatePath -Raw
$content = $content.Replace("StackPilot.example.com", $Domain)
$content = $content.Replace("admin@example.com", $Email)
$content = $content.Replace("replace-with-a-long-random-database-password", (New-Secret))
$content = $content.Replace("replace-with-a-long-random-webhook-secret", (New-Secret))
$content = $content.Replace("replace-with-a-long-random-grafana-password", (New-Secret))
$content = $content.Replace("replace-with-at-least-48-random-characters", (New-Secret))
$firstSecret = New-Secret
$secondSecret = New-Secret
$content = $content -replace "JWT_SECRET=.*", "JWT_SECRET=$firstSecret"
$content = $content -replace "TOKEN_ENCRYPTION_KEY=.*", "TOKEN_ENCRYPTION_KEY=$secondSecret"

Set-Content -Path $envPath -Value $content -NoNewline
Write-Host "Created .env for $Domain"
