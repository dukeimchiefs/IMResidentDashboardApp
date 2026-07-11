import json
import os

import gspread
import requests

APP_URL = os.environ.get("APP_URL", "https://imresidentdashboardapp.pages.dev")
ADMIN_EXPORT_KEY = os.environ["ADMIN_EXPORT_KEY"]
GOOGLE_SERVICE_ACCOUNT_KEY = os.environ["GOOGLE_SERVICE_ACCOUNT_KEY"]
GOOGLE_SHEET_ID = os.environ["GOOGLE_SHEET_ID"]

WORKSHEET_NAME = "Attendance"
HEADER = ["name", "email", "event_type", "event_date", "timestamp"]


def fetch_attendance():
    resp = requests.get(
        f"{APP_URL}/export",
        headers={"X-Admin-Key": ADMIN_EXPORT_KEY},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Export endpoint returned an error: {data}")
    return data["rows"]


def main():
    rows = fetch_attendance()

    creds = json.loads(GOOGLE_SERVICE_ACCOUNT_KEY)
    client = gspread.service_account_from_dict(creds)
    sheet = client.open_by_key(GOOGLE_SHEET_ID)

    try:
        worksheet = sheet.worksheet(WORKSHEET_NAME)
    except gspread.WorksheetNotFound:
        worksheet = sheet.add_worksheet(title=WORKSHEET_NAME, rows=1, cols=len(HEADER))

    # Full overwrite each run — simplest way to stay a faithful mirror of D1
    # (the source of truth) without tracking sync state or dedup logic.
    worksheet.clear()
    table = [HEADER] + [[row.get(col, "") for col in HEADER] for row in rows]
    worksheet.update(range_name="A1", values=table)
    print(f"Synced {len(rows)} attendance rows to sheet {GOOGLE_SHEET_ID}")


if __name__ == "__main__":
    main()
