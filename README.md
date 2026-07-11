# Resident Attendance Check-In App

QR-code-based conference check-in for residents. Two independent daily-rotating QR
codes — **Noon Conference** and **Learning Session** — each verified server-side via
HMAC, with identity confirmed through an email magic link matched against a preloaded
roster. See `Claude.md` for the original design spec and rationale.

## Stack

A single **Cloudflare Pages** project serving the static frontend (`frontend/`) and the
backend API as **Pages Functions** (`functions/`) — one deploy, one domain, no CORS or
cross-site cookie issues. Backed by **Cloudflare D1** (database) and **Resend**
(magic-link email). A Python script run daily via GitHub Actions rotates the QR images.

Functions and frontend share one origin (`imresidentdashboardapp.pages.dev`, or a custom
domain later) so the session cookie is always first-party — this matters because Safari
and other browsers block third-party cookies by default, which would otherwise break
sign-in for anyone on iOS.

## One-time setup

### 1. D1 database

```sh
wrangler d1 create attendance-db
# copy the returned database_id into wrangler.toml
wrangler d1 execute attendance-db --remote --file=./schema.sql
```

### 2. Pages project secrets

```sh
wrangler pages secret put SESSION_SECRET   --project-name=imresidentdashboardapp  # random string, signs session cookies
wrangler pages secret put QR_SECRET        --project-name=imresidentdashboardapp  # random string, must match the GitHub Actions secret below
wrangler pages secret put RESEND_KEY       --project-name=imresidentdashboardapp  # Resend API key
wrangler pages secret put ADMIN_EXPORT_KEY --project-name=imresidentdashboardapp  # random string, protects GET /export
```

**`QR_SECRET` must be set to the exact same value in two places** — here (Pages secret)
and as a GitHub Actions repository secret (Settings → Secrets and variables → Actions →
`QR_SECRET`). There is no automatic sync between the two. If you ever rotate this secret,
update both or QR validation will silently break.

**Resend sandbox limitation:** until a custom domain is verified in the Resend
dashboard, Resend only allows sending from `onboarding@resend.dev` (set as `RESEND_FROM`
in `wrangler.toml`) and only allows delivery **to your own verified Resend account
email** — not to arbitrary resident inboxes. This is fine for early testing (put your own
email in the `roster` table to receive test magic links) but **before rostering real
residents, verify a sending domain in Resend** (e.g. a subdomain you control) and update
`RESEND_FROM` to a real address on that domain, or `@duke.edu` magic links will silently
fail to deliver.

### 3. Connect Cloudflare Pages to this repo

Dashboard → Workers & Pages → Create → Pages → Connect to Git → select this repo.
Build command: none. Build output directory: `frontend`. Root directory: `/`.
`wrangler.toml` at the repo root (with `pages_build_output_dir`) supplies the D1 binding
and `RESEND_FROM` var automatically on every Git-triggered build — no dashboard binding
configuration needed.

### 4. Seed the roster

```sh
python scripts/seed_roster.py roster.csv --remote --apply
```

CSV must have `email` and `name` columns. Re-run any time the roster changes
(`INSERT OR REPLACE`, so it's safe to re-run with an updated file).

## Daily QR rotation

`.github/workflows/rotate-qr.yml` runs `scripts/generate_qr.py` every morning, committing
fresh `frontend/assets/qr/qr_noon.png` and `qr_learning.png`. The commit triggers a Pages
rebuild automatically. `frontend/display-noon.html` and `frontend/display-learning.html`
each show one event's current code full-size, for projecting on the screen in that
event's room.

## Local development

```sh
wrangler d1 execute attendance-db --local --file=./schema.sql
npm run dev   # wrangler pages dev frontend --d1=DB, reads secrets from .dev.vars
```

Create a `.dev.vars` file (gitignored) at the repo root with test values for
`SESSION_SECRET`, `QR_SECRET`, `RESEND_KEY`, `ADMIN_EXPORT_KEY`. Generate local test QR
codes with `QR_SECRET=<same-value-as-.dev.vars> python scripts/generate_qr.py`.

## Dashboard integration

`GET /export` (header `X-Admin-Key: <ADMIN_EXPORT_KEY>`, optional `?since=YYYY-MM-DD`)
returns all attendance rows as JSON, including `event_type`
(`noon_conference` / `learning_session`). This app does not compute or store point
values — the downstream game dashboard owns scoring and applies its own point weighting
per event type.

## Google Sheet sync

`.github/workflows/sync-sheet.yml` runs `scripts/sync_attendance_sheet.py` hourly,
pulling `GET /export` and overwriting an `Attendance` worksheet in a Google Sheet with
the current full attendance table (name, email, event_type, event_date, timestamp).
It's a full overwrite each run, not an append — D1 stays the single source of truth and
the Sheet is just a mirror, so there's no dedup/sync-state logic to get wrong.

One-time setup (Google Cloud Console, done once by a project owner):

1. Create a Google Cloud project (or reuse one) and enable the **Google Sheets API**
   for it (APIs & Services → Library).
2. Create a **service account** (APIs & Services → Credentials → Create Credentials →
   Service Account). No project roles needed — access comes entirely from sharing the
   Sheet with it in step 4.
3. On that service account, add a key (Keys tab → Add Key → Create new key → JSON) and
   download it.
4. Create the destination Google Sheet, then share it with the service account's email
   (found in the JSON key, looks like `...@...iam.gserviceaccount.com`) as **Editor**.
5. Copy the Sheet ID from its URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.

Then set these as GitHub Actions repository secrets (Settings → Secrets and variables →
Actions):

```sh
gh secret set GOOGLE_SERVICE_ACCOUNT_KEY --repo dukeimchiefs/IMResidentDashboardApp < service-account-key.json
gh secret set GOOGLE_SHEET_ID --repo dukeimchiefs/IMResidentDashboardApp --body "<sheet id from step 5>"
```

`ADMIN_EXPORT_KEY` is already set as a GitHub secret (kept in sync with the Pages secret
of the same name — see above) and reused by this workflow to call `/export`.

Trigger a run immediately with `gh workflow run sync-sheet.yml --repo dukeimchiefs/IMResidentDashboardApp`
instead of waiting for the next hourly tick.
