import argparse
import csv
import os
import subprocess
import sys

SQL_OUT_PATH = os.path.join(os.path.dirname(__file__), "_seed_roster.sql")


def build_sql(csv_path: str) -> str:
    statements = []
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            email = row["email"].strip().lower().replace("'", "''")
            name = row["name"].strip().replace("'", "''")
            statements.append(
                f"INSERT OR REPLACE INTO roster (email, name) VALUES ('{email}', '{name}');"
            )
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
