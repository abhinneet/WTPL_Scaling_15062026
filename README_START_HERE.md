# 👋 START HERE

You asked for: a secure, Firebase-deployable version of MITRA, with everything a non-developer needs to actually ship it.

This bundle delivers that. **The shortest path to having your dashboard live:**

1. **Open `WALKTHROUGH.html` in your web browser** (just double-click it).
2. Follow the 13 steps. Each one has a picture-card showing what you'll see.
3. When the walkthrough says "run the deploy script", you run it.

That's it. The walkthrough holds your hand through every command. It assumes you have never used the Google Cloud command line before.

---

## What's in this folder?

| File / Folder | What it is | When to open it |
|---|---|---|
| **`WALKTHROUGH.html`** | Your step-by-step deployment guide with picture cards | **First. Open this now.** |
| `WALKTHROUGH.md` | Same content, plain text, viewable on GitHub | If you can't open the HTML |
| `SECURITY_AUDIT.md` | All 47 issues I found and fixed, with severity ratings | When you want to know what changed and why |
| `CHANGES.md` | File-by-file changelog | When comparing to your old code |
| `MIGRATION_GUIDE.md` | Detailed PostgreSQL → Cloud SQL move | When you're ready to move existing data |
| `.env.example` | Every environment variable explained | When the walkthrough says "set these" |
| `firebase.json` | Firebase Hosting config (routes `/api/**` → Cloud Run) | Don't touch unless you change regions |
| `cloudbuild.yaml` | The build/deploy pipeline | Used by `deploy.sh` |
| `Dockerfile` | How your API gets packaged into a container | Used by Cloud Build |
| `scripts/deploy.sh` (Linux/Mac) | One command to build + deploy | Step 8 of the walkthrough |
| `scripts/deploy.ps1` (Windows) | Same, for Windows PowerShell | Step 8 of the walkthrough |
| `scripts/migrate-postgres-to-cloudsql.sh` | Move existing DB data to Cloud SQL | Optional, only if you have data already |
| `routes/` | Server endpoints | Code — the walkthrough handles this for you |
| `lib/` | Helpers: logging, secrets, storage abstraction | Code — handled for you |
| `middleware/` | Auth and rate-limiting | Code — handled for you |
| `db/` | Database connection, migrations, seed script | Code — handled for you |
| `public/` | Frontend helpers that get served by Firebase Hosting | You'll add your `index.html` here (see below) |

## What you still need to do manually

I cannot do these for you — they need your Google account and credit card:

1. **Create a Firebase project** (free, takes 2 minutes — walkthrough step 2)
2. **Enable billing** on the underlying Google Cloud project (required for Cloud SQL — walkthrough step 3). Expected cost: roughly ₹800–₹2,500/month (~$10–25) at low traffic.
3. **Run the deploy script** — the walkthrough tells you what to type, line by line.
4. **Copy your existing dashboard HTML** (`public/index.html` from your old repo) into `public/index.html` here. I did NOT touch your dashboard's UI — too risky to rewrite 10,000 lines I didn't write.
5. **Update your dashboard's `<head>`** to include the two new scripts (walkthrough step 10):
   ```html
   <script src="/api-client.js" defer></script>
   ```
   (Optionally `/inline-handler-bridge.js` if you switch to strict CSP later.)

## What I did NOT change

- Your dashboard UI (`public/index.html` ~10,000 lines) — untouched on purpose
- The smartphone app — that's the next project, not this one
- Bcrypt → Argon2 migration — would invalidate every existing user password
- Routes I didn't need to harden for security (analytics, locations, curriculum etc.) — preserved as-is from your repo. **You'll need to copy these over** — see `CHANGES.md` for the exact list.

## Honest expectations

- **First deploy will take 30–60 minutes** if you've never used Google Cloud
- **Things may fail the first time.** Cloud projects, billing, API enables — there are many places to get a typo. The walkthrough covers the most common errors.
- **I have not tested this end-to-end** — I have no access to your Firebase project, your billing, or your data. Every line of code follows the right patterns, but you may hit environment-specific issues. Errors are typically clear; copy them into Claude.ai and I'll help debug.

## When something goes wrong

- API not responding → check Cloud Run logs (walkthrough step 14)
- Database connection error → check `CLOUD_SQL_INSTANCE` env var format is `project:region:instance`
- "Login failed" → make sure you ran `npm run seed` (walkthrough step 11) and the email matches `SEED_ADMIN_EMAIL`
- Anything else → paste the error into Claude.ai chat

Good luck. Open **WALKTHROUGH.html** next.
