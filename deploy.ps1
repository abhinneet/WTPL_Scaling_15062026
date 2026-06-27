# MITRA Production Deployment Script (Cloud Build - no local Docker needed)
# Usage: powershell -ExecutionPolicy Bypass -File .\deploy.ps1

$Project = "mitra-production-core"
$Region  = "asia-south1"
$Service = "mitra-api"
$Image   = "asia-south1-docker.pkg.dev/$Project/mitra/mitra-api:latest"

$ErrorActionPreference = "Stop"

Write-Host "=== MITRA Deployment Starting ===" -ForegroundColor Cyan
Write-Host "  Using Cloud Build (no local Docker required)" -ForegroundColor Cyan
Write-Host ""

# -- 1. Check required files --------------------------------------------------
Write-Host "Checking required files..." -ForegroundColor Cyan

$files = @(
    "server.js",
    "Dockerfile",
    "package.json",
    "routes\analytics_export.js",
    "scripts\build_export.py",
    "templates\MITRA_Analytics_v7_Complete.xlsx"
)

$ok = $true
foreach ($f in $files) {
    if (Test-Path $f) {
        Write-Host "  OK: $f" -ForegroundColor Green
    } else {
        Write-Host "  MISSING: $f" -ForegroundColor Red
        $ok = $false
    }
}

if (-not $ok) {
    Write-Host ""
    Write-Host "ERROR: Missing files listed above. Copy them and re-run." -ForegroundColor Red
    exit 1
}

Write-Host ""

# -- 2. Check server.js has analytics route -----------------------------------
Write-Host "Checking server.js for analytics route..." -ForegroundColor Cyan

$serverContent = Get-Content "server.js" -Raw

if ($serverContent -match "analytics_export" -or $serverContent -match "/api/analytics") {
    Write-Host "  OK: Analytics route already registered" -ForegroundColor Green
} else {
    Write-Host "  Adding analytics route to server.js..." -ForegroundColor Yellow

    $routeLine = "app.use('/api/analytics', require('./routes/analytics_export'));"

    if ($serverContent -match "module\.exports") {
        $serverContent = $serverContent -replace "module\.exports", "$routeLine`r`n`r`nmodule.exports"
    } else {
        $serverContent = $serverContent + "`r`n$routeLine`r`n"
    }

    Set-Content "server.js" $serverContent -Encoding UTF8
    Write-Host "  OK: Analytics route added to server.js" -ForegroundColor Green
}

Write-Host ""

# -- 3. Check Dockerfile has openpyxl ----------------------------------------
Write-Host "Checking Dockerfile for openpyxl..." -ForegroundColor Cyan

$dockerContent = Get-Content "Dockerfile" -Raw

if ($dockerContent -match "openpyxl") {
    Write-Host "  OK: openpyxl already in Dockerfile" -ForegroundColor Green
} else {
    Write-Host "  Adding openpyxl to Dockerfile..." -ForegroundColor Yellow
    $dockerContent = $dockerContent + "`r`nRUN pip3 install openpyxl --break-system-packages`r`n"
    Set-Content "Dockerfile" $dockerContent -Encoding UTF8
    Write-Host "  OK: openpyxl added to Dockerfile" -ForegroundColor Green
}

Write-Host ""

# -- 4. Build & push image using Google Cloud Build --------------------------
Write-Host "Submitting build to Google Cloud Build..." -ForegroundColor Cyan
Write-Host "  (This builds in the cloud - no local Docker needed)" -ForegroundColor Cyan
Write-Host "  This takes 3-8 minutes..." -ForegroundColor Cyan
Write-Host ""

gcloud builds submit `
    --tag=$Image `
    --project=$Project `
    .

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Cloud Build failed." -ForegroundColor Red
    Write-Host "Check the build log above for details." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  OK: Image built and pushed to GCR" -ForegroundColor Green
Write-Host ""

# -- 5. Deploy to Cloud Run ---------------------------------------------------
Write-Host "Deploying to Cloud Run..." -ForegroundColor Cyan

gcloud run deploy $Service `
    --image=$Image `
    --region=$Region `
    --project=$Project `
    --allow-unauthenticated `
    --memory=2Gi `
    --cpu=2 `
    --max-instances=100 `
    --timeout=3600 `
    --quiet

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Cloud Run deploy failed." -ForegroundColor Red
    exit 1
}

Write-Host "  OK: Deployed to Cloud Run" -ForegroundColor Green
Write-Host ""

# -- 6. Verify ----------------------------------------------------------------
Write-Host "Verifying service..." -ForegroundColor Cyan

$url = gcloud run services describe $Service `
    --region=$Region `
    --project=$Project `
    --format="value(status.address.url)"

Write-Host ""
Write-Host "=== DEPLOYMENT COMPLETE ===" -ForegroundColor Green
Write-Host "Service URL: $url" -ForegroundColor Green
Write-Host ""
Write-Host "Test it now:" -ForegroundColor Cyan
Write-Host "  1. Open: https://mitra-production-core.web.app" -ForegroundColor White
Write-Host "  2. Click Analytics tab" -ForegroundColor White
Write-Host "  3. Click Export Data button" -ForegroundColor White
Write-Host "  4. File should download as Jun2026.xlsx" -ForegroundColor White
Write-Host ""
Write-Host "If something looks wrong, check logs:" -ForegroundColor Cyan
Write-Host "  gcloud logging read resource.type=cloud_run_revision --project=$Project --limit=20" -ForegroundColor White