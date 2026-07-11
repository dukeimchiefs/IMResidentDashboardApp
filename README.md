# Resident Attendance Check-In App

QR-code-based conference check-in for residents. Two independent daily-rotating QR
codes — **Noon Conference** and **Learning Session** — each verified server-side via
HMAC, with identity confirmed through an email magic link matched against a preloaded
roster. See `Claude.md` for the original design spec and rationale.

## Stack

Cloudflare Pages (frontend) + Cloudflare Workers (backend) + Cloudflare D1 (database) +
Resend (magic-link email) + a Python script run daily via GitHub Actions to rotate QR
images.

## One-time setup

### 1. D1 database

```sh
cd worker
wrangler d1 create attendance-db
# copy the returned database_id into wrangler.toml
wrangler d1 execute attendance-db --remote --file=./schema.sql
```

### 2. Worker secrets

```sh
wrangler secret put SESSION_SECRET     # random string, signs session cookies
wrangler secret put QR_SECRET          # random string, must match the GitHub Actions secret below
wrangler secret put RESEND_KEY         # Resend API key
wrangler secret put ADMIN_EXPORT_KEY   # random string, protects GET /export
```

**`QR_SECRET` must be set to the exact same value in two places** — here (Worker
secret) and as a GitHub Actions repository secret (Settings → Secrets and variables →
Actions → `QR_SECRET`). There is no automatic sync between the two. If you ever rotate
this secret, update both or QR validation will silently break.

**Resend sandbox limitation:** until a custom domain is verified in the Resend
dashboard, Resend only allows sending from `onboarding@resend.dev` (set as `RESEND_FROM`
in `worker/wrangler.toml`) and only allows delivery **to your own verified Resend account
email** — not to arbitrary resident inboxes. This is fine for early testing (put your own
email in the `roster` table to receive test magic links) but **before rostering real
residents, verify a sending domain in Resend** (e.g. a subdomain you control) and update
`RESEND_FROM` to a real address on that domain, or `@duke.edu` magic links will silently
fail to deliver.

### 3. Deploy the Worker

```sh
wrangler deploy
```

### 4. Deploy the frontend

Connect this repo to Cloudflare Pages via the dashboard's Git integration. Build output
directory: `frontend/`. No build command needed (static files).

### 5. Same-origin routing (recommended)

Put the Worker on a route under the same custom domain as Pages (e.g. Pages serves
`checkin.yourdomain.org/*`, Worker handles `checkin.yourdomain.org/api/*`) so the session
cookie is first-party. Uncomment and configure the `routes` block in `worker/wrangler.toml`.
Until a custom domain is set up, the default `*.pages.dev` / `*.workers.dev` URLs work
fine — the QR payload is a bare token string, not a URL, so domain choice never affects
QR scan speed or size.

### 6. Seed the roster

```sh
python scripts/seed_roster.py roster.csv --remote --apply
```

CSV must have `email` and `name` columns. Re-run any time the roster changes
(`INSERT OR REPLACE`, so it's safe to re-run with an updated file).

## Daily QR rotation

`.github/workflows/rotate-qr.yml` runs `scripts/generate_qr.py` every morning, committing
fresh `frontend/assets/qr/qr_noon.png` and `qr_learning.png`. The commit triggers a Pages
rebuild automatically. `frontend/display.html` shows both current codes side by side for
projecting in the conference room.

## Local development

```sh
# Worker (Miniflare-backed local D1)
cd worker
wrangler d1 execute attendance-db --local --file=./schema.sql
wrangler dev --local

# Frontend
wrangler pages dev frontend/
```

Generate local test QR codes with `QR_SECRET=<same-value> python scripts/generate_qr.py`.

## Dashboard integration

`GET /export` (header `X-Admin-Key: <ADMIN_EXPORT_KEY>`, optional `?since=YYYY-MM-DD`)
returns all attendance rows as JSON, including `event_type`
(`noon_conference` / `learning_session`). This app does not compute or store point
values — the downstream game dashboard owns scoring and applies its own point weighting
per event type.
