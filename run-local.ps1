$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Client = Join-Path $Root 'web\client'
$Server = Join-Path $Root 'web\server'

if (-not (Test-Path (Join-Path $Root '.env'))) {
    throw 'Missing .env. Copy .env.example to .env and configure Supabase first.'
}

Write-Host '[MBO] Building React client...' -ForegroundColor Cyan
Push-Location $Client
try {
    if (-not (Test-Path 'node_modules')) { cmd /c npm install }
    cmd /c npm run build
    if ($LASTEXITCODE -ne 0) { throw 'React build failed.' }
} finally {
    Pop-Location
}

Write-Host '[MBO] Starting Node backend at http://127.0.0.1:8090' -ForegroundColor Green
Write-Host '[MBO] Press Ctrl+C to stop.' -ForegroundColor DarkGray
Push-Location $Server
try {
    if (-not (Test-Path 'node_modules')) { cmd /c npm install }
    cmd /c npm start
} finally {
    Pop-Location
}
