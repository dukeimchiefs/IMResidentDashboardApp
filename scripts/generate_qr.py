import hashlib
import hmac
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import qrcode

QR_SECRET = os.environ["QR_SECRET"]
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "assets", "qr")

# Must mirror QR_PREFIXES in functions/_lib/eventTypes.js — adding a new event type
# means updating both.
EVENT_TYPES = ["noon", "learning", "grandrounds"]

TOKEN_HEX_LENGTH = 16  # must match TOKEN_HEX_LENGTH in functions/_lib/token.js


def today_et() -> str:
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def compute_token(date_str: str, event_type: str) -> str:
    message = f"{date_str}:{event_type}".encode()
    digest = hmac.new(QR_SECRET.encode(), message, hashlib.sha256).hexdigest()
    return digest[:TOKEN_HEX_LENGTH]


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    date_str = today_et()
    # Which event types to (re)generate this run. Defaults to all of them, but callers
    # (e.g. the daily vs. weekly GitHub Actions workflows) pass an explicit subset so a
    # weekly-only event's QR isn't needlessly regenerated and committed every day.
    types_to_generate = sys.argv[1:] or EVENT_TYPES
    for event_type in types_to_generate:
        token = compute_token(date_str, event_type)
        payload = f"{event_type}:{token}"
        img = qrcode.make(payload)
        # Fixed filenames, overwritten on each run — a stale QR simply stops matching
        # the Worker's recomputed token, so no archive/history is needed.
        out_path = os.path.join(OUTPUT_DIR, f"qr_{event_type}.png")
        img.save(out_path)
        print(f"{event_type}: {payload} -> {out_path}")


if __name__ == "__main__":
    main()
