import argparse
import csv
import os
import subprocess
import sys

SQL_OUT_PATH = os.path.join(os.path.dirname(__file__), "_seed_roster.sql")


def build_sql(csv_path: str) -> str:
    statements = []
    skipped = []
    # utf-8-sig quietly strips a leading BOM if present (common in
    # Excel-exported CSVs) instead of leaving it stuck to the first header name.
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        # Column names are matched case-insensitively so "Name"/"Email" and
        # "name"/"email" headers both work without editing the source file.
        lower_fieldnames = {name.lower(): name for name in reader.fieldnames}
        email_col = lower_fieldnames.get("email")
        name_col = lower_fieldnames.get("name")
        if not email_col or not name_col:
            raise ValueError(f"CSV must have 'email' and 'name' columns, found: {reader.fieldnames}")

        for row in reader:
            raw_email = row[email_col].strip()
            name = row[name_col].strip().replace("'", "''")
            if "@" not in raw_email:
                skipped.append((name, raw_email))
                continue
            email = raw_email.lower().replace("'", "''")
            statements.append(
                f"INSERT OR REPLACE INTO roster (email, name) VALUES ('{email}', '{name}');"
            )

    if skipped:
        print(f"Skipping {len(skipped)} row(s) without a valid email:")
        for name, raw_email in skipped:
            print(f"  - {name}: {raw_email!r}")

    return "\n".join(statements) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Import a roster CSV (email,name columns) into D1.")
    parser.add_argument("csv_path", help="Path to roster CSV with 'email' and 'name' columns")
    parser.add_argument("--database", default="attendance-db", help="D1 database name (default: attendance-db)")
    parser.add_argument("--remote", action="store_true", help="Apply to the remote D1 database instead of local dev")
    parser.add_argument("--apply", action="store_true", help="Run wrangler d1 execute immediately instead of just writing the SQL file")
    args = parser.parse_args()

    sql = build_sql(args.csv_path)
    with open(SQL_OUT_PATH, "w") as f:
        f.write(sql)
    print(f"Wrote {SQL_OUT_PATH}")

    cmd = ["wrangler", "d1", "execute", args.database, "--file", SQL_OUT_PATH]
    cmd.append("--remote" if args.remote else "--local")

    if args.apply:
        subprocess.run(cmd, check=True)
    else:
        print("Review the generated SQL, then run:")
        print("  " + " ".join(cmd))


if __name__ == "__main__":
    sys.exit(main())
