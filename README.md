# Resident Attendance Check-In App

QR-code-based conference check-in for residents. A resident points their phone's built-in
camera at the code on screen, taps the link, types their name, and is done. There is no
sign-in, no password, no email, and nothing to install.

Three server-side-verified HMAC QR codes — **Noon Conference**, **Learning Session** and
**Medicine Grand Rounds**, all rotating weekly — each encoding a URL of the form
`https://imresidentdashboardapp.pages.dev/checkin?e=<type>&t=<token>`.

A fourth code, **Welcome**, was retired on 2026-08-13. Its 27 attendance rows remain in
the database and still count toward residents' points, so `welcome` is deliberately kept
in the `attendance` CHECK list, in the partial unique index, in `dbValueToLabel`'s
retired-label map, and in `scrape_attendance.py`'s `EVENT_LABELS`. What was removed is
only the ability to check into it: the type is gone from `EVENT_TYPES`, so its QR prefix
no longer parses and any surviving photo of the poster is rejected.

## How a check-in works

1. `scripts/generate_qr.py` HMACs the week's date with `QR_SECRET` and renders the
   resulting URL as a PNG, committed to `frontend/assets/qr/`.
2. The resident's camera opens that URL. `functions/checkin.js` recomputes the token and,
   if it matches, renders a form with a single field.
3. The resident types their name. The Worker matches it against the roster
   (`functions/_lib/names.js`) and writes an attendance row **using the roster's spelling**.
4. `scrape_attendance.py` in the sibling dashboard repo pulls `GET /export` and appends
   `(date, name, event)` to the `AttendancePoints` sheet of `Point_Spreadsheet.xlsx`.

Step 3 is the load-bearing one. The downstream workbook joins on **name** — there is no
email or ID anywhere in that path — so a row written with a name the roster doesn't
contain isn't slightly wrong, it's points that silently never land. The matcher therefore
never guesses: it folds case, accents, punctuation, credentials (`MD`, `Jr`) and middle
names, accepts `Last, First`, and refuses anything that resolves to zero or more than one
resident. See the header comment in `functions/_lib/names.js`.

### What this design accepts

Anyone holding a QR image can check in under any roster name, from anywhere, until that
code rotates. This is a deliberate trade for residents who could not work the previous
email-and-magic-link flow. Weekly rotation bounds the window; Turnstile and the rate
limits below bound the volume. Check-in patterns are reviewed out-of-band by local-only
tooling that is deliberately not part of this repository, and which flags candidates for
a conversation rather than proof of anything.

## Stack

A single **Cloudflare Pages** project serving the static frontend (`frontend/`) and the
backend as **Pages Functions** (`functions/`) — one deploy, one domain. Backed by
**Cloudflare D1**. A Python script run weekly via GitHub Actions rotates the QR images.
**Resend** is still wired up, but only to send security alerts to the chiefs — no
resident ever receives email.

## One-time setup

### 1. D1 database

```sh
wrangler d1 create attendance-db
# copy the returned database_id into wrangler.toml
wrangler d1 execute attendance-db --remote --file=./schema.sql
```

`schema.sql` only applies cleanly to a fresh database. An **existing** database is brought
up to date with `migrate_qr_form_checkin.sql`, which re-keys `attendance` from email to
name and drops the sign-in tables:

```sh
wrangler d1 execute attendance-db --remote --file=./migrate_qr_form_checkin.sql
```

Run it once per database (local and remote). It preserves every existing attendance row.
If `attendance.event_type`'s CHECK constraint changes later (e.g. adding an event type),
SQLite can't alter a CHECK in place — write a new one-off `migrate_*.sql` the same way.

### 1b. Rate limiting and bot protection

`/checkin`, `/attendance` and `/export` are throttled using the same D1 database
(`rate_limit_counters`, created by `schema.sql`). `POST /checkin` carries **two** limits,
because one can't do both jobs: residents check in from a single conference-room Wi-Fi
that NATs the whole room behind one address, so a tight per-IP cap would throttle a full
lecture hall. The tight limit (8 / 10 min) is keyed per person-per-IP; the loose one
(240 / 10 min) is a per-IP ceiling set above any real room but far below a script.

Cloudflare Turnstile guards the check-in form — with no authentication of any kind, it is
the only thing between the form and a script filling the attendance table. **Set the
sitekey's widget mode to Invisible in the Cloudflare dashboard** so residents never see a
challenge. `/attendance` is additionally protected at the edge by a Cloudflare Access
application requiring the administrator identity and MFA.

### 2. Pages project secrets

```sh
wrangler pages secret put ADMIN_SESSION_SECRET --project-name=imresidentdashboardapp  # random string, signs the admin (/attendance) cookie
wrangler pages secret put QR_SECRET            --project-name=imresidentdashboardapp  # random string, must match the GitHub Actions secret below
wrangler pages secret put RESEND_KEY           --project-name=imresidentdashboardapp  # Resend API key (security alerts only)
wrangler pages secret put ADMIN_EXPORT_KEY     --project-name=imresidentdashboardapp  # random string, protects GET /export
wrangler pages secret put ADMIN_PASSWORD       --project-name=imresidentdashboardapp  # password gating the /attendance table view
wrangler pages secret put TURNSTILE_SECRET     --project-name=imresidentdashboardapp  # server-side Turnstile Siteverify secret
wrangler pages secret put SECURITY_ALERT_EMAIL --project-name=imresidentdashboardapp  # recipient for repeated admin/export auth failure alerts
```

`SESSION_SECRET` is no longer used and can be deleted — nothing signs a resident cookie
any more.

