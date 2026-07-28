import hashlib
import hmac
import os
import sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import qrcode

QR_SECRET = os.environ["QR_SECRET"]
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "assets", "qr")

# Must mirror QR_PREFIXES in functions/_lib/eventTypes.js — adding a new event type
# means updating both.
EVENT_TYPES = ["noon", "learning", "grandrounds"]

# Lecture QRs rotate weekly instead of daily: the token is HMAC'd against the
# Saturday opening the week, so one code covers Mon–Fri. Must mirror
# WEEKLY_TYPES in functions/_lib/eventTypes.js.
WEEKLY_TYPES = {"noon", "learning", "grandrounds"}

# Event types whose QR is a single static image valid across a multi-day window
# instead of rotating daily. Must mirror MULTI_DAY_WINDOWS in functions/_lib/eventTypes.js.
MULTI_DAY_WINDOWS = {
    "welcome": {"anchor_date": "2026-07-17", "valid_days": 21},
}

TOKEN_HEX_LENGTH = 16  # must match TOKEN_HEX_LENGTH in functions/_lib/token.js


def today_et() -> str:
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def week_anchor(date_str: str) -> str:
    """Saturday opening the lecture week containing date_str.

    Must match weekAnchor() in functions/_lib/token.js exactly. Anchoring to the
    week rather than to the run date means a delayed rotation run still emits
    the current week's token instead of a QR the Worker will reject.
    """
    d = date.fromisoformat(date_str)
    days_since_saturday = (d.weekday() + 2) % 7  # Mon=2, … Fri=6, Sat=0, Sun=1
    return (d - timedelta(days=days_since_saturday)).isoformat()


def compute_token(date_str: str, event_type: str) -> str:
    message = f"{date_str}:{event_type}".encode()
    digest = hmac.new(QR_SECRET.encode(), message, hashlib.sha256).hexdigest()
    return digest[:TOKEN_HEX_LENGTH]


VALID_EVENT_TYPES = set(EVENT_TYPES) | set(MULTI_DAY_WINDOWS)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    date_str = today_et()
    # Which event types to (re)generate this run. Defaults to all of them, but callers
    # (e.g. the daily vs. weekly GitHub Actions workflows) pass an explicit subset so a
    # weekly-only event's QR isn't needlessly regenerated and committed every day.
    types_to_generate = sys.argv[1:] or EVENT_TYPES
    # event_type feeds directly into an output filename below (and, via the
    # GitHub Actions workflow_dispatch input, can originate outside this repo's
    # own hardcoded call sites) — reject anything not on the known list before
    # it's used for a path, rather than trusting arbitrary CLI input.
    unknown = [t for t in types_to_generate if t not in VALID_EVENT_TYPES]
    if unknown:
        sys.exit(f"Unknown event type(s): {', '.join(unknown)}. Valid: {', '.join(sorted(VALID_EVENT_TYPES))}")
    for event_type in types_to_generate:
        window = MULTI_DAY_WINDOWS.get(event_type)
        if window:
            token_date = window["anchor_date"]
        elif event_type in WEEKLY_TYPES:
            token_date = week_anchor(date_str)
        else:
            token_date = date_str
        token = compute_token(token_date, event_type)
        payload = f"{event_type}:{token}"
        img = qrcode.make(payload)
        # Fixed filenames, overwritten on each run — a stale QR simply stops matching
        # the Worker's recomputed token, so no archive/history is needed.
        out_path = os.path.join(OUTPUT_DIR, f"qr_{event_type}.png")
        img.save(out_path)
        print(f"{event_type}: {payload} -> {out_path}")


if __name__ == "__main__":
    main()
