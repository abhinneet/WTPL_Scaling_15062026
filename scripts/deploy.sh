#!/usr/bin/env bash
# scripts/deploy.sh — one-shot Cloud Run + Firebase Hosting deploy
#
# Usage:
#   ./scripts/deploy.sh                  # uses current gcloud project
#
# Required env (or you'll be prompted):
#   PROJECT_ID, REGION, CLOUD_SQL_INSTANCE, STORAGE_BUCKET, APP_BASE_URL
#
# This script is safe to re-run. It assumes you have already:
#   1. Run scripts/bootstrap.sh once to create the Cloud SQL instance,
#      Cloud Storage bucket, Artifact Registry repo, and Secret Manager
#      secrets. (See WALKTHROUGH.html for the manual steps.)

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ask()  { read -r -p "$1: " "$2"; }

bold "🚀 MITRA Deploy — starting"

# ── Resolve project ─────────────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID:-}" ]]; then
  ask "GCP Project ID" PROJECT_ID
  gcloud config set project "$PROJECT_ID"
fi

REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-mitra-api}"
AR_REPO="${AR_REPO:-mitra}"

[[ -z "${CLOUD_SQL_INSTANCE:-}" ]] && ask "Cloud SQL instance (project:region:name)" CLOUD_SQL_INSTANCE
[[ -z "${STORAGE_BUCKET:-}"     ]] && ask "Storage bucket name (no gs:// prefix)"  STORAGE_BUCKET
[[ -z "${APP_BASE_URL:-}"       ]] && ask "Public dashboard URL"                  APP_BASE_URL

bold "→ Project: $PROJECT_ID   Region: $REGION   Service: $SERVICE"

# ── Submit the build ────────────────────────────────────────────────────────
bold "📦 Submitting Cloud Build…"
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions=_REGION="$REGION",_SERVICE="$SERVICE",_AR_REPO="$AR_REPO",_CLOUD_SQL_INSTANCE="$CLOUD_SQL_INSTANCE",_STORAGE_BUCKET="$STORAGE_BUCKET",_APP_BASE_URL="$APP_BASE_URL" \
  .

# ── Deploy Firebase Hosting ─────────────────────────────────────────────────
bold "🔥 Deploying Firebase Hosting…"
if ! command -v firebase >/dev/null; then
  echo "Firebase CLI is missing. Install it: npm install -g firebase-tools" >&2
  exit 1
fi
firebase deploy --only hosting

bold "✅ Done."
echo "   API   : https://${SERVICE}-XXXX-${REGION/asia/as}.a.run.app  (Cloud Run will print the exact URL)"
echo "   Site  : $APP_BASE_URL"
