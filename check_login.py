"""
TableTap login checker (read-only, safe).

Tells you whether an email + password would log in, and WHY if not.
Nothing is ever changed in the database.

Usage:
    python check_login.py                      -> lists all accounts
    python check_login.py you@mail.com secret  -> tests that login
    python check_login.py you@mail.com         -> prompts for the password
"""
import sys
import getpass
import sqlite3

import app_paths
from werkzeug.security import check_password_hash

DB = app_paths.DATA_DIR + "/tabletap.db"


def conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def list_accounts():
    c = conn()
    rows = c.execute(
        "SELECT id, email, name, role, active, restaurant_id FROM users ORDER BY id"
    ).fetchall()
    if not rows:
        print("No accounts yet - open the app and finish the setup screen first.")
        return
    print("\n  TableTap accounts (%d):\n" % len(rows))
    print("  %-30s %-10s %-8s %s" % ("EMAIL", "ROLE", "ACTIVE", "RESTAURANT"))
    print("  " + "-" * 62)
    for u in rows:
        rest = "platform (all)" if u["restaurant_id"] is None else "rid=%s" % u["restaurant_id"]
        print("  %-30s %-10s %-8s %s" % (
            u["email"], u["role"], "yes" if u["active"] else "NO (disabled)", rest))
    print("\n  To test one:  python check_login.py <email> <password>\n")


def check(email, password):
    email = (email or "").strip().lower()
    c = conn()
    u = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    print("")
    if u is None:
        print("  RESULT: WRONG  --  no account has the email '%s'" % email)
        print("  (emails are case-insensitive; check for typos / extra spaces)")
        list_accounts()
        return 1

    ok = check_password_hash(u["password_hash"], password or "")
    if ok and u["active"]:
        print("  RESULT: CORRECT  --  '%s' can log in." % email)
        print("           role: %s   name: %s" % (u["role"], u["name"]))
        return 0
    if ok and not u["active"]:
        print("  RESULT: password is CORRECT, but the account is DISABLED.")
        return 2
    print("  RESULT: WRONG  --  email found, but the password does not match.")
    print("           (the stored password is scrypt-hashed and cannot be read back)")
    return 1


def main():
    args = sys.argv[1:]
    if not args:
        list_accounts()
        return
    email = args[0]
    password = args[1] if len(args) > 1 else getpass.getpass("Password: ")
    sys.exit(check(email, password))


if __name__ == "__main__":
    main()
