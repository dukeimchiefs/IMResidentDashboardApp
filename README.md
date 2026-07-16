# Resident Attendance Check-In App

QR-code-based conference check-in for residents. Three independent, server-side-verified
HMAC QR codes — **Noon Conference** and **Learning Session** (daily) and **Medicine Grand
Rounds** (weekly, Fridays only) — with identity confirmed through an email magic link
matched against a preloaded roster. See `Claude.md` for the original design spec and
rationale.

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

`schema.sql` only applies cleanly to a fresh database. If `attendance.event_type`'s CHECK
constraint changes on an already-deployed database (e.g. adding a new event type), SQLite
can't alter a CHECK constraint in place — run the matching one-off `migrate_*.sql` script
instead (e.g. `wrangler d1 execute attendance-db --remote --file=./migrate_add_grand_rounds.sql`).
If you deployed before the `login_rejections` table was added, apply
`migrate_add_login_rejections.sql` the same way.

### 1b. Rate limiting KV namespace

`/login`, `/attendance`, and `/export` are throttled using a Cloudflare KV namespace
(`RATE_LIMIT` binding, already configured in `wrangler.toml` with a live namespace ID).
No further setup needed unless you're forking this into a new Cloudflare account, in
which case run `wrangler kv namespace create RATE_LIMIT` and update the `id` in
`wrangler.toml`.

### 2. Pages project secrets

```sh
wrangler pages secret put SESSION_SECRET       --project-name=imresidentdashboardapp  # random string, signs resident session cookies
wrangler pages secret put ADMIN_SESSION_SECRET --project-name=imresidentdashboardapp  # random string, signs the admin (/attendance) cookie — must differ from SESSION_SECRET
wrangler pages secret put QR_SECRET            --project-name=imresidentdashboardapp  # random string, must match the GitHub Actions secret below
wrangler pages secret put RESEND_KEY           --project-name=imresidentdashboardapp  # Resend API key
wrangler pages secret put ADMIN_EXPORT_KEY     --project-name=imresidentdashboardapp  # random string, protects GET /export
wrangler pages secret put ADMIN_PASSWORD       --project-name=imresidentdashboardapp  # password gating the /attendance table view
```

**`QR_SECRET` must be set to the exact same value in two places** — here (Pages secret)
and as a GitHub Actions repository secret (Settings → Secrets and variables → Actions →
`QR_SECRET`). There is no automatic sync between the two. If you ever rotate this secret,
update both or QR validation will silently break.

**Pages secrets need a fresh deployment to take effect.** Each Pages deployment is an
immutable snapshot that binds whatever secrets existed *at build time* — running
`wrangler pages secret put` updates the project config but does **not** retroactively
apply to the currently-live deployment, and retrying an old deployment reuses its
original snapshot rather than pulling current secret values. After setting or changing
any secret above, trigger a new deployment (e.g. `git commit --allow-empty -m "..." &&
git push`) before testing, or the old value (or no value at all) will still be live.

**Sending domain:** `nicholasbrazeau.com` is verified in Resend (DKIM/SPF/DMARC), and
`RESEND_FROM` in `wrangler.toml` is set to `noreply@nicholasbrazeau.com`. Before that
verification, Resend only allowed sending from the `onboarding@resend.dev` sandbox
address and only delivered to the account owner's own verified email — real
`@duke.edu` roster entries wouldn't have received anything. If this ever needs to move
to a different domain, re-verify it in Resend first and update `RESEND_FROM` to match,
or magic links will silently fail to deliver again.

**Free-tier daily cap:** Resend's free plan caps sends at 100/day (3,000/month). If the
whole residency (~170 people) tries to sign in the same day, some sends will hit that
cap. `functions/login.js` tracks a same-day send counter in KV and stops calling Resend
once it's within 10 of the cap, returning a "high demand, try again shortly" message
instead of silently dropping the email — this avoids a hard failure but doesn't increase
real capacity. If launch-day volume is a concern, upgrading the Resend plan removes the
cap entirely.

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

## QR rotation

`.github/workflows/rotate-qr.yml` runs `scripts/generate_qr.py noon learning` every
morning, committing fresh `frontend/assets/qr/qr_noon.png` and `qr_learning.png`.

`.github/workflows/rotate-grand-rounds-qr.yml` runs `scripts/generate_qr.py grandrounds`
every Friday morning (~4-5am America/New_York, same UTC-anchored cron approach as the
daily job), committing fresh `frontend/assets/qr/qr_grandrounds.png` — Grand Rounds only
happens on Fridays, so this code doesn't need to rotate daily.

Either commit triggers a Pages rebuild automatically. `frontend/display-noon.html`,
`frontend/display-learning.html`, and `frontend/display-grandrounds.html` each show one
event's current code full-size, for projecting on the screen in that event's room.

## Local development

```sh
wrangler d1 execute attendance-db --local --file=./schema.sql
npm run dev   # wrangler pages dev frontend — D1 and KV bindings auto-detected from
              # wrangler.toml, secrets read from .dev.vars
```

Create a `.dev.vars` file (gitignored) at the repo root with test values for
`SESSION_SECRET`, `ADMIN_SESSION_SECRET`, `QR_SECRET`, `RESEND_KEY`, `ADMIN_EXPORT_KEY`,
`ADMIN_PASSWORD`. Generate local test QR codes with
`QR_SECRET=<same-value-as-.dev.vars> python scripts/generate_qr.py`.

## Viewing attendance

**`GET /attendance`** is a password-gated page (separate from resident sign-in) showing
a simple table of date, resident name, and event. Enter the `ADMIN_PASSWORD` secret once;
it sets a 7-day cookie so you don't have to re-enter it every visit. The same page also
lists recent `/login` attempts for emails **not** found in the roster (typos, rotated-out
residents, or probing) — the resident-facing response is always the same generic "check
your email" message regardless of roster membership (to avoid roster-enumeration), so
this admin-only log is the way to notice a legitimate resident whose email isn't seeded
yet.

`GET /export` (header `X-Admin-Key: <ADMIN_EXPORT_KEY>`, optional `?since=YYYY-MM-DD`)
returns all attendance rows as JSON, including `event_type`
(`noon_conference` / `learning_session` / `grand_rounds`). This app does not compute or
store point values — the downstream game dashboard owns scoring and applies its own point
weighting per event type.
