# Resident Attendance Check-In App — Build Plan

## Overview

A lightweight, free-to-host web app that lets residents check in to conferences/didactics
by scanning a QR code that changes daily. Identity is verified via email magic link
(matched against a preloaded roster — residents never type their own name), duplicate
check-ins per day are blocked server-side, and stale QR codes automatically stop working.

Feeds a residency "game dashboard" leaderboard, so attendance data must be trustworthy:
no free-text names, no reusable codes, no client-side-only validation.

## Stack

- **Hosting/Frontend:** Cloudflare Pages (static site + camera-based QR scanner)
- **Backend logic:** Cloudflare Workers (serverless, no cold starts, free tier)
- **Database:** Cloudflare D1 (serverless SQLite, free tier)
- **Email delivery:** Resend (free tier, 3,000 emails/month) for magic links
- **QR scanning:** `jsQR` (or native `BarcodeDetector` API where supported) — reads the
  camera feed client-side, no photo upload
- **QR generation:** Python `qrcode` library, run daily via a scheduled GitHub Action
- **Deploy tooling:** Wrangler CLI (Cloudflare), GitHub integration for CI/CD

No Power Automate, no Microsoft Forms, no Excel as a live write target.

## Why this architecture

- Cloudflare Workers has no cold starts (unlike Render's free tier), which matters
  because traffic is bursty — many residents scan within a couple minutes at the start
  of each conference.
- D1 keeps the whole stack (frontend + backend + database) on one free platform instead
  of bolting on Airtable/Mongo separately.
- Magic-link auth avoids needing Duke IT to register an Entra ID app, while still
  proving the resident controls their @duke.edu mailbox.
- Roster lookup (not free text) means a name can never be spoofed or mistyped — it's
  always pulled server-side from the email that was verified.

## Database schema (D1)

```sql
CREATE TABLE roster (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  event_date TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
```

Roster is seeded once from a CSV of resident names + Duke emails, and updated manually
as residents rotate in/out (or via a simple admin endpoint — TBD, see Open Questions).

## Core flows

### 1. Daily QR rotation (no manual expiry tracking needed)

- A secret key lives only in the Worker's environment (never shipped to the browser).
- Each day's expected token = `HMAC-SHA256(SECRET, today's date)`, truncated.
- A GitHub Action runs each morning: computes today's token, generates a QR image
  encoding it, and either commits it to the Pages repo or pushes it via the API for
  display/printing.
- The Worker independently recomputes "today's token" on every request — no database
  of used/valid tokens required, and yesterday's QR simply won't match anymore.

### 2. Magic link login (first time, then persists ~30 days)

1. Resident enters their @duke.edu email in the app.
2. Worker checks the email against `roster`. If not found, reject.
3. Worker generates a random token, stores it in `magic_links` with a 15-minute
   expiry, and emails a sign-in link via Resend.
4. Resident clicks the link → Worker validates the token (not expired, not already
   used), marks it used, looks up their name from `roster`, and issues a signed
   session (JWT or signed cookie) valid for ~30 days.
5. Session is stored as an `HttpOnly`, `Secure` cookie — no local storage of identity
   the resident could edit.

### 3. Check-in (camera scan)

1. Resident opens the app (already signed in from step 2 — no daily re-login).
2. Taps "Scan," camera opens, `jsQR` decodes the QR code live from the video feed.
3. Frontend POSTs `{ token: <decoded value> }` to the Worker, session cookie sent
   automatically.
4. Worker validates:
   - Session cookie is valid and unexpired → identifies resident by email/name.
   - Scanned token matches today's expected HMAC token (rejects stale/expired codes).
   - No existing `attendance` row for `(email, today's date)` → rejects duplicates.
5. On success, insert into `attendance` and return a confirmation
   (e.g., `"Checked in, <name>"`).

## Repo structure

```
attendance-app/
├── worker/
│   ├── src/
│   │   ├── index.js          # routes: /login, /verify, /checkin
│   │   ├── auth.js           # magic link + session sign/verify helpers
│   │   ├── token.js          # daily HMAC token logic
│   │   └── db.js             # D1 query helpers
│   ├── schema.sql
│   └── wrangler.toml
├── frontend/
│   ├── index.html            # login screen + scan screen
│   ├── scan.js               # jsQR camera integration
│   └── style.css
├── scripts/
│   ├── generate_qr.py        # daily QR generation
│   └── seed_roster.py        # one-time CSV → D1 roster import
├── .github/workflows/
│   └── rotate-qr.yml         # scheduled Action, runs generate_qr.py daily
└── README.md
```

## Environment variables / secrets (Cloudflare Worker)

| Name | Purpose |
|---|---|
| `SESSION_SECRET` | Signs/verifies the login session cookie |
| `QR_SECRET` | HMAC key for daily token generation (must match `generate_qr.py`) |
| `RESEND_KEY` | API key for sending magic link emails |
| `DB` | D1 database binding (configured in `wrangler.toml`) |

## Build phases

1. **D1 setup** — create database, apply schema, write `seed_roster.py` to import
   the resident CSV.
2. **Daily token + QR generation** — `token.js` (Worker) and `generate_qr.py`
   (script) implementing matching HMAC logic; wire up the GitHub Action.
3. **Magic link auth** — `/login` and `/verify` endpoints, Resend integration,
   session signing.
4. **Check-in endpoint** — `/checkin`, including token validation and duplicate check.
5. **Frontend** — login screen (email entry), scan screen (`jsQR` camera view),
   confirmation state.
6. **Deploy** — Wrangler deploy for the Worker + D1, Cloudflare Pages for the
   frontend, custom domain if desired.
7. **Dashboard read** — a simple query/export path so the existing residency game
   dashboard can pull from `attendance` (direct D1 query, or a scheduled export).

## Open questions to resolve before/during build

- **Roster maintenance:** manual CSV re-upload each year, or build a small admin
  endpoint to add/remove residents without touching the database directly?
- **Session length:** 30 days suggested — confirm that's the right balance between
  convenience and re-verifying identity periodically.
- **Dashboard integration:** does the game dashboard need a live API, or is a
  periodic export (e.g., CSV/JSON snapshot) sufficient?
- **Custom domain:** using the default `*.pages.dev` / `*.workers.dev` URLs vs.
  registering a short custom domain for the QR link (shorter QR = faster scans).
