import hashlib
import hmac
import os
import sys
from datetime import date, datetime, timedelta
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import qrcode

QR_SECRET = os.environ["QR_SECRET"]
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "assets", "qr")

# The QR now encodes a full check-in URL rather than the bare "<type>:<token>"
# payload the old in-app scanner read. That is the whole point of the rewrite: a
# phone's built-in camera turns a URL into a tappable link and opens the form
# directly, whereas a bare payload shows up as meaningless text and opens
# nothing. Override with APP_URL when generating codes for a preview deployment.
APP_URL = os.environ.get("APP_URL", "https://imresidentdashboardapp.pages.dev").rstrip("/")

# Must mirror QR_PREFIXES in functions/_lib/eventTypes.js — adding a new event type
# means updating both.
EVENT_TYPES = ["noon", "learning", "grandrounds"]

# Lecture QRs rotate weekly instead of daily: the token is HMAC'd against the
# Saturday opening the week, so one code covers Mon–Fri. Must mirror
# WEEKLY_TYPES in functions/_lib/eventTypes.js.
WEEKLY_TYPES = {"noon", "learning", "grandrounds"}

TOKEN_HEX_LENGTH = 16  # must match TOKEN_HEX_LENGTH in functions/_lib/token.js

# A URL is roughly three times longer than the old bare payload, which pushes the
# symbol up a few QR versions — more modules in the same printed area, so each
# module is physically smaller and harder to read from the back of a lecture
# hall. box_size is raised from qrcode's default of 10 to keep the exported PNG
# large enough that projecting or printing it big doesn't resample the modules
# into mush. Error correction stays at the default M: raising it would add
# modules back and make the distance problem worse, and these codes are shown on
# clean screens rather than scuffed printouts.
QR_BOX_SIZE = 14
QR_BORDER = 4


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


def checkin_url(event_type: str, token: str) -> str:
    """The address the QR encodes.

    The two halves of the old "<type>:<token>" payload become separate query
    parameters; functions/checkin.js rejoins them before validating. Splitting
    them keeps the event readable in the camera's link preview, so a resident can
    see they are about to open "noon" and not something unexpected.
    """
    return f"{APP_URL}/checkin?" + urlencode({"e": event_type, "t": token})


VALID_EVENT_TYPES = set(EVENT_TYPES)


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
        if event_type in WEEKLY_TYPES:
            token_date = week_anchor(date_str)
        else:
            token_date = date_str
        token = compute_token(token_date, event_type)
        url = checkin_url(event_type, token)
        img = qrcode.QRCode(box_size=QR_BOX_SIZE, border=QR_BORDER)
        img.add_data(url)
        img.make(fit=True)
        # Fixed filenames, overwritten on each run — a stale QR simply stops matching
        # the Worker's recomputed token, so no archive/history is needed.
        out_path = os.path.join(OUTPUT_DIR, f"qr_{event_type}.png")
        img.make_image().save(out_path)
        print(f"{event_type}: {url} -> {out_path}")


if __name__ == "__main__":
    main()
