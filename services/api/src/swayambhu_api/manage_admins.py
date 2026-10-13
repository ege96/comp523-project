"""Add, list, and remove admins from the command line.

    python -m swayambhu_api.manage_admins add someone@example.org
    python -m swayambhu_api.manage_admins list
    python -m swayambhu_api.manage_admins remove someone@example.org

`add` invites by email. The person becomes an admin the first time they sign in with
Firebase using that email, once Firebase reports the email as verified.
"""

import argparse
import sys
from collections.abc import Sequence
from typing import TextIO

from swayambhu_api.admins import AdminStore, SqlAlchemyAdminStore
from swayambhu_api.config import get_settings
from swayambhu_api.db import new_session


def run(argv: Sequence[str], store: AdminStore, out: TextIO = sys.stdout) -> int:
    parser = argparse.ArgumentParser(prog="python -m swayambhu_api.manage_admins")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("add", help="invite an admin by email").add_argument("email")
    commands.add_parser("remove", help="remove an admin by email").add_argument("email")
    commands.add_parser("list", help="list admins")
    args = parser.parse_args(argv)

    if args.command == "add":
        email = args.email.strip()
        if "@" not in email:
            print(f"Not an email address: {email}", file=out)
            return 2
        admin = store.add(email)
        if admin is None:
            print(f"{email} is already an admin", file=out)
            return 1
        print(f"Added admin {admin.email}. They get access on first sign-in.", file=out)
    elif args.command == "remove":
        if not store.remove(args.email):
            print(f"No admin with email {args.email}", file=out)
            return 1
        print(f"Removed admin {args.email}", file=out)
    else:
        for admin in store.list():
            print(admin.email, file=out)
    return 0


def main() -> int:  # pragma: no cover - thin wrapper around run()
    with new_session(get_settings()) as session:
        return run(sys.argv[1:], SqlAlchemyAdminStore(session))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
