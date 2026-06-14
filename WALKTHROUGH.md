# WALKTHROUGH.md — Deploy MITRA in 13 steps

> **Important:** This is the plain-text version. The `WALKTHROUGH.html` version has picture cards for every step and is much easier to follow. **Open `WALKTHROUGH.html` in your browser if you can.**

You'll be deploying:
- **Firebase Hosting** → serves your dashboard HTML/JS/CSS to users
- **Cloud Run** → runs your Express API (Node.js)
- **Cloud SQL** → your PostgreSQL database
- **Cloud Storage** → uploaded files (videos, AR assets)
- **Secret Manager** → keeps passwords/JWT secrets out of code

Estimated time: 30–60 minutes the first time. Estimated cost: ₹800–₹2,500/month (~$10–25) at low traffic.

---

## Step 1 — Install the tools you need

You need three command-line tools on your computer:

| Tool | What it does | Install link |
|---|---|---|
| `gcloud` | Google Cloud CLI | https://cloud.google.com/sdk/docs/install |
| `firebase` | Firebase CLI | `npm install -g firebase-tools` |
| `node` (≥20) | Node.js runtime | https://nodejs.org/ |

Verify all three:
```bash
gcloud --version
firebase --version
node --version
```

If any of those say "command not found", install it before moving on.

---

## Step 2 — Create your Firebase project

1. Go to https://console.firebase.google.com/
2. Click **"Add project"** (or **"Create a project"**)
3. Pick a name — e.g. `mitra-prod`. Firebase will turn this into an ID like `mitra-prod-12345`.
4. Disable Google Analytics for now (you can add it later)
5. Wait ~30 seconds while it creates

**Write down your project ID.** You'll need it many times.

---

## Step 3 — Enable billing

Cloud SQL is not free. You need a credit card on file even if traffic is low.

1. Go to https://console.cloud.google.com/billing
2. Click **"Link a billing account"** for your project
3. Add a payment method if you don't have one
4. Set a **budget alert** (recommended: ₹2,000/month) so you get an email if something runs away

Without billing enabled, the next steps fail.

---

## Step 4 — Enable the APIs

Run this in a terminal (replace `YOUR_PROJECT_ID`):

```bash
gcloud config set project YOUR_PROJECT_ID

gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  storage-api.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firebasehosting.googleapis.com \
  iam.googleapis.com
```

This takes 1–2 minutes. If it complains about authentication, run `gcloud auth login` first.

---

## Step 5 — Create your Cloud SQL Postgres instance

```bash
gcloud sql instances create mitra-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=asia-south1 \
  --root-password='ChangeThisRootPasswordNow!' \
  --storage-size=10GB \
  --storage-type=SSD \
  --backup-start-time=02:00 \
  --enable-point-in-time-recovery
```

This takes 5–10 minutes. While you wait, **save the root password somewhere safe** (a password manager, not a text file).

After it finishes:
```bash
# Create the application database
gcloud sql databases create mitra --instance=mitra-db

# Create the application user (NOT the root user — for the app to use)
gcloud sql users create mitra_app \
  --instance=mitra-db \
  --password='AppUserPasswordChangeMe!'
```

**Your `CLOUD_SQL_INSTANCE` connection string is:** `YOUR_PROJECT_ID:asia-south1:mitra-db`

---

## Step 6 — Create your storage bucket

Pick a globally-unique name. Example: `mitra-uploads-mumbai-2026`.

```bash
gcloud storage buckets create gs://YOUR_BUCKET_NAME \
  --location=asia-south1 \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access
```

The Cloud Run service account will get access automatically (set up in step 8).

---

## Step 7 — Put your secrets in Secret Manager

You need to generate two strong, random secrets first. On Linux/Mac:
```bash
openssl rand -base64 48           # for JWT_SECRET
openssl rand -base64 48           # for JWT_REFRESH_SECRET (must be different)
```

On Windows PowerShell:
```powershell
[Convert]::ToBase64String((1..48 | %{[byte](Get-Random -Max 256)}))
```

