"""QA account management (milestone 5.5 Part 24).

Usage:
    python -m cli.qa_accounts mark <email>
    python -m cli.qa_accounts unmark <email>
    python -m cli.qa_accounts list

The ONLY way `users.is_qa_account` is ever written — there is no API
endpoint for it (see app/db/models_auth.py's own docstring on that
column for why). Marking/unmarking is intentionally an operator action
run against the backend's own database, never something a request from
the frontend can trigger, so no ordinary user action can flip this flag
on themselves or anyone else.

This replaces the previous informal convention of recognizing a QA
account by its email address (e.g. a naming pattern like
qa+something@edum8.us) — that convention still works today and marking
an account here changes nothing about how it authenticates or what it
can do; this is purely a label for cleanup verification and test-data
reporting scripts to key off, so they no longer have to pattern-match
an email string.
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import select

from app.config import get_settings
from app.core.email_normalization import normalize_email
from app.db.models_auth import User
from app.db.session import get_session_factory


def _find_user(db, email: str) -> User | None:
    normalized = normalize_email(email)
    return db.execute(select(User).where(User.email == normalized)).scalar_one_or_none()


def cmd_mark(args: argparse.Namespace) -> int:
    with get_session_factory()() as db:
        user = _find_user(db, args.email)
        if user is None:
            print(f"No user found with email '{args.email}'.", file=sys.stderr)
            return 1
        if user.is_qa_account:
            print(f"{user.email} is already marked as a QA account.")
            return 0
        user.is_qa_account = True
        db.commit()
        print(f"Marked {user.email} (user_id={user.id}) as a QA account.")
    return 0


def cmd_unmark(args: argparse.Namespace) -> int:
    with get_session_factory()() as db:
        user = _find_user(db, args.email)
        if user is None:
            print(f"No user found with email '{args.email}'.", file=sys.stderr)
            return 1
        if not user.is_qa_account:
            print(f"{user.email} is not marked as a QA account.")
            return 0
        user.is_qa_account = False
        db.commit()
        print(f"Unmarked {user.email} (user_id={user.id}) — no longer a QA account.")
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    with get_session_factory()() as db:
        users = (
            db.execute(select(User).where(User.is_qa_account.is_(True)).order_by(User.email))
            .scalars()
            .all()
        )
    if not users:
        print("No accounts are currently marked as QA accounts.")
        return 0
    print(f"{len(users)} QA account(s):\n")
    for user in users:
        print(f"{user.id}  {user.email}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m cli.qa_accounts",
        description="Mark/unmark/list QA accounts (users.is_qa_account).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    mark_parser = subparsers.add_parser("mark", help="Mark an existing account as a QA account.")
    mark_parser.add_argument("email")
    mark_parser.set_defaults(func=cmd_mark)

    unmark_parser = subparsers.add_parser("unmark", help="Unmark a QA account.")
    unmark_parser.add_argument("email")
    unmark_parser.set_defaults(func=cmd_unmark)

    list_parser = subparsers.add_parser("list", help="List every QA-marked account.")
    list_parser.set_defaults(func=cmd_list)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    get_settings()  # fail fast if the environment is misconfigured
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
