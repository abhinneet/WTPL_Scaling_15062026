# scripts/deploy.ps1  one-shot Cloud Run + Firebase Hosting deploy (Windows)
# Run from PowerShell:  .\scripts\deploy.ps1

$ErrorActionPreference = 'Stop'

function Bold($msg) { Write-Host $msg -ForegroundColor Cyan }
function Ask($prompt) { Read-Host $prompt }

Bold "MITRA Deploy  starting"

if (-not $env:PROJECT_ID) {
    $env:PROJECT_ID = (gcloud config get-value project 2>$null)
    if (-not $env:PROJECT_ID) {
        $env:PROJECT_ID = Ask "GCP Project ID"
        gcloud config set project $env:PROJECT_ID
    }
}

if (-not $env:REGION)              { $env:REGION  = 'asia-south1' }
if (-not $env:SERVICE)             { $env:SERVICE = 'mitra-api' }
if (-not $env:AR_REPO)             { $env:AR_REPO = 'mitra' }
if (-not $env:CLOUD_SQL_INSTANCE)  { $env:CLOUD_SQL_INSTANCE = Ask "Cloud SQL instance (project:region:name)" }
if (-not $env:STORAGE_BUCKET)      { $env:STORAGE_BUCKET     = Ask "Storage bucket name (no gs:// prefix)" }
if (-not $env:APP_BASE_URL)        { $env:APP_BASE_URL       = Ask "Public dashboard URL" }

Bold "Project: $($env:PROJECT_ID)   Region: $($env:REGION)   Service: $($env:SERVICE)"

Bold "Submitting Cloud Build"
gcloud builds submit `
  --config cloudbuild.yaml `
  --substitutions=_REGION=$env:REGION,_SERVICE=$env:SERVICE,_AR_REPO=$env:AR_REPO,_CLOUD_SQL_INSTANCE=$env:CLOUD_SQL_INSTANCE,_STORAGE_BUCKET=$env:STORAGE_BUCKET,_APP_BASE_URL=$env:APP_BASE_URL `
  .

Bold "Deploying Firebase Hosting"
if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
    Write-Error "Firebase CLI missing. Install it:  npm install -g firebase-tools"
    exit 1
}
firebase deploy --only hosting

Bold "Done."
Write-Host "   Site : $($env:APP_BASE_URL)"
