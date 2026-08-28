"""Temporary migration-017-only Live Activity END queue sender.

This daemon is deliberately narrower than the normal push sender:

* reads and claims only ``push_queue.kind = la_end`` rows
* uses only the queue columns available in migration 011
* deletes a token only after Apple accepts END or declares it terminally dead
* releases the exact migration-017 token lease after retry exhaustion
* never processes another queue kind and never purges queue history
* holds a local process lock, while database compare-and-set claims protect
  against a second host

It is a temporary bridge. Stop it after the pre-021 zero-count gate passes.
"""

import base64
import json
import logging
import os
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, ".env"), override=True)
load_dotenv(os.path.join(_HERE, ".enddrain017.env"), override=True)

import requests  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature  # noqa: E402

try:  # Linux production lock.
    import fcntl as _fcntl
except ImportError:  # Windows offline tests.
    _fcntl = None

try:
    import msvcrt as _msvcrt
except ImportError:
    _msvcrt = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] enddrain017: %(message)s",
)
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
APNS_P8_PATH = os.environ.get(
    "APNS_P8_PATH", os.path.join(_HERE, "apns-authkey.p8"))
APNS_KEY_ID = os.environ.get("APNS_KEY_ID", "").strip()
APPLE_TEAM_ID = os.environ.get("APPLE_TEAM_ID", "").strip()

INTERVAL_SECONDS = int(os.environ.get("ENDDRAIN017_INTERVAL_SECONDS", "20"))
LOCK_PATH = os.environ.get("ENDDRAIN017_LOCK_PATH", "/tmp/hc-enddrain017.lock")
MAX_ATTEMPTS = 5
STALE_CLAIM_MINUTES = 3
BATCH_LIMIT = 20
TOPIC_BLOCK_SECONDS = 6 * 3600
APNS_HOST = "https://api.push.apple.com"
LIVE_ACTIVITY_TOPIC = "com.hamptonscoconuts.field.push-type.liveactivity"
TERMINAL_TOKEN_REASONS = {
    "BadDeviceToken",
    "Unregistered",
    "ExpiredToken",
    "DeviceTokenNotForTopic",
}

_JWT = {"jwt": None, "at": 0.0}
_TOPIC_BLOCKED_UNTIL = 0.0


class ConsumerAlreadyRunning(RuntimeError):
    """Another copy already owns the local recovery lock."""


