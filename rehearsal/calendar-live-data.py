"""Reviewed, read-only HC Calendar database checks. Never load .env files.

The caller must supply the pooler hostname observed in the Supabase dashboard.
No connection or credential read occurs on import. The command line supports
only a single reviewed read query, not deployment or data updates.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
from datetime import date, datetime
from decimal import Decimal
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import sys
from uuid import UUID


PROJECT_ID = "omdcfphbwuwsrffdszlg"
PROJECT_USER = f"postgres.{PROJECT_ID}"
VERIFIED_HOST = "aws-1-us-west-2.pooler.supabase.com"
CREDENTIAL_TARGET = f"Hamptons Coconuts:Supabase DB:{PROJECT_ID}"
PSYCOPG_VERSION = "3.3.5"
# Downloaded over verified HTTPS from the certificate link in the official
# authenticated Supabase dashboard. This pins the entire unmodified file.
EXPECTED_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
MAX_QUERY_BYTES = 1024 * 1024
MAX_RESULT_ROWS = 10000


class CalendarDataError(RuntimeError):
    """Only fixed, credential-free messages belong in this exception."""


class _Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def _saved_password() -> str:
    """Read only the exact Windows credential and release its native buffer."""
    if os.name != "nt":
        raise CalendarDataError("This helper requires Windows Credential Manager.")
    try:
        credential_api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        credential_api.CredReadW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            ctypes.POINTER(ctypes.POINTER(_Credential)),
        ]
        credential_api.CredReadW.restype = wintypes.BOOL
        credential_api.CredFree.argtypes = [ctypes.c_void_p]
        credential_api.CredFree.restype = None
        pointer = ctypes.POINTER(_Credential)()
        if not credential_api.CredReadW(CREDENTIAL_TARGET, 1, 0, ctypes.byref(pointer)):
            raise CalendarDataError("The exact saved HC database credential is unavailable.")
        try:
            credential = pointer.contents
            size = credential.CredentialBlobSize
            if (credential.Type != 1 or credential.TargetName != CREDENTIAL_TARGET
                    or size == 0 or size > 4096):
                raise CalendarDataError("The saved HC credential has an unexpected format.")
            password_bytes = bytearray(ctypes.string_at(credential.CredentialBlob, size))
            try:
                # This exact saved generic credential was checked in memory:
                # its odd-length blob is valid UTF-8, not UTF-16. CredReadW
                # names the target with Unicode but does not define blob encoding.
                password = password_bytes.decode("utf-8")
                if not password or "\x00" in password:
                    raise CalendarDataError("The saved HC credential has an unexpected format.")
                return password
            finally:
                # Clear our mutable copy. Python strings remain memory-only but
                # cannot be guaranteed to be immediately erased by Python.
                password_bytes[:] = b"\x00" * len(password_bytes)
        finally:
            credential_api.CredFree(pointer)
    except CalendarDataError:
        raise
    except Exception:
        raise CalendarDataError("Could not securely read the saved HC credential.") from None


def load_driver(dependency_dir: str):
    """Load only the pinned client from the explicitly supplied local folder."""
    path = Path(dependency_dir)
    if not path.is_absolute() or not path.is_dir():
        raise CalendarDataError("Pass the absolute temporary database-client folder.")
    path = path.resolve(strict=True)
    sys.path.insert(0, str(path))
    try:
        driver = importlib.import_module("psycopg")
        binary = importlib.import_module("psycopg_binary")
        for module in (driver, binary):
            if not Path(module.__file__).resolve().is_relative_to(path):
                raise CalendarDataError("The database client came from an unexpected folder.")
            if module.__version__ != PSYCOPG_VERSION:
                raise CalendarDataError("The database client version is not the reviewed version.")
        return driver
    except CalendarDataError:
        raise
    except Exception:
        raise CalendarDataError("The pinned temporary database client could not load.") from None


def validate_destination(host: str, user: str = PROJECT_USER) -> None:
    if user != PROJECT_USER:
        raise CalendarDataError("Refusing a database user outside the exact HC project.")
    if host != VERIFIED_HOST:
        raise CalendarDataError("Refusing a server other than the verified HC Supabase pooler.")


@contextmanager
def _without_pg_environment():
    """Do not let ambient libpq settings redirect this single-purpose client.

    The command is single-threaded. No environment file is opened or changed.
    """
    previous = {key: value for key, value in os.environ.items() if key.upper().startswith("PG")}
    for key in previous:
        os.environ.pop(key, None)
    try:
        yield
    finally:
        os.environ.update(previous)


def trusted_certificate(ca_file: str | None = None) -> Path:
    if ca_file is not None:
        path = Path(ca_file)
        if (not path.is_absolute() or path.suffix.lower() not in {".crt", ".pem"}
                or path.name.lower().startswith(".env")):
            raise CalendarDataError("Pass the absolute approved Supabase certificate file.")
        path = path.resolve(strict=True)
        if not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise CalendarDataError("The approved certificate file is unavailable or invalid.")
        if hashlib.sha256(path.read_bytes()).hexdigest() != EXPECTED_CA_SHA256:
            raise CalendarDataError("The certificate does not match the verified Supabase certificate.")
        return path
    try:
        import certifi
        return Path(certifi.where()).resolve(strict=True)
    except Exception:
        raise CalendarDataError("The trusted TLS certificate bundle is unavailable.") from None


def connect(host: str, dependency_dir: str, user: str = PROJECT_USER, ca_file: str | None = None):
    """Return an HC-only connection already inside a read-only transaction.

    Callers must close it. This function deliberately offers no write mode.
    """
    validate_destination(host, user)
    driver = load_driver(dependency_dir)
    certificate_file = trusted_certificate(ca_file)
    password = _saved_password()
    connection = None
    try:
        with _without_pg_environment():
            connection = driver.connect(
                host=host,
                port=5432,
                dbname="postgres",
                user=user,
                password=password,
                passfile=os.devnull,
                sslmode="verify-full",
                sslrootcert=str(certificate_file),
                gssencmode="disable",
                connect_timeout=15,
                application_name="hc-calendar-read-preflight",
                options="-c statement_timeout=30000 -c default_transaction_read_only=on",
                autocommit=False,
                row_factory=driver.rows.dict_row,
            )
        connection.read_only = True
        connection.execute("SET TRANSACTION READ ONLY")
        state = connection.execute("SHOW transaction_read_only").fetchone()
        if state != {"transaction_read_only": "on"}:
            raise CalendarDataError("The database did not confirm a read-only transaction.")
        return connection
    except Exception:
        if connection is not None:
            connection.close()
        raise CalendarDataError("The secure read-only HC database connection failed.") from None
    finally:
        password = None


def read_query(host: str, dependency_dir: str, sql_file: str, user: str = PROJECT_USER,
               ca_file: str | None = None):
    path = Path(sql_file).resolve(strict=True)
    if (path.suffix.lower() != ".sql" or path.name.startswith(".env")
            or not path.is_file() or path.stat().st_size > MAX_QUERY_BYTES):
        raise CalendarDataError("Pass a reviewed SQL file smaller than one megabyte.")
    query = path.read_text(encoding="utf-8-sig")
    if not query.strip():
        raise CalendarDataError("The reviewed SQL file is empty.")
    connection = connect(host, dependency_dir, user, ca_file)
    try:
        with connection.cursor() as cursor:
            # A prepared query permits only one statement. A file cannot end
            # the read-only transaction and append a write in a second one.
            cursor.execute(query, prepare=True)
            if cursor.description is None:
                raise CalendarDataError("The reviewed query must return rows.")
            rows = cursor.fetchmany(MAX_RESULT_ROWS + 1)
            if len(rows) > MAX_RESULT_ROWS:
                raise CalendarDataError("The query returned too many rows; narrow the read.")
            return rows
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()


def _json_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (Decimal, UUID)):
        return str(value)
    raise TypeError("The read query returned an unsupported value type.")


def new_output_path(output_file: str) -> Path:
    path = Path(output_file)
    if not path.is_absolute() or not re.fullmatch(r"calendar-[a-z0-9-]+\.json", path.name):
        raise CalendarDataError("Pass an absolute Calendar JSON output filename.")
    directory = Path(__file__).resolve().parents[2] / "output"
    path = path.resolve(strict=False)
    if path.parent != directory.resolve(strict=True) or path.exists():
        raise CalendarDataError("Output must be a new file in this workspace's output folder.")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--user", default=PROJECT_USER, choices=[PROJECT_USER])
    parser.add_argument("--dependency-dir", required=True)
    parser.add_argument("--mode", required=True, choices=["read-query"])
    parser.add_argument("--sql-file", required=True)
    parser.add_argument("--ca-file")
    parser.add_argument("--output-file")
    args = parser.parse_args()
    try:
        output_path = new_output_path(args.output_file) if args.output_file else None
        rows = read_query(args.host, args.dependency_dir, args.sql_file, args.user, args.ca_file)
        result = json.dumps({"ok": True, "rows": rows}, default=_json_value, ensure_ascii=False)
        if output_path is not None:
            # Exclusive creation also prevents overwrites if another process
            # creates the destination after our earlier path check.
            with output_path.open("x", encoding="utf-8", newline="\n") as output:
                output.write(result + "\n")
            print(json.dumps({"ok": True, "row_count": len(rows), "output_file": str(output_path)}))
        else:
            print(result)
        return 0
    except Exception as error:
        # Never echo raw driver exceptions, SQL text, connection strings, or parameters.
        state = getattr(error, "sqlstate", None)
        safe_state = state if isinstance(state, str) and re.fullmatch(r"[A-Z0-9]{5}", state) else None
        safe_message = str(error) if isinstance(error, CalendarDataError) else "Read-only database check failed."
        print(json.dumps({"ok": False, "error": safe_message,
                          "error_type": type(error).__name__, "sqlstate": safe_state}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
