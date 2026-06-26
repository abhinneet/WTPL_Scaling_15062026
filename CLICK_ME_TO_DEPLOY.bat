@echo off
title MITRA Deployment - Please wait...
color 0A
cls

echo.
echo  ================================================
echo   MITRA DASHBOARD DEPLOYMENT
echo   Please keep this window open. Do not close it.
echo  ================================================
echo.

cd /d "D:\Abhinneet\Dashboard\14062026\WTPL_Scaling_15062026"
if errorlevel 1 (
    echo ERROR: Could not find your project folder.
    echo Make sure this file is in the right place.
    pause
    exit
)

echo  [1/6] Setting up permissions... (takes 1-2 min)
echo.

set PROJECT=mitra-production-core
set PROJ_NUM=840465619007

call :grant "serviceAccount:%PROJ_NUM%@cloudbuild.gserviceaccount.com"          roles/storage.admin
call :grant "serviceAccount:%PROJ_NUM%@cloudbuild.gserviceaccount.com"          roles/run.admin
call :grant "serviceAccount:%PROJ_NUM%@cloudbuild.gserviceaccount.com"          roles/iam.serviceAccountUser
call :grant "serviceAccount:%PROJ_NUM%@cloudbuild.gserviceaccount.com"          roles/artifactregistry.writer
call :grant "serviceAccount:%PROJ_NUM%@cloudbuild.gserviceaccount.com"          roles/logging.logWriter
call :grant "serviceAccount:%PROJ_NUM%@cloudbuild.gserviceaccount.com"          roles/secretmanager.secretAccessor
call :grant "serviceAccount:%PROJ_NUM%@cloudbuild.gserviceaccount.com"          roles/cloudsql.client
call :grant "serviceAccount:%PROJ_NUM%-compute@developer.gserviceaccount.com"   roles/storage.admin
call :grant "serviceAccount:%PROJ_NUM%-compute@developer.gserviceaccount.com"   roles/artifactregistry.writer
call :grant "serviceAccount:%PROJ_NUM%-compute@developer.gserviceaccount.com"   roles/logging.logWriter
call :grant "serviceAccount:%PROJ_NUM%-compute@developer.gserviceaccount.com"   roles/run.admin
call :grant "serviceAccount:%PROJ_NUM%-compute@developer.gserviceaccount.com"   roles/secretmanager.secretAccessor
call :grant "serviceAccount:%PROJ_NUM%-compute@developer.gserviceaccount.com"   roles/cloudsql.client
call :grant "serviceAccount:mitra-api@%PROJECT%.iam.gserviceaccount.com"        roles/cloudsql.client
call :grant "serviceAccount:mitra-api@%PROJECT%.iam.gserviceaccount.com"        roles/secretmanager.secretAccessor
call :grant "serviceAccount:mitra-api@%PROJECT%.iam.gserviceaccount.com"        roles/storage.objectAdmin
call :grant "serviceAccount:mitra-api@%PROJECT%.iam.gserviceaccount.com"        roles/run.invoker

echo.
echo  [2/6] Checking Artifact Registry...
gcloud artifacts repositories describe mitra --location=asia-south1 --project=%PROJECT% >nul 2>&1
if errorlevel 1 (
    echo  Creating image storage repository...
    gcloud artifacts repositories create mitra --repository-format=docker --location=asia-south1 --project=%PROJECT% --quiet
) else (
    echo  Already exists. Good.
)

echo.
echo  [3/6] Configuring Docker...
gcloud auth configure-docker asia-south1-docker.pkg.dev --quiet
echo  Done.

echo.
echo  [4/6] Checking your secrets...
set SECRETS_OK=1
for %%S in (jwt-secret jwt-refresh-secret db-password) do (
    gcloud secrets describe %%S --project=%PROJECT% >nul 2>&1
    if errorlevel 1 (
        echo  WARNING: Secret "%%S" is missing^^! Run the secret upload step first.
        set SECRETS_OK=0
    ) else (
        echo  Secret "%%S" found.
    )
)
if "%SECRETS_OK%"=="0" (
    echo.
    echo  STOPPING: One or more secrets are missing.
    echo  Please go back to the chat and complete the secret upload step.
    echo.
    pause
    exit
)

echo.
echo  [5/6] Building and deploying your app to Google Cloud...
echo  This takes 10-15 minutes. You will see a lot of text scrolling.
echo  That is completely normal. Do NOT close this window.
echo.

set SUBS=_REGION=asia-south1,_SERVICE=mitra-api,_AR_REPO=mitra,_CLOUD_SQL_INSTANCE=mitra-production-core:asia-south1:mitra-db,_STORAGE_BUCKET=mitra-production-core.firebasestorage.app,_APP_BASE_URL=https://mitra-production-core.web.app

gcloud builds submit --config cloudbuild.yaml --substitutions=%SUBS% --project=%PROJECT% .

if errorlevel 1 (
    echo.
    echo  ================================================
    echo   BUILD FAILED. 
    echo   Please scroll up, copy all the red text,
    echo   and paste it into the chat for help.
    echo  ================================================
    pause
    exit
)

echo.
echo  [6/6] Publishing your dashboard website...
firebase deploy --only hosting --project=%PROJECT%

echo.
echo  ================================================
echo   SUCCESS! YOUR DASHBOARD IS LIVE!
echo.
echo   Open this link in your browser:
echo   https://mitra-production-core.web.app
echo.
echo   Login with: admin@mitra.com
echo  ================================================
echo.
pause
exit

:grant
gcloud projects add-iam-policy-binding %PROJECT% --member="%~1" --role="%~2" --quiet >nul 2>&1
echo  Permission granted: %~2
goto :eof