Now store them:
```bash
echo -n 'PASTE_FIRST_SECRET_HERE'  | gcloud secrets create jwt-secret         --data-file=-
echo -n 'PASTE_SECOND_SECRET_HERE' | gcloud secrets create jwt-refresh-secret --data-file=-
echo -n 'AppUserPasswordChangeMe!' | gcloud secrets create db-password        --data-file=-
```

---

## Step 8 — Create the service account & deploy

Cloud Run needs an identity to access Cloud SQL, Storage, and Secret Manager.

```bash
gcloud iam service-accounts create mitra-api \
  --display-name="MITRA API service account"

# Grant permissions
PROJECT_ID=$(gcloud config get-value project)
SA="mitra-api@$PROJECT_ID.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/cloudsql.client"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"

# Create Artifact Registry repo
gcloud artifacts repositories create mitra \
  --repository-format=docker \
  --location=asia-south1 \
  --description="MITRA container images"
```

Now run the deploy script:

```bash
# From the MITRA project root:
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

The script will ask you for:
- Cloud SQL instance → `YOUR_PROJECT_ID:asia-south1:mitra-db`
- Bucket name → `YOUR_BUCKET_NAME`
- Public dashboard URL → leave blank for now, you'll fill it in step 12

The build takes 5–10 minutes. When it finishes you'll see a Cloud Run URL like `https://mitra-api-XXX-as.a.run.app`.

---

## Step 9 — Initialize Firebase Hosting

In your project folder:

```bash
cp .firebaserc.example .firebaserc
# Edit .firebaserc and replace REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID with your real ID

firebase login
firebase use --add        # pick your project
```

---

## Step 10 — Put your dashboard HTML in place

Copy `public/index.html` from your old `MITRA_06052026/public/` folder into the `public/` folder of THIS bundle.

Open it and add to the `<head>` section:
```html
<script src="/api-client.js" defer></script>
```

This gives the dashboard a helper that auto-refreshes JWT tokens and downloads via signed URLs.

---

## Step 11 — Run the database migrations and seed

Use the Cloud SQL Auth Proxy from your laptop:

```bash
# In a separate terminal — leave this running
cloud-sql-proxy --port 5433 YOUR_PROJECT_ID:asia-south1:mitra-db
```

In your main terminal:
```bash
# Set the database URL to the proxy
export DATABASE_URL="postgresql://mitra_app:AppUserPasswordChangeMe!@127.0.0.1:5433/mitra"

# Run migrations
npm install
npm run migrate

# Create your real admin (pick a strong password)
SEED_ADMIN_EMAIL='you@yourdomain.gov.in' \
SEED_ADMIN_NAME='Your Name' \
SEED_ADMIN_PASSWORD='YourStrongPassword!2026' \
  npm run seed
```

Press Ctrl-C in the proxy terminal when done.

---

## Step 12 — Deploy Firebase Hosting

```bash
firebase deploy --only hosting
```

It'll print a URL like `https://YOUR_PROJECT.web.app`. That's your dashboard.

Re-run the deploy script to update Cloud Run with this URL as `APP_BASE_URL` (so password-reset emails point at the right place):

```bash
APP_BASE_URL="https://YOUR_PROJECT.web.app" ./scripts/deploy.sh
```

---

## Step 13 — Log in & test

1. Open `https://YOUR_PROJECT.web.app/login.html`
2. Sign in with the email + password from step 11
3. Try uploading a small ad video → it should hit Cloud Storage, not the container filesystem
4. Try downloading it again → it should redirect through a signed URL
5. Check Cloud Run logs: `gcloud run services logs read mitra-api --region asia-south1 --limit 50`

If everything works: **you're live.** 🎉

If something doesn't work, see the Troubleshooting section in `WALKTHROUGH.html`, or paste the error into Claude.ai.

---

## Future maintenance

- **Update the API**: re-run `./scripts/deploy.sh`
- **Update the dashboard HTML**: re-run `firebase deploy --only hosting`
- **Add a custom domain**: Firebase Console → Hosting → Add custom domain
- **Rotate JWT secrets**: `gcloud secrets versions add jwt-secret --data-file=-`, then re-deploy