**`QR_SECRET` must be set to the exact same value in two places** — here (Pages secret)
and as a GitHub Actions repository secret (Settings → Secrets and variables → Actions →
`QR_SECRET`). There is no automatic sync between the two. If you ever rotate this secret,
update both or QR validation will silently break.

**Pages secrets need a fresh deployment to take effect.** Each Pages deployment is an
immutable snapshot that binds whatever secrets existed *at build time* — running
`wrangler pages secret put` updates the project config but does **not** retroactively
apply to the currently-live deployment, and retrying an old deployment reuses its
original snapshot rather than pulling current secret values. After setting or changing
any secret above, trigger a new deployment before testing, or the old value (or no value
at all) will still be live.

**Sending domain:** `nicholasbrazeau.com` is verified in Resend (DKIM/SPF/DMARC), and
`RESEND_FROM` in `wrangler.toml` is set to `noreply@nicholasbrazeau.com`. Now that the
only outbound mail is a security alert to a single internal address, the deliverability
tuning that the old magic-link emails needed no longer applies — Exchange Online
Protection's scoring of message shape was a concern for ~170 `@duke.edu` inboxes, not for
one alert recipient. The Resend free-tier cap of 100 sends/day is likewise no longer a
constraint worth engineering around.

### 1c. Cleanup Worker (`cleanup-worker/`)

Cloudflare Pages Functions can't run Cron Triggers, so scheduled work lives in its own
standalone Worker sharing the same D1 database. It now does exactly one thing: delete
`rate_limit_counters` rows whose window has elapsed. This is not optional — a D1 table has
no equivalent of KV's `expirationTtl`, so without this tick the table grows forever.

```sh
cd cleanup-worker
wrangler deploy
```

Redeploy it any time `src/index.js` or the shared `functions/_lib/*` modules it imports
change — it does **not** get redeployed by the Pages project's git-triggered builds.

> **Migrating from the old retry worker:** this directory was `retry-worker/` and deployed
> under the name `imresidentdashboardapp-retry`. Renaming it here creates a *new* Worker
> and leaves the old one running its last-deployed code on a 3-minute cron — code that
> queries the now-dropped `magic_links` and `pending_login_emails` tables and will error
> every tick. Delete `imresidentdashboardapp-retry` in the Cloudflare dashboard
> (Workers & Pages → the worker → Settings → Delete) after deploying this one.

### 3. Connect Cloudflare Pages to this repo

Dashboard → Workers & Pages → Create → Pages → Connect to Git → select this repo.
Build command: none. Build output directory: `frontend`. Root directory: `/`.
`wrangler.toml` at the repo root (with `pages_build_output_dir`) supplies the D1 binding
and the vars automatically on every Git-triggered build.

### 4. Seed the roster

```sh
python scripts/seed_roster.py roster.csv --remote --apply
```

CSV must have `email` and `name` columns. Re-run any time the roster changes
(`INSERT OR REPLACE`, so it's safe to re-run with an updated file).

Email is still the roster's primary key even though residents never type one — it's the
one stable identifier across roster reloads, and names alone aren't unique enough to key a
table on. **The `name` column is now resident-facing**, in the sense that it is what a
resident's typed name has to resolve to. Prefer the name they'd actually write.

## QR rotation

`.github/workflows/rotate-qr.yml` runs `scripts/generate_qr.py noon learning grandrounds`
every Saturday morning, committing fresh PNGs. Tokens are anchored to the Saturday opening
the lecture week (`week_anchor`), so a run that GitHub delays by several hours still emits
the correct week's token. The commit triggers a Pages rebuild automatically.

`frontend/display-noon.html`, `display-learning.html` and `display-grandrounds.html` each
show one event's current code full-size, for projecting in that event's room.

## Local development

```sh
wrangler d1 execute attendance-db --local --file=./schema.sql
npm run dev   # wrangler pages dev frontend — D1 binding auto-detected from
              # wrangler.toml, secrets read from .dev.vars
npm test      # node --test
```

Create a `.dev.vars` file (gitignored) at the repo root with test values for
`ADMIN_SESSION_SECRET`, `QR_SECRET`, `RESEND_KEY`, `ADMIN_EXPORT_KEY`, `ADMIN_PASSWORD`,
`TURNSTILE_SECRET` and `SECURITY_ALERT_EMAIL`. Generate local test QR codes with
`QR_SECRET=<same-value-as-.dev.vars> APP_URL=http://localhost:8788 python scripts/generate_qr.py`.

## Viewing attendance

**`GET /attendance`** is a password-gated page showing a table of date, resident name and
event. Enter the `ADMIN_PASSWORD` secret once; it sets a 7-day cookie. (The rejected
sign-in and queued-email sections that used to sit below the table are gone along with the
sign-in system — residents no longer submit an email address, so there is nothing to
reject and nothing to queue.)

`GET /export` (header `X-Admin-Key: <ADMIN_EXPORT_KEY>`, optional `?since=YYYY-MM-DD`)
returns `{ok, rows: [{name, event_type, event_date, timestamp}]}`. **This shape is
load-bearing** — `scrape_attendance.py` reads it directly, so changing a key silently
breaks the daily sync. The production path is also a Cloudflare Access Service Auth
application; the downstream dashboard supplies its dedicated `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers in addition to `X-Admin-Key`. Five failed inner admin or
export authentications across all IPs within ten minutes send one security alert for that
window. This app does not compute or store point values — the downstream game dashboard
owns scoring and applies its own point weighting per event type.