@contextmanager
def single_consumer_lock(path=None):
    """Hold one non-blocking OS lock for the daemon's full lifetime."""
    lock_path = Path(path or LOCK_PATH)
    handle = open(lock_path, "a+b")
    locked = False
    try:
        if _fcntl is not None:
            try:
                _fcntl.flock(handle.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
                locked = True
            except OSError as error:
                raise ConsumerAlreadyRunning(
                    "another enddrain017 process already holds the lock") from error
        elif _msvcrt is not None:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            try:
                _msvcrt.locking(handle.fileno(), _msvcrt.LK_NBLCK, 1)
                locked = True
            except OSError as error:
                raise ConsumerAlreadyRunning(
                    "another enddrain017 process already holds the lock") from error
        else:
            raise RuntimeError("this operating system has no supported file lock")
        yield
    finally:
        if locked:
            try:
                handle.seek(0)
                if _fcntl is not None:
                    _fcntl.flock(handle.fileno(), _fcntl.LOCK_UN)
                else:
                    _msvcrt.locking(handle.fileno(), _msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        handle.close()


def _now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _same_instant(left, right):
    try:
        first = datetime.fromisoformat(str(left).replace("Z", "+00:00"))
        second = datetime.fromisoformat(str(right).replace("Z", "+00:00"))
        return first == second
    except (TypeError, ValueError):
        return str(left) == str(right)


def _valid_iso(value):
    try:
        datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return True
    except (TypeError, ValueError):
        return False


def _table(name):
    return SUPABASE_URL + "/rest/v1/" + name


def _sb_headers(extras=None):
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
    }
    headers.update(extras or {})
    return headers


def _sb_select(table, params):
    try:
        response = requests.get(
            _table(table), headers=_sb_headers(), params=params, timeout=15)
        if not response.ok:
            log.error("database read failed for %s with status %s",
                      table, response.status_code)
            return None
        value = response.json()
        return value if isinstance(value, list) else None
    except Exception:
        log.exception("database read failed for %s", table)
        return None


def _sb_patch(table, params, body):
    try:
        response = requests.patch(
            _table(table),
            headers=_sb_headers({
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            }),
            params=params,
            json=body,
            timeout=15,
        )
        if not response.ok:
            log.error("database update failed for %s with status %s",
                      table, response.status_code)
            return None
        value = response.json()
        return value if isinstance(value, list) else None
    except Exception:
        log.exception("database update failed for %s", table)
        return None


def _sb_delete(table, params):
    try:
        response = requests.delete(
            _table(table),
            headers=_sb_headers({"Prefer": "return=representation"}),
            params=params,
            timeout=15,
        )
        if not response.ok:
            log.error("database delete failed for %s with status %s",
                      table, response.status_code)
            return None
        value = response.json()
        return value if isinstance(value, list) else None
    except Exception:
        log.exception("database delete failed for %s", table)
        return None


def _uuid(value):
    text = str(value or "").strip()
    try:
        uuid.UUID(text)
    except (ValueError, AttributeError, TypeError):
        return None
    return text


def _hex_token(value):
    token = str(value or "").strip().lower()
    if not 32 <= len(token) <= 512:
        return None
    if any(char not in "0123456789abcdef" for char in token):
        return None
    return token


def _end_identity(row, token=None):
    payload = row.get("payload") if isinstance(row, dict) else None
    if not isinstance(payload, dict):
        return None
    token_id = _uuid(payload.get("live_activity_token_id"))
    shift_id = _uuid(payload.get("live_activity_shift_id"))
    queue_id = _uuid(payload.get("live_activity_queue_id"))
    claim_stamp = str(
        payload.get("live_activity_end_requested_at") or "").strip()
    exact_token = _hex_token(token)
    if (not token_id or not shift_id or not queue_id or not exact_token
            or not _valid_iso(claim_stamp)
            or queue_id != str(row.get("id") or "")):
        return None
    return {
        "id": "eq." + token_id,
        "token": "eq." + exact_token,
        "token_type": "eq.activity_update",
        "shift_id": "eq." + shift_id,
        "end_queue_id": "eq." + queue_id,
        "end_requested_at": "eq." + claim_stamp,
    }


def _validate_end_row(row):
    if not isinstance(row, dict) or row.get("kind") != "la_end":
        return (None, None, None, "row is not an END queue row")
    if not _uuid(row.get("id")) or not _valid_iso(row.get("claimed_at")):
        return (None, None, None, "queue identity or claim is invalid")
    payload = row.get("payload")
    if not isinstance(payload, dict):
        return (None, None, None, "payload is not an object")
    tokens = payload.get("tokens")
    if not isinstance(tokens, list) or len(tokens) != 1:
        return (None, None, None, "exactly one token is required")
    token = _hex_token(tokens[0])
    identity = _end_identity(row, token)
    if not identity:
        return (None, None, None, "exact token identity is invalid")

    headers = payload.get("headers")
    if not isinstance(headers, dict):
        return (identity, None, None, "headers are not an object")
    if (headers.get("topic") != LIVE_ACTIVITY_TOPIC
            or headers.get("push_type") != "liveactivity"
            or headers.get("priority") != 10
            or headers.get("collapse_id") != row.get("id")):
        return (identity, None, None, "APNs headers are not the END contract")

    aps = payload.get("aps")
    if not isinstance(aps, dict) or aps.get("event") != "end":
        return (identity, headers, None, "APS event is not END")
    timestamp = aps.get("timestamp")
    dismissal = aps.get("dismissal-date")
    content = aps.get("content-state")
    if (isinstance(timestamp, bool) or not isinstance(timestamp, int)
            or isinstance(dismissal, bool) or not isinstance(dismissal, int)
            or dismissal > timestamp or not isinstance(content, dict)):
        return (identity, headers, None, "APS END content is invalid")
    return (identity, headers, aps, None)


def _exact_token_present(identity):
    rows = _sb_select("live_activity_tokens", {
        **identity,
        "select": "id",
        "limit": "1",
    })
    if rows is None:
        return None
    return bool(rows)


def _delete_exact_token(identity):
    changed = _sb_delete("live_activity_tokens", identity)
    if isinstance(changed, list) and changed:
        return True
    present = _exact_token_present(identity)
    return present is False


def _release_exact_lease(identity):
    changed = _sb_patch(
        "live_activity_tokens",
        identity,
        {"end_requested_at": None, "end_queue_id": None},
    )
    if isinstance(changed, list) and changed:
        return True
    present = _exact_token_present(identity)
    return present is False


def _queue_patch_was_applied(row, body):
    fields = set(body)
    fields.update(("id", "kind", "claimed_at", "done_at"))
    rows = _sb_select("push_queue", {
        "select": ",".join(sorted(fields)),
        "id": "eq." + str(row["id"]),
        "kind": "eq.la_end",
        "limit": "1",
    })
    if rows is None:
        return None
    if len(rows) != 1:
        return False
    current = rows[0]
    for key, expected in body.items():
        actual = current.get(key)
        if key == "done_at" and expected is not None:
            if actual is None:
                return False
        elif key == "claimed_at" and expected is not None:
            if not _same_instant(actual, expected):
                return False
        elif actual != expected:
            return False
    return True


def _patch_owned_queue(row, body):
    claim_stamp = str(row.get("claimed_at") or "")
    if not _uuid(row.get("id")) or not _valid_iso(claim_stamp):
        return False
    changed = _sb_patch("push_queue", {
        "id": "eq." + str(row["id"]),
        "kind": "eq.la_end",
        "done_at": "is.null",
        "claimed_at": "eq." + claim_stamp,
    }, body)
    if changed is True:  # Small offline-test convention.
        row.update(body)
        return True
    if isinstance(changed, list):
        if not changed:
            return False
        row.update(changed[0])
        return True
    verified = _queue_patch_was_applied(row, body)
    if verified:
        row.update(body)
    return verified is True


def _finish_queue(row, error=None, attempts=None):
    body = {
        "done_at": _now_iso(),
        "last_error": str(error)[:300] if error else None,
    }
    if attempts is not None:
        body["attempts"] = int(attempts)
    return _patch_owned_queue(row, body)


def _park_retry(row, error, increment=True):
    attempts = int(row.get("attempts") or 0) + (1 if increment else 0)
    return _patch_owned_queue(row, {
        "claimed_at": None,
        "attempts": attempts,
        "last_error": str(error)[:300],
    })


def _b64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _apns_configured():
    return bool(APNS_KEY_ID and APPLE_TEAM_ID and os.path.isfile(APNS_P8_PATH))


def _apns_jwt():
    now = time.time()
    if _JWT["jwt"] and now - _JWT["at"] < 45 * 60:
        return _JWT["jwt"]
    with open(APNS_P8_PATH, "rb") as key_file:
        key = serialization.load_pem_private_key(key_file.read(), password=None)
    header = _b64url(json.dumps(
        {"alg": "ES256", "kid": APNS_KEY_ID},
        separators=(",", ":"),
    ).encode())
    claims = _b64url(json.dumps(
        {"iss": APPLE_TEAM_ID, "iat": int(now)},
        separators=(",", ":"),
    ).encode())
    signing = header + "." + claims
    der = key.sign(signing.encode(), ec.ECDSA(hashes.SHA256()))
    r_value, s_value = decode_dss_signature(der)
    signature = r_value.to_bytes(32, "big") + s_value.to_bytes(32, "big")
    _JWT["jwt"] = signing + "." + _b64url(signature)
    _JWT["at"] = now
    return _JWT["jwt"]


def _apns_send(device_token, headers, aps, request_id):
    try:
        jwt = _apns_jwt()
        command = [
            "curl", "-s", "--http2", "--max-time", "15",
            "-o", "-", "-w", "\n%{http_code}",
            "-H", "authorization: bearer " + jwt,
            "-H", "apns-topic: " + LIVE_ACTIVITY_TOPIC,
            "-H", "apns-push-type: liveactivity",
            "-H", "apns-priority: 10",
            "-H", "apns-id: " + str(request_id),
            "-H", "apns-collapse-id: " + str(headers["collapse_id"])[:64],
            "-H", "content-type: application/json",
            "--data-binary", json.dumps({"aps": aps}),
            APNS_HOST + "/3/device/" + str(device_token),
        ]
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return (0, "curl transport failure")
        body, _, status_text = (result.stdout or "").rpartition("\n")
        try:
            status = int(status_text.strip() or "0")
        except ValueError:
            return (0, "unparseable Apple response")
        reason = ""
        if body.strip():
            try:
                reason = str((json.loads(body) or {}).get("reason", ""))
            except Exception:
                reason = "unparseable Apple body"
        return (status, reason)
    except Exception:
        log.exception("Apple END request failed locally")
        return (0, "local send failure")


def _retry_or_exhaust(row, identity, reason):
    new_attempts = int(row.get("attempts") or 0) + 1
    if new_attempts < MAX_ATTEMPTS:
        _park_retry(row, reason)
        return "retry"

    closed = _finish_queue(
        row,
        str(reason) + "; retry budget exhausted",
        attempts=new_attempts,
    )
    if not closed:
        return "finish_failed"
    if not _release_exact_lease(identity):
        log.error("retry budget ended but exact token lease release failed for %s",
                  row.get("id"))
        return "release_failed"
    return "exhausted_released"


def _process_row(row):
    global _TOPIC_BLOCKED_UNTIL

    identity, headers, aps, validation_error = _validate_end_row(row)
    if validation_error:
        closed = _finish_queue(row, "bad la_end payload: " + validation_error)
        if closed and identity is not None:
            _release_exact_lease(identity)
        return "malformed"

    present = _exact_token_present(identity)
    if present is None:
        return _retry_or_exhaust(row, identity, "exact token check unavailable")
    if present is False:
        _finish_queue(row, "exact token already absent")
        return "already_clean"

    if not _apns_configured():
        return _retry_or_exhaust(row, identity, "APNs configuration unavailable")

    token = row["payload"]["tokens"][0]
    status, reason = _apns_send(token, headers, aps, row["id"])
    if status == 200:
        cleaned = _delete_exact_token(identity)
        _finish_queue(
            row,
            None if cleaned else "Apple accepted END; exact token cleanup failed",
        )
        return "delivered" if cleaned else "delivered_cleanup_failed"

    if status == 410 or reason in TERMINAL_TOKEN_REASONS:
        cleaned = _delete_exact_token(identity)
        _finish_queue(
            row,
            ("terminal token " + str(reason or status)) if cleaned
            else "terminal token; exact cleanup failed",
        )
        return "terminal_cleaned" if cleaned else "terminal_cleanup_failed"

    if reason == "ExpiredProviderToken":
        _JWT["jwt"] = None
        return _retry_or_exhaust(
            row, identity, "Apple provider token expired; refreshing login")

    if reason in {"TopicDisallowed", "InvalidProviderToken", "BadTopic"} \
            or status == 403:
        _park_retry(
            row,
            "Live Activity topic or provider authentication rejected: " +
            str(reason or status),
            increment=False,
        )
        _TOPIC_BLOCKED_UNTIL = time.monotonic() + TOPIC_BLOCK_SECONDS
        log.critical(
            "Apple rejected the Live Activity topic or provider authentication; "
            "the rollout drain is blocked until APNs configuration is fixed")
        return "topic_blocked"

    return _retry_or_exhaust(
        row, identity, "Apple END failed: " + str(status) + " " + str(reason))


def _claim_rows(now=None):
    moment = now or datetime.now(timezone.utc)
    stale_stamp = _iso(moment - timedelta(minutes=STALE_CLAIM_MINUTES))
    ids = _sb_select("push_queue", {
        "select": "id",
        "kind": "eq.la_end",
        "done_at": "is.null",
        "attempts": "lt." + str(MAX_ATTEMPTS),
        "or": "(claimed_at.is.null,claimed_at.lt." + stale_stamp + ")",
        "order": "created_at.asc",
        "limit": str(BATCH_LIMIT),
    })
    if ids is None:
        return None

    claimed = []
    for candidate in ids:
        candidate_id = _uuid(candidate.get("id") if isinstance(candidate, dict)
                             else None)
        if not candidate_id:
            continue
        claim_stamp = _now_iso()
        rows = _sb_patch("push_queue", {
            "id": "eq." + candidate_id,
            "kind": "eq.la_end",
            "done_at": "is.null",
            "attempts": "lt." + str(MAX_ATTEMPTS),
            "or": "(claimed_at.is.null,claimed_at.lt." + stale_stamp + ")",
        }, {"claimed_at": claim_stamp})
        if isinstance(rows, list) and len(rows) == 1:
            claimed.append(rows[0])
    return claimed


def work_once():
    if time.monotonic() < _TOPIC_BLOCKED_UNTIL:
        log.error("Live Activity topic remains blocked; no END rows claimed")
        return {"claimed": 0, "blocked": True, "outcomes": {}}

    rows = _claim_rows()
    if rows is None:
        log.error("cannot read migration-017 END queue")
        return {"claimed": 0, "blocked": False, "outcomes": {"read_failed": 1}}

    outcomes = {}
    processed = 0
    for row in rows:
        outcome = _process_row(row)
        processed += 1
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        if outcome == "topic_blocked":
            break
    log.info("tick: claimed=%d processed=%d outcomes=%s",
             len(rows), processed, json.dumps(outcomes, sort_keys=True))
    return {
        "claimed": len(rows),
        "blocked": "topic_blocked" in outcomes,
        "outcomes": outcomes,
    }


def main():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY are required")
    with single_consumer_lock():
        log.info("temporary migration-017 END sender started")
        while True:
            try:
                work_once()
            except Exception:
                log.exception("END drain tick crashed; loop continues")
            time.sleep(max(5, INTERVAL_SECONDS))


if __name__ == "__main__":
    main()
