"""pushdrain.py - drains the Supabase push_queue table to Apple (APNs).

WHY THIS EXISTS: the Claudia Cloudflare worker composes every owner
push (clock-in banners, stop alerts, clock-out banners, Live Activity
start/update/end) but CANNOT deliver them: Workers fetch speaks
HTTP/1.1 to Apple and api.push.apple.com requires HTTP/2, so every
direct send 500s. curl --http2 from this droplet is the proven road.
The worker now INSERTs one row per push into public.push_queue
(migration 011 in hc-dashboard) and this daemon:

  every 20 seconds:
    1. expires rows older than 15 minutes (pushes are perishable):
       Telegram fallback only when no phone already succeeded; an expired
       la_end releases its phone lease for the later five-minute scan.
    2. reads up to 20 candidates, then claims and processes each row just in
       time (attempts < 5, unclaimed or stale-claimed), sending the payload's
       aps to every remaining device token via curl --http2.
       - each 200 removes only that phone from the queue retry payload
       - 410 / BadDeviceToken /
         Unregistered / ExpiredToken    -> delete that token row
         (push_tokens for kind=alert, live_activity_tokens otherwise)
       - partial success                -> retry only failed phones; never
                                          duplicate successful phones or send
                                          the row's Telegram fallback
       - la_end 200 or terminal dead    -> delete that exact activity token;
                                          queue insertion alone never deletes
       - all tokens dead or none        -> Telegram fallback; done on
         success (or when no fallback is configured); a WANTED fallback
         that Telegram refuses leaves the row undone so the next loop
         and the 15-minute sweep keep retrying it
       - Live Activity topic rejected   -> block la_* sends 6h, alert
         the owner once, close the row (LA is cosmetic, no fallback)
       - anything else                  -> attempts+1, un-claim, retry;
         on the 5th failure Telegram fallback, then done
    3. logs one heartbeat line with the queue depth; 10 straight
       failed queue reads -> Telegram alert to the owner.
    4. hourly, purges done rows older than 7 days.

RUN (systemd): installed as pushdrain.service (same conventions as
outlook-poller.service). Manual test run:
    sudo -u jarvis /opt/jarvis-invoice-bot/.venv/bin/python /opt/jarvis-invoice-bot/pushdrain.py

SAFE ROLLOUT ORDER: apply migrations 024 and 027 first, configure the current
outbox key and Telegram token on the droplet, install/restart this drainer,
verify its startup log, then deploy the compatible Worker and enable providers.
This version filters on columns created by 027 and must not run before 027.

ENV (loaded from /opt/jarvis-invoice-bot/.env, then optionally
overridden by /opt/jarvis-invoice-bot/.pushdrain.env if that exists):
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (already in the Jarvis .env)
    TELEGRAM_BOT_TOKEN                   (already there; Telegram sender only)
    TELEGRAM_OWNER_ID                    (already there; daemon-health alerts,
                                          comma-separated)
    WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT
                      required `<version>:<base64-32-byte-key>` for provider
                      alert rows
    WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS
                      optional prior version during a key rotation
    APNS_P8_PATH      path to the .p8 key file
                      (default /opt/jarvis-invoice-bot/apns-authkey.p8)
    APNS_KEY_ID       10-char key id from the .p8 filename
    APPLE_TEAM_ID     Apple developer team id
    PUSHDRAIN_INTERVAL_SECONDS  loop sleep, default 20
    PUSHDRAIN_ALERT_COOLDOWN    owner-alert cooldown seconds, default 21600

DEPS: requests, python-dotenv, cryptography (all in requirements.txt),
plus the system curl binary (HTTP/2 capable, stock on this droplet).
Without the three APNS_* vars the daemon still runs in
Telegram-fallback-only mode: alert rows skip straight to Telegram. Legacy
rows carry plaintext fallback fields; provider-webhook rows carry one
AES-GCM-encrypted destination and message. Live Activity rows just close.
Restart after adding the APNs settings.
"""

import base64
import json
import logging
import os
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

# Env FIRST, then the optional overlay, before anything reads os.environ.
_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, ".env"), override=True)
load_dotenv(os.path.join(_HERE, ".pushdrain.env"), override=True)  # optional; missing file is a no-op

import requests  # noqa: E402  (kept after load_dotenv to match house import order)
from cryptography.exceptions import InvalidTag  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] pushdrain: %(message)s",
)
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_OWNER_ID = os.environ.get("TELEGRAM_OWNER_ID", "").strip()
WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT = os.environ.get(
    "WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT", "").strip()
WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS = os.environ.get(
    "WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS", "").strip()
APNS_P8_PATH = os.environ.get("APNS_P8_PATH", os.path.join(_HERE, "apns-authkey.p8"))
APNS_KEY_ID = os.environ.get("APNS_KEY_ID", "").strip()
APPLE_TEAM_ID = os.environ.get("APPLE_TEAM_ID", "").strip()

INTERVAL_SECONDS = int(os.environ.get("PUSHDRAIN_INTERVAL_SECONDS", "20"))
MAX_ATTEMPTS = 5          # per row, spread across loops (~100s worst case)
EXPIRE_MINUTES = 15       # pushes are perishable past this age
STALE_CLAIM_MINUTES = 3   # a claim older than this means we died mid-row
BATCH_LIMIT = 20
PURGE_AFTER_DAYS = 7
APNS_HOST = "https://api.push.apple.com"

# True only when all three APNs settings exist AND the key file is on
# disk at startup. False = Telegram-fallback-only mode (see docstring).
_APNS_CONFIGURED = bool(APNS_KEY_ID and APPLE_TEAM_ID and os.path.isfile(APNS_P8_PATH))

# ── owner alerts (copied from outlook_poller's _alert_owner pattern:
# cooldown state file, fail-open, never raises) ──────────────────────
_ALERT_STATE = Path(__file__).parent / ".pushdrain_alert_state"
_ALERT_COOLDOWN_SECONDS = int(os.environ.get("PUSHDRAIN_ALERT_COOLDOWN", str(6 * 3600)))


def _alert_due(kind: str, now: float, state_path: Path) -> bool:
    """Cooldown check per alert kind, JSON state file. On ANY exception
    returns True: a possibly-duplicate alert beats a silently-dropped
    one. This check is read-only; delivery records the timestamp. Never
    raises."""
    try:
        state = json.loads(state_path.read_text() or "{}") if state_path.exists() else {}
        last = float(state.get(kind, 0))
        return now - last >= _ALERT_COOLDOWN_SECONDS
    except Exception:
        return True


def _mark_alert_sent(kind: str, now: float, state_path: Path) -> None:
    """Record cooldown only after at least one Telegram send was accepted."""
    try:
        state = json.loads(state_path.read_text() or "{}") if state_path.exists() else {}
        state[kind] = now
        state_path.write_text(json.dumps(state))
    except Exception:
        log.exception("failed recording owner-alert cooldown for %s", kind)


def _alert_owner(kind: str, text: str) -> None:
    """Best-effort Telegram alert to the bot owner(s). Never raises;
    failure to alert must not break the drain loop."""
    try:
        if not TELEGRAM_BOT_TOKEN or not TELEGRAM_OWNER_ID:
            log.warning("alert wanted but TELEGRAM creds unset: %s", text)
            return
        now = time.time()
        if not _alert_due(kind, now, _ALERT_STATE):
            return
        accepted = False
        for chat_id in [o.strip() for o in TELEGRAM_OWNER_ID.split(",") if o.strip()]:
            try:
                resp = requests.post(
                    f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                    json={"chat_id": chat_id, "text": text},
                    timeout=10,
                )
                if resp.ok:
                    accepted = True
                else:
                    log.error("owner alert to %s -> %s %s", chat_id,
                              resp.status_code, resp.text[:200])
            except Exception:
                log.exception("failed sending owner alert to %s", chat_id)
        if accepted:
            _mark_alert_sent(kind, now, _ALERT_STATE)
    except Exception:
        log.exception("_alert_owner failed (drain loop continues)")


# ── Supabase REST helpers (service role; guarded like the worker's
# fetchSb: a read returns a list OR None, and None means the read
# FAILED, never "empty") ─────────────────────────────────────────────
def _sb_headers(extra=None):
    h = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
    }
    if extra:
        h.update(extra)
    return h


def _table(name):
    return SUPABASE_URL + "/rest/v1/" + name


def _iso(dt) -> str:
    """UTC timestamp Postgres accepts, with no '+' to keep URLs simple."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _now_iso() -> str:
    return _iso(datetime.now(timezone.utc))


def _sb_select(table, params):
    try:
        resp = requests.get(_table(table), headers=_sb_headers(), params=params, timeout=15)
        if not resp.ok:
            log.error("supabase read %s -> %s %s", table, resp.status_code, resp.text[:200])
            return None
        rows = resp.json()
        return rows if isinstance(rows, list) else None
    except Exception:
        log.exception("supabase read failed: %s", table)
        return None


def _sb_patch(table, params, body, want_rows=False):
    """PATCH; returns the updated rows when want_rows, else True/False."""
    try:
        headers = _sb_headers({"Content-Type": "application/json"})
        if want_rows:
            headers["Prefer"] = "return=representation"
        resp = requests.patch(_table(table), headers=headers, params=params,
                              data=json.dumps(body), timeout=15)
        if not resp.ok:
            log.error("supabase patch %s -> %s %s", table, resp.status_code, resp.text[:200])
            return None if want_rows else False
        if want_rows:
            rows = resp.json()
            return rows if isinstance(rows, list) else None
        return True
    except Exception:
        log.exception("supabase patch failed: %s", table)
        return None if want_rows else False


def _sb_delete(table, params) -> bool:
    try:
        resp = requests.delete(_table(table), headers=_sb_headers(), params=params, timeout=15)
        if not resp.ok:
            log.error("supabase delete %s -> %s %s", table, resp.status_code, resp.text[:200])
        return resp.ok
    except Exception:
        log.exception("supabase delete failed: %s", table)
        return False


def _sb_rpc(name, body):
    """Call one service-role Supabase RPC. Returns its JSON value, or None
    when the request failed or returned invalid JSON."""
    try:
        resp = requests.post(
            _table("rpc/" + name),
            headers=_sb_headers({"Content-Type": "application/json"}),
            data=json.dumps(body),
            timeout=15,
        )
        if not resp.ok:
            log.error("supabase rpc %s -> %s %s", name, resp.status_code,
                      resp.text[:200])
            return None
        return resp.json()
    except Exception:
        log.exception("supabase rpc failed: %s", name)
        return None


def _queue_depth():
    """Undone-row count for the heartbeat line. None = read failed."""
    try:
        resp = requests.get(
            _table("push_queue"),
            headers=_sb_headers({"Range": "0-0", "Prefer": "count=exact"}),
            params={"select": "id", "done_at": "is.null"},
            timeout=15,
        )
        if resp.status_code not in (200, 206):
            return None
        cr = resp.headers.get("Content-Range", "")
        if "/" not in cr:
            return None
        total = cr.rsplit("/", 1)[-1]
        return None if total == "*" else int(total)
    except Exception:
        return None


# ── APNs: ES256 JWT (cached 45 min; Apple accepts 60 and throttles
# frequent minting: TooManyProviderTokenUpdates) + curl --http2 send ──
_JWT = {"jwt": None, "at": 0.0}


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _apns_jwt() -> str:
    now = time.time()
    if _JWT["jwt"] and now - _JWT["at"] < 45 * 60:
        return _JWT["jwt"]
    with open(APNS_P8_PATH, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    head = _b64url(json.dumps({"alg": "ES256", "kid": APNS_KEY_ID}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({"iss": APPLE_TEAM_ID, "iat": int(now)}, separators=(",", ":")).encode())
    signing = head + "." + claims
    # cryptography returns a DER signature; JWTs (JOSE) want raw 64-byte r||s.
    der = key.sign(signing.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    _JWT["jwt"] = signing + "." + _b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    _JWT["at"] = now
    return _JWT["jwt"]


def _apns_send(device_token, headers_cfg, aps, request_id=None):
    """One push to one device via curl --http2 (the PROVEN road from
    this droplet; Workers fetch and plain HTTP/1.1 both fail against
    Apple). Returns (http_status, reason). status 0 = local/transport
    failure. Never raises."""
    try:
        jwt = _apns_jwt()
    except Exception as e:
        _alert_owner("apns_key",
                     "pushdrain: cannot read or sign with the APNs key file ("
                     + str(e)[:120] + "). Check APNS_P8_PATH in /opt/jarvis-invoice-bot/.env, "
                     "file readable by user jarvis (chmod 600). Telegram fallback is carrying alerts. "
                     "Fix then: systemctl restart pushdrain")
        return (0, "jwt-error: " + str(e)[:160])
    try:
        stable_headers = []
        if request_id:
            stable_headers += ["-H", "apns-id: " + str(request_id)]
        collapse_id = str(headers_cfg.get("collapse_id") or "").strip()
        if collapse_id:
            stable_headers += ["-H", "apns-collapse-id: " + collapse_id[:64]]
        expiration = headers_cfg.get("expiration")
        if expiration is not None:
            try:
                stable_headers += ["-H", "apns-expiration: "
                                   + str(max(0, int(expiration)))]
            except (TypeError, ValueError):
                return (0, "invalid-apns-expiration")
        cmd = [
            "curl", "-s", "--http2", "--max-time", "15",
            "-o", "-", "-w", "\n%{http_code}",
            "-H", "authorization: bearer " + jwt,
            "-H", "apns-topic: " + str(headers_cfg.get("topic", "")),
            "-H", "apns-push-type: " + str(headers_cfg.get("push_type", "alert")),
            "-H", "apns-priority: " + str(headers_cfg.get("priority", 10)),
            "-H", "content-type: application/json",
        ] + stable_headers + [
            "--data-binary", json.dumps({"aps": aps}),
            APNS_HOST + "/3/device/" + str(device_token),
        ]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return (0, "curl rc=" + str(out.returncode) + " " + (out.stderr or "")[:120])
        raw = out.stdout or ""
        body, _, code = raw.rpartition("\n")
        try:
            status = int(code.strip() or "0")
        except ValueError:
            return (0, "unparseable curl output")
        reason = ""
        if body.strip():
            try:
                reason = (json.loads(body) or {}).get("reason", "")
            except Exception:
                reason = body.strip()[:80]
        return (status, reason)
    except Exception as e:
        return (0, "send-exception: " + str(e)[:160])


# ── queue mechanics ──────────────────────────────────────────────────
_LA_BLOCKED_UNTIL = 0.0  # Apple rejected the liveactivity topic; skip la_* rows until then
_DEAD_TOKEN_REASONS = (
    "BadDeviceToken",
    "Unregistered",
    "ExpiredToken",
    "DeviceTokenNotForTopic",
)


def _delete_dead_token(kind, token):
    """410-style cleanup, moved here from the worker. The app re-upserts
    a fresh token on next login/launch, so deleting is always safe."""
    if kind == "alert":
        _sb_delete("push_tokens", {"apns_token": "eq." + str(token)})
    else:
        _sb_delete("live_activity_tokens", {"token": "eq." + str(token)})


def _live_activity_end_identity(row, token):
    """Return exact durable identity for one la_end destination, or None.
    The worker deliberately writes one la_end row per phone."""
    payload = row.get("payload") or {}
    token_id = str(payload.get("live_activity_token_id") or "").strip()
    shift_id = str(payload.get("live_activity_shift_id") or "").strip()
    queue_id = str(payload.get("live_activity_queue_id") or "").strip()
    claim_stamp = str(payload.get("live_activity_end_requested_at") or "").strip()
    if (not token_id or not shift_id or not queue_id or not claim_stamp
            or queue_id != str(row.get("id") or "") or not token):
        return None
    return {
        "id": "eq." + token_id,
        "token": "eq." + str(token),
        "token_type": "eq.activity_update",
        "shift_id": "eq." + shift_id,
        "end_queue_id": "eq." + queue_id,
        "end_requested_at": "eq." + claim_stamp,
    }


def _live_activity_start_identity(row, token):
    """Return the exact durable receipt for one la_start destination.
    A START queue row is deliberately limited to one Apple token."""
    payload = row.get("payload") or {}
    delivery_id = str(
        payload.get("live_activity_start_delivery_id") or "").strip()
    shift_id = str(
        payload.get("live_activity_start_shift_id") or "").strip()
    device_id = str(
        payload.get("live_activity_start_device_id") or "").strip()
    queue_id = str(
        payload.get("live_activity_start_queue_id") or "").strip()
    claim_stamp = str(
        payload.get("live_activity_start_claimed_at") or "").strip()
    token_text = str(token or "").strip().lower()
    try:
        generation = int(payload.get("live_activity_start_generation"))
    except (TypeError, ValueError):
        generation = 0
    try:
        for receipt_uuid in (delivery_id, shift_id, device_id, queue_id):
            uuid.UUID(receipt_uuid)
    except (ValueError, AttributeError, TypeError):
        return None
    if (not delivery_id or not shift_id or not device_id or not queue_id
            or not claim_stamp or queue_id != str(row.get("id") or "")
            or generation < 1 or len(token_text) < 32
            or len(token_text) > 512
            or any(char not in "0123456789abcdef" for char in token_text)):
        return None
    return {
        "id": "eq." + delivery_id,
        "shift_id": "eq." + shift_id,
        "device_id": "eq." + device_id,
        "queue_id": "eq." + queue_id,
        "generation": "eq." + str(generation),
        "start_token": "eq." + token_text,
    }


def _validate_live_activity_start(row, token):
    """Recheck the shift, token, and manager link immediately before APNs.
    True is eligible, False is definitively ineligible, None is a read failure."""
    identity = _live_activity_start_identity(row, token)
    if not identity:
        return False
    result = _sb_rpc("hc_validate_live_activity_start_delivery", {
        "p_delivery_id": identity["id"][3:],
        "p_shift_id": identity["shift_id"][3:],
        "p_queue_id": identity["queue_id"][3:],
        "p_generation": int(identity["generation"][3:]),
        "p_start_token": identity["start_token"][3:],
    })
    return result if isinstance(result, bool) else None


def _live_activity_start_result_present(identity, outcome, reason=None):
    rows = _sb_select("live_activity_start_deliveries", {
        **identity,
        "select": "id,delivered_at,terminal_at,terminal_reason",
        "limit": "1",
    })
    if rows is None:
        return None
    if len(rows) != 1:
        return False
    current = rows[0]
    if outcome == "delivered":
        return (current.get("delivered_at") is not None
                and current.get("terminal_at") is None)
    return (current.get("terminal_at") is not None
            and current.get("delivered_at") is None
            and current.get("terminal_reason") == reason)


def _record_live_activity_start_result(row, token, outcome, reason=None) -> bool:
    """Persist Apple's exact START result before allowing the queue to close.
    Ambiguous write responses are verified, then retried with the same receipt."""
    identity = _live_activity_start_identity(row, token)
    if not identity or outcome not in ("delivered", "terminal"):
        return False
    # device_id can legitimately change when the same exact Apple token is
    # reclaimed after reinstall. The other fields form the immutable receipt.
    identity = {
        key: value for key, value in identity.items()
        if key != "device_id"
    }
    terminal_reason = str(reason or "")[:300] if outcome == "terminal" else None
    if outcome == "terminal" and not terminal_reason:
        return False
    params = {
        **identity,
        "delivered_at": "is.null",
        "terminal_at": "is.null",
    }
    body = ({"delivered_at": _now_iso()}
            if outcome == "delivered"
            else {"terminal_at": _now_iso(),
                  "terminal_reason": terminal_reason})
    for attempt in range(3):
        changed = _sb_patch(
            "live_activity_start_deliveries", params, body, want_rows=True)
        if changed is True or (isinstance(changed, list) and changed):
            return True
        present = _live_activity_start_result_present(
            identity, outcome, terminal_reason)
        if present is True:
            return True
        if isinstance(changed, list) and not changed and present is False:
            return False
        if attempt < 2:
            time.sleep(0.05 * (attempt + 1))
    _alert_owner(
        "la_start_result_write",
        "pushdrain: Apple's Live Activity START result could not be saved for "
        "queue row " + str(row.get("id")) + ". The queue receipt is being "
        "retained to avoid a blind resend. Check Supabase and: journalctl -u "
        "pushdrain -n 80",
    )
    return False


def _delete_live_activity_start_token(row, token) -> bool:
    identity = _live_activity_start_identity(row, token)
    if not identity:
        return False
    return _sb_delete("live_activity_tokens", {
        "token_type": "eq.push_to_start",
        "shift_id": "is.null",
        "token": identity["start_token"],
    })


def _delete_live_activity_end_token(row, token) -> bool:
    """Delete only the exact phone token named by this one-token END row.
    Called only after that token gets APNs 200 or a terminal dead result."""
    identity = _live_activity_end_identity(row, token)
    if not identity:
        return False
    return _sb_delete("live_activity_tokens", identity)


def _release_live_activity_end(row, token) -> bool:
    """Clear only this END's exact lease so the five-minute worker can
    enqueue the phone again. A rotated token or newer lease never matches."""
    identity = _live_activity_end_identity(row, token)
    if not identity:
        return False
    return bool(_sb_patch("live_activity_tokens", identity,
                          {"end_requested_at": None,
                           "end_queue_id": None}))


class _TerminalWebhookOutboxError(ValueError):
    """The encrypted row cannot become deliverable by retrying it."""


class _RetryableWebhookOutboxError(RuntimeError):
    """Delivery can recover after the droplet configuration is corrected."""


_WEBHOOK_CONFIG_WARNING_AT = 0.0


def _warn_webhook_outbox_configuration(reason):
    """Rate-limit one generic operator warning without exposing key material."""
    global _WEBHOOK_CONFIG_WARNING_AT
    now = time.time()
    if now - _WEBHOOK_CONFIG_WARNING_AT < _ALERT_COOLDOWN_SECONDS:
        return
    _WEBHOOK_CONFIG_WARNING_AT = now
    safe_reason = str(reason or "provider alert delivery is not configured")[:160]
    log.error("webhook Telegram outbox configuration problem: %s", safe_reason)
    _alert_owner(
        "webhook_outbox_config",
        "pushdrain: provider alerts are waiting because " + safe_reason
        + ". Repair the droplet Telegram/outbox settings and restart pushdrain. "
        + "Queued rows will retry automatically.",
    )


def _versioned_outbox_keys():
    keys = {}
    for label, configured in (
            ("current", WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT),
            ("previous", WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS)):
        if not configured:
            continue
        try:
            version, encoded = configured.split(":", 1)
            if (not version or len(version) > 32
                    or any(not (ch.isascii()
                                and (ch.isalnum() or ch in "._-"))
                           for ch in version)):
                raise ValueError("invalid version")
            key = base64.b64decode(encoded, validate=True)
            if len(key) != 32 or version in keys:
                raise ValueError("invalid or duplicate key")
            keys[version] = key
        except (ValueError, TypeError) as exc:
            raise _RetryableWebhookOutboxError(
                "invalid outbox key configuration") from exc
    return keys


def _webhook_outbox_configuration_error():
    """Return a generic startup problem, or None when new rows are deliverable."""
    if not TELEGRAM_BOT_TOKEN:
        return "the Telegram bot token is missing"
    if not WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT:
        return "the current webhook outbox encryption key is missing"
    try:
        keys = _versioned_outbox_keys()
        current_version = WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT.split(":", 1)[0]
        if current_version not in keys:
            return "the current webhook outbox encryption key is invalid"
    except _RetryableWebhookOutboxError:
        return "the webhook outbox encryption key configuration is invalid"
    return None


def _decrypt_telegram_outbox(row):
    """Decrypt one v2 row with its declared current or previous key."""
    payload = row.get("payload") or {}
    if not isinstance(payload, dict):
        raise _TerminalWebhookOutboxError("invalid queue payload")
    outbox = payload.get("telegram_outbox")
    if not isinstance(outbox, dict):
        raise _TerminalWebhookOutboxError("missing encrypted payload")
    try:
        if outbox.get("version") != 2:
            raise ValueError("unsupported version")
        key_version = str(outbox.get("key_version") or "")
        key = _versioned_outbox_keys().get(key_version)
        if key is None:
            # A planned rotation can leave an older row waiting for the
            # previous key. Keep it retryable so restoring that key delivers
            # the alert instead of requiring a manual dead-letter rescue.
            raise _RetryableWebhookOutboxError(
                "configured keys do not include this row version")
        nonce = base64.b64decode(str(outbox.get("nonce") or ""), validate=True)
        ciphertext = base64.b64decode(
            str(outbox.get("ciphertext") or ""), validate=True)
        if len(nonce) != 12 or len(ciphertext) < 17:
            raise ValueError("invalid encrypted fields")
        aad = ("hc-telegram-outbox-v2\0" + key_version + "\0"
               + str(row.get("id") or "")).encode("utf-8")
        try:
            plaintext = AESGCM(key).decrypt(nonce, ciphertext, aad)
        except InvalidTag as exc:
            # This can mean either a corrupt row or a same-version key was
            # configured with the wrong bytes. Retrying is safer than losing a
            # real provider alert while an operator repairs the key.
            raise _RetryableWebhookOutboxError(
                "configured key cannot decrypt this row") from exc
        decoded = json.loads(plaintext.decode("utf-8"))
        if not isinstance(decoded, dict):
            raise ValueError("decrypted value is not an object")
        if set(decoded) != {"chat_id", "text"}:
            raise ValueError("unexpected plaintext fields")
        chat_id = str(decoded.get("chat_id") or "").strip()
        text = decoded.get("text")
        if not chat_id or not isinstance(text, str) or not text:
            raise ValueError("missing destination or text")
        if len(chat_id) > 128 or len(text) > 4096:
            raise ValueError("destination or text is too long")
        return {
            "chat_id": chat_id,
            "text": text,
        }
    except _RetryableWebhookOutboxError as exc:
        log.error("telegram outbox key unavailable for row %s: %s",
                  row.get("id"), str(exc))
        raise
    except Exception as exc:
        log.error("telegram outbox decrypt failed for row %s: %s",
                  row.get("id"), type(exc).__name__)
        if isinstance(exc, _TerminalWebhookOutboxError):
            raise
        raise _TerminalWebhookOutboxError(
            "corrupt encrypted payload") from exc


def _send_webhook_telegram(row):
    """Return `sent`, `retryable`, or `terminal` plus a generic reason."""
    try:
        delivery = _decrypt_telegram_outbox(row)
    except _RetryableWebhookOutboxError:
        return ("retryable", "webhook outbox key unavailable")
    except _TerminalWebhookOutboxError:
        return ("terminal", "corrupt or undecryptable payload")
    if not TELEGRAM_BOT_TOKEN:
        return ("retryable", "telegram bot configuration unavailable")
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": delivery["chat_id"], "text": delivery["text"]},
            timeout=10,
        )
    except Exception:
        # Telegram may have accepted the request before the response was lost.
        # It offers no idempotency key, so at-least-once retry can duplicate
        # only this one destination in that narrow ambiguous-response window.
        log.exception("telegram outbox send ambiguous for row %s", row.get("id"))
        return ("retryable", "telegram response unavailable")

    status = int(getattr(resp, "status_code", 0) or 0)
    if bool(getattr(resp, "ok", False)):
        return ("sent", None)
    log.error("telegram outbox row %s -> %s", row.get("id"), status)
    if status in (401, 404):
        # A missing, mistyped, or rotated bot token is repairable. Do not
        # permanently discard queued provider alerts during that outage.
        return ("retryable", "telegram bot configuration unavailable")
    if status in (408, 409, 429) or status >= 500 or status <= 0:
        return ("retryable", "telegram temporarily unavailable")
    if 400 <= status < 500:
        return ("terminal", "telegram permanently rejected delivery")
    return ("retryable", "telegram unexpected response")


def _send_fallback(row) -> bool:
    """The Telegram half the worker used to do inline. True when at
    least one chat accepted the message. Rows without telegram_text or
    chat ids (all la_* rows, the clock-out banner) return False and the
    caller closes them without noise."""
    payload = row.get("payload") or {}
    text = payload.get("telegram_text")
    chat_ids = payload.get("fallback_chat_ids") or []
    if not text or not chat_ids:
        return False
    if not TELEGRAM_BOT_TOKEN:
        log.warning("fallback wanted but TELEGRAM_BOT_TOKEN unset (row %s)", row.get("id"))
        return False
    sent = False
    for cid in chat_ids:
        try:
            resp = requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json={"chat_id": cid, "text": text},  # plain mode, same as the worker
                timeout=10,
            )
            if resp.ok:
                sent = True
            else:
                log.error("telegram fallback to %s -> %s %s", cid, resp.status_code, resp.text[:200])
        except Exception:
            log.exception("telegram fallback failed to %s", cid)
    return sent


def _fallback_wanted(row) -> bool:
    """True when the row carries both a fallback text and chat ids, i.e.
    losing it would lose an owner alert (clock-in pings, stop alerts)."""
    payload = row.get("payload") or {}
    return bool(payload.get("telegram_text") and payload.get("fallback_chat_ids"))


def _queue_patch_was_applied(row, body):
    """Verify an ambiguous queue PATCH without changing state. True means the
    requested state is present, False means it is not, None means the read also
    failed. Timestamp formatting is server-dependent, so done_at is verified as
    present while the other durable fields are compared exactly."""
    fields = set(body)
    fields.update(("id", "claimed_at", "done_at"))
    rows = _sb_select("push_queue", {
        "select": ",".join(sorted(fields)),
        "id": "eq." + str(row["id"]),
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
        elif actual != expected:
            return False
    return True


def _same_instant(left, right) -> bool:
    try:
        a = datetime.fromisoformat(str(left).replace("Z", "+00:00"))
        b = datetime.fromisoformat(str(right).replace("Z", "+00:00"))
        return a == b
    except (TypeError, ValueError):
        return str(left) == str(right)


def _refresh_queue_claim(row) -> bool:
    """Rotate one exact queue lease before the next APNs destination. One curl
    call is bounded well below STALE_CLAIM_MINUTES, so this keeps a long
    multi-phone row fresh without letting an older drainer steal it."""
    old_stamp = str(row.get("claimed_at") or "").strip()
    if not old_stamp:
        return False
    new_stamp = _now_iso()
    changed = _sb_patch(
        "push_queue",
        {"id": "eq." + str(row["id"]),
         "done_at": "is.null",
         "claimed_at": "eq." + old_stamp},
        {"claimed_at": new_stamp},
        want_rows=True,
    )
    if changed is True:  # lightweight offline-test success convention
        row["claimed_at"] = new_stamp
        return True
    if isinstance(changed, list):
        if not changed:
            return False
        row["claimed_at"] = changed[0].get("claimed_at") or new_stamp
        return True
    if changed is None:
        rows = _sb_select("push_queue", {
            "select": "id,claimed_at,done_at",
            "id": "eq." + str(row["id"]),
            "limit": "1",
        })
        if (rows and len(rows) == 1 and rows[0].get("done_at") is None
                and _same_instant(rows[0].get("claimed_at"), new_stamp)):
            row["claimed_at"] = rows[0].get("claimed_at")
            return True
    return False


def _persist_queue_patch(row, body, attempts=3) -> bool:
    """Retry a queue-state write a few times. On total failure the current
    database claim remains in place. The stable collapse identity only reduces
    visible-duplicate risk if the row eventually becomes stale and retries."""
    claim_stamp = str(row.get("claimed_at") or "").strip()
    if not claim_stamp:
        log.error("queue row %s has no claim stamp; refusing state write", row.get("id"))
        return False
    params = {
        "id": "eq." + str(row["id"]),
        "done_at": "is.null",
        "claimed_at": "eq." + claim_stamp,
    }
    for attempt in range(max(1, attempts)):
        changed = _sb_patch("push_queue", params, body, want_rows=True)
        # Lightweight offline tests historically use True for a successful
        # PATCH. Production _sb_patch returns a row list when want_rows=True.
        if changed is True:
            return True
        if isinstance(changed, list):
            if changed:
                return True
            # A successful zero-row response proves this drainer no longer owns
            # the lease. Do not retry and do not overwrite the winner.
            log.warning("queue row %s claim changed before state save", row.get("id"))
            return False
        # None is ambiguous: the PATCH may have committed and lost its response.
        # A read confirms success before any idempotent retry.
        if changed is None and _queue_patch_was_applied(row, body) is True:
            return True
        if attempt + 1 < attempts:
            time.sleep(0.05 * (attempt + 1))
    _alert_owner(
        "queue_state_write",
        "pushdrain: Apple delivery state could not be saved for queue row "
        + str(row.get("id")) + ". Its claim remains in place and the stable "
        "collapse ID reduces visible duplicates on a later retry. Check Supabase "
        "and: journalctl -u pushdrain -n 80",
    )
    return False


def _finish(row, error=None):
    return _persist_queue_patch(
        row, {"done_at": _now_iso(), "last_error": error})


def _row_had_delivery(row) -> bool:
    payload = row.get("payload") or {}
    return bool(payload.get("delivery_succeeded"))


def _park_live_activity_start_result(row, token, outcome, reason=None) -> bool:
    """Save Apple's already-known result in the queue without closing it.
    Future passes reconcile the ledger and never contact Apple again."""
    payload = dict(row.get("payload") or {})
    payload["tokens"] = [str(token)]
    if outcome == "delivered":
        payload["delivery_succeeded"] = True
        payload.pop("live_activity_start_terminal_reason", None)
        error = "Apple accepted START; receipt write pending"
    else:
        payload["live_activity_start_terminal_reason"] = str(reason or "")[:300]
        payload.pop("delivery_succeeded", None)
        error = "Apple rejected dead START token; receipt write pending"
    return _persist_queue_patch(
        row,
        {"claimed_at": None,
         "attempts": int(row.get("attempts") or 0) + 1,
         "last_error": error,
         "payload": payload},
    )


def _reconcile_live_activity_start_result(row, token):
    """Return None when Apple has not answered, otherwise True/False for
    whether the saved queue result was durably reconciled into the ledger."""
    payload = row.get("payload") or {}
    terminal_reason = str(
        payload.get("live_activity_start_terminal_reason") or "").strip()
    if terminal_reason:
        saved = _record_live_activity_start_result(
            row, token, "terminal", terminal_reason)
        if saved:
            _delete_live_activity_start_token(row, token)
        return saved
    if payload.get("delivery_succeeded"):
        return _record_live_activity_start_result(
            row, token, "delivered")
    return None


def _park_delivery_retry(row, retry_tokens, delivered_before, error):
    """Persist only failed phones. delivery_succeeded suppresses Telegram
    fallback forever once any phone accepted this notification."""
    payload = dict(row.get("payload") or {})
    payload["tokens"] = list(retry_tokens)
    if delivered_before:
        payload["delivery_succeeded"] = True
    return _persist_queue_patch(
        row,
        {"claimed_at": None,
         "attempts": int(row.get("attempts") or 0) + 1,
         "last_error": error,
         "payload": payload},
    )


def _exhaust_live_activity_end(row, token, attempts, error):
    """Close this queue attempt, release its exact token lease, and alert
    the operator once per cooldown. A later five-minute scan retries it."""
    closed = _persist_queue_patch(
        row,
        {"done_at": _now_iso(), "attempts": attempts,
         "last_error": error + ", retry budget exhausted"},
    )
    # Release only after the old queue row is durably closed. If that close
    # failed, retaining the lease prevents a new row from overlapping it; the
    # stale queue claim and stale token lease both have recovery paths.
    released = closed and _release_live_activity_end(row, token)
    if released:
        recovery = "The phone token was released for the next five-minute scan."
    elif closed:
        recovery = "The exact phone lease release failed; 30-minute stale-lease recovery remains."
    else:
        recovery = "The queue close failed, so its lease was retained to prevent an overlapping send."
    payload = row.get("payload") or {}
    _alert_owner(
        "la_end_exhausted",
        "pushdrain: a Live Activity END exhausted its APNs retries (shift "
        + str(payload.get("live_activity_shift_id") or "unknown")
        + ", " + error[:120] + "). " + recovery
        + " Alert pushes still work. Check: journalctl -u "
        "pushdrain -n 80",
    )


def _park_for_retry(row, error):
    """Fallback WANTED but Telegram refused it: leave the row undone and
    un-claimed with attempts bumped, so the next loop retries Telegram
    and, once attempts max out, the 15-minute expiry sweep gives it a
    final try. Closing here would permanently lose an owner alert after
    ONE failed Telegram attempt."""
    return _persist_queue_patch(
        row,
        {"claimed_at": None,
         "attempts": int(row.get("attempts") or 0) + 1,
         "last_error": error},
    )


def _webhook_outbox_backoff_seconds(attempts):
    """Short independent schedule: 20s, 40s, 80s, 160s, then 5m."""
    completed_attempts = max(1, int(attempts or 1))
    return min(300, 20 * (2 ** min(4, completed_attempts - 1)))


def _park_webhook_outbox_retry(row, reason):
    new_attempts = int(row.get("attempts") or 0) + 1
    retry_at = datetime.now(timezone.utc) + timedelta(
        seconds=_webhook_outbox_backoff_seconds(new_attempts))
    return _persist_queue_patch(
        row,
        {
            "claimed_at": None,
            "attempts": new_attempts,
            "next_attempt_at": _iso(retry_at),
            "last_error": str(reason or "telegram retryable failure")[:300],
        },
    )


def _dead_letter_webhook_outbox(row, reason):
    now = _now_iso()
    safe_reason = str(reason or "terminal webhook outbox failure")[:300]
    saved = _persist_queue_patch(
        row,
        {
            "done_at": now,
            "dead_lettered_at": now,
            "dead_letter_reason": safe_reason,
            "attempts": int(row.get("attempts") or 0) + 1,
            "last_error": safe_reason,
        },
    )
    if saved:
        _alert_owner(
            "webhook_outbox_dead_letter",
            "pushdrain: provider alert queue row " + str(row.get("id"))
            + " moved to dead letter. Reason: " + safe_reason
            + ". Check Supabase push_queue and pushdrain logs.",
        )
    return saved


def _process_webhook_outbox(row):
    outcome, reason = _send_webhook_telegram(row)
    if outcome == "sent":
        _finish(row, None)
        return (0, True)
    if outcome == "terminal":
        _dead_letter_webhook_outbox(row, reason)
        return (0, False)
    if reason in (
            "webhook outbox key unavailable",
            "telegram bot configuration unavailable"):
        _warn_webhook_outbox_configuration(reason)
    _park_webhook_outbox_retry(row, reason)
    return (0, False)


def _process_row(row):
    """Returns (delivered_count, fell_back_bool) for the heartbeat."""
    global _LA_BLOCKED_UNTIL
    kind = row.get("kind") or "alert"
    payload = row.get("payload") or {}
    if (row.get("outbox_type") == "webhook_telegram"
            or (isinstance(payload, dict)
                and payload.get("telegram_outbox") is not None)):
        return _process_webhook_outbox(row)
    if not isinstance(payload, dict):
        _finish(row, "bad payload (not an object)")
        return (0, False)
    raw_tokens = payload.get("tokens") or []
    if not isinstance(raw_tokens, list):
        _finish(row, "bad payload (tokens is not an array)")
        return (0, False)
    # Stable de-duplication: one accidental duplicate token in a payload must
    # never produce two lock-screen notifications in the same drain pass.
    tokens = list(dict.fromkeys(str(t) for t in raw_tokens if t))
    raw_headers = payload.get("headers") or {}
    if not isinstance(raw_headers, dict):
        _finish(row, "bad payload (headers is not an object)")
        return (0, False)
    headers_cfg = dict(raw_headers)
    # A START delivered after clock-out creates a ghost card with no update
    # token available for the earlier END. Never let APNs store STARTs. Enforce
    # this here as well as in the current worker payload so legacy rows are safe.
    if kind == "la_start":
        headers_cfg["expiration"] = 0
    aps = payload.get("aps") or {}
    if not isinstance(aps, dict):
        _finish(row, "bad payload (aps is not an object)")
        return (0, False)
    delivered_before = _row_had_delivery(row)

    if kind == "la_end" and (len(tokens) != 1 or not _live_activity_end_identity(row, tokens[0] if tokens else None)):
        _alert_owner("la_end_bad_payload",
                     "pushdrain: rejected a malformed Live Activity END queue row ("
                     + str(row.get("id")) + "). No phone token was deleted.")
        _finish(row, "bad la_end payload: exact one-token identity required")
        return (0, False)

    if kind == "la_start" and (
            len(tokens) != 1
            or not _live_activity_start_identity(
                row, tokens[0] if tokens else None)):
        _alert_owner(
            "la_start_bad_payload",
            "pushdrain: rejected a malformed Live Activity START queue row ("
            + str(row.get("id")) + "). No banner was sent.",
        )
        _finish(row, "bad la_start payload: exact one-token receipt required")
        return (0, False)

    # If Apple already answered but the receipt write was interrupted, repair
    # database state first. The queue latch makes this path strictly no-send.
    if kind == "la_start":
        reconciled = _reconcile_live_activity_start_result(row, tokens[0])
        if reconciled is not None:
            if reconciled:
                _finish(row, None)
            else:
                terminal_reason = str(payload.get(
                    "live_activity_start_terminal_reason") or "").strip()
                _park_live_activity_start_result(
                    row,
                    tokens[0],
                    "terminal" if terminal_reason else "delivered",
                    terminal_reason or None,
                )
            return (0, False)

    # Live Activity topic is blocked: close la_* rows immediately
    # (cosmetic, perishable, no fallback). Alert rows are unaffected.
    if kind != "alert" and time.time() < _LA_BLOCKED_UNTIL:
        _finish(row, "topic-blocked")
        return (0, False)

    # APNs not configured at all: alerts skip straight to Telegram. A
    # durable la_end retries and eventually releases its token lease so
    # the next five-minute scan can try again; other cosmetic la_* rows
    # keep their old close-without-fallback behavior. A WANTED fallback
    # that Telegram refused stays alive for retries.
    if tokens and not _APNS_CONFIGURED:
        if kind == "la_end":
            new_attempts = int(row.get("attempts") or 0) + 1
            if new_attempts >= MAX_ATTEMPTS:
                _exhaust_live_activity_end(row, tokens[0], new_attempts,
                                           "apns not configured")
            else:
                _park_delivery_retry(row, tokens, False, "apns not configured")
            return (0, False)
        if delivered_before:
            new_attempts = int(row.get("attempts") or 0) + 1
            if new_attempts >= MAX_ATTEMPTS:
                _persist_queue_patch(
                    row,
                    {"done_at": _now_iso(), "attempts": new_attempts,
                     "last_error": "apns not configured after partial delivery; "
                                   "fallback suppressed"},
                )
            else:
                _park_delivery_retry(row, tokens, True,
                                     "apns not configured after partial delivery")
            return (0, False)
        fb = _send_fallback(row)
        if fb or not _fallback_wanted(row):
            _finish(row, "apns not configured" + (", telegram fallback sent" if fb else ""))
        else:
            _park_for_retry(row, "apns not configured, telegram fallback FAILED")
        return (0, fb)

    delivered = 0
    dead = 0
    errors = []
    retry_tokens = []
    for token_index, t in enumerate(tokens):
        if token_index > 0 and not _refresh_queue_claim(row):
            log.warning("queue row %s lost its claim before token %d; stopping",
                        row.get("id"), token_index + 1)
            return (delivered, False)
        if kind == "la_start":
            eligible = _validate_live_activity_start(row, t)
            if eligible is None:
                _park_delivery_retry(
                    row, [t], False,
                    "Live Activity START eligibility check unavailable",
                )
                return (delivered, False)
            if eligible is False:
                _finish(row, "Live Activity START no longer eligible")
                return (delivered, False)
        status, reason = _apns_send(t, headers_cfg, aps, row.get("id"))
        if status == 200:
            delivered += 1
            if kind == "la_start" and not _record_live_activity_start_result(
                    row, t, "delivered"):
                _park_live_activity_start_result(row, t, "delivered")
                return (delivered, False)
            if kind == "la_end" and not _delete_live_activity_end_token(row, t):
                _alert_owner("la_end_cleanup",
                             "pushdrain: Apple accepted a Live Activity END, but its exact "
                             "token row could not be cleaned up. The card is dismissed. Check "
                             "Supabase and pushdrain logs.")
            continue
        errors.append(str(status) + " " + reason)
        if status == 410 or reason in _DEAD_TOKEN_REASONS:
            if kind == "la_start":
                terminal_reason = (str(status) + " " + str(reason or "dead token"))[:300]
                if not _record_live_activity_start_result(
                        row, t, "terminal", terminal_reason):
                    _park_live_activity_start_result(
                        row, t, "terminal", terminal_reason)
                    return (delivered, False)
                if not _delete_live_activity_start_token(row, t):
                    _alert_owner(
                        "la_start_cleanup",
                        "pushdrain: Apple reported a dead Live Activity START "
                        "token, but its exact token row could not be cleaned up. "
                        "The durable receipt prevents a blind resend. Check "
                        "Supabase and pushdrain logs.",
                    )
            elif kind == "la_end":
                if not _delete_live_activity_end_token(row, t):
                    _alert_owner("la_end_cleanup",
                                 "pushdrain: Apple reported a dead Live Activity END token, "
                                 "but its exact row could not be cleaned up. Check Supabase and "
                                 "pushdrain logs.")
            else:
                _delete_dead_token(kind, t)
            dead += 1
            continue
        if reason == "ExpiredProviderToken":
            _JWT["jwt"] = None  # mint fresh on the next send
            # This is an expired provider login token, not a rejected Live
            # Activity topic. Keep the exact phone retryable and do not enter
            # the six-hour topic block below.
            retry_tokens.append(t)
            continue
        if kind != "alert" and (reason in ("TopicDisallowed", "InvalidProviderToken") or status == 403):
            # topic-restricted key likely does not cover the
            # liveactivity subtopic: block la_* for 6h, tell the
            # operator once, close this row. Alert pushes keep working.
            _LA_BLOCKED_UNTIL = time.time() + 6 * 3600
            _alert_owner("la_blocked",
                         "pushdrain: Live Activity pushes rejected by Apple ("
                         + (reason or str(status)) + "). Alert pushes still work. The APNs "
                         "key probably needs the liveactivity topic added; Live Activity "
                         "sends paused for 6h.")
            _finish(row, "topic-blocked: " + (reason or str(status)))
            return (delivered, False)
        if kind == "alert" and (reason == "InvalidProviderToken" or status == 403):
            _alert_owner("apns_auth",
                         "pushdrain: Apple rejected our APNs auth (" + (reason or str(status))
                         + "). Banners are failing; Telegram fallback is carrying alerts. Check "
                         "APNS_P8_PATH / APNS_KEY_ID / APPLE_TEAM_ID in /opt/jarvis-invoice-bot/.env "
                         "then: systemctl restart pushdrain")
        # anything else (429, 5xx, network, curl error): retryable below
        retry_tokens.append(t)

    any_delivery = delivered_before or delivered > 0

    if retry_tokens:
        new_attempts = int(row.get("attempts") or 0) + 1
        err = ("; ".join(errors))[:300] or "unknown"
        if new_attempts >= MAX_ATTEMPTS:
            if kind == "la_end":
                _exhaust_live_activity_end(row, retry_tokens[0], new_attempts, err)
                return (delivered, False)
            if any_delivery:
                # At least one phone already received this notification. Close
                # without Telegram and without retrying successful phones.
                _persist_queue_patch(
                    row,
                    {"done_at": _now_iso(), "attempts": new_attempts,
                     "last_error": err + ", partial delivery; fallback suppressed"},
                )
                return (delivered, False)
            fb = _send_fallback(row)
            if fb or not _fallback_wanted(row):
                _persist_queue_patch(
                    row,
                    {"done_at": _now_iso(), "attempts": new_attempts,
                     "last_error": err + (", telegram fallback sent" if fb else ", no fallback configured")},
                )
            else:
                _persist_queue_patch(
                    row,
                    {"attempts": new_attempts,
                     "last_error": err + ", telegram fallback FAILED"},
                )
            return (delivered, fb)

        _park_delivery_retry(row, retry_tokens, any_delivery, err)
        return (delivered, False)

    if any_delivery:
        _finish(row, None)
        return (delivered, False)

    if not tokens or dead == len(tokens):
        # nobody to push to (no registered phones, or every token was
        # dead and has been cleaned up): fall straight back. Same
        # keep-alive rule as above: only close when the fallback landed
        # or none was wanted.
        fb = _send_fallback(row)
        if fb or not _fallback_wanted(row):
            _finish(row, "no live devices" + (", telegram fallback sent" if fb else ""))
        else:
            _park_for_retry(row, "no live devices, telegram fallback FAILED")
        return (0, fb)

    # No successful or retryable tokens remain. They were all terminally dead
    # and have already been cleaned up above.
    return (0, False)


def _expire_claimed_row(row) -> bool:
    """Expire one row whose exact queue lease was just claimed. Returns whether
    Telegram fallback was accepted."""
    payload = row.get("payload") or {}
    if (row.get("outbox_type") == "webhook_telegram"
            or (isinstance(payload, dict)
                and payload.get("telegram_outbox") is not None)):
        return _process_webhook_outbox(row)[1]
    if row.get("kind") == "la_start":
        tokens = payload.get("tokens") or []
        token = tokens[0] if isinstance(tokens, list) and len(tokens) == 1 else None
        if not token or not _live_activity_start_identity(row, token):
            _alert_owner(
                "la_start_bad_payload",
                "pushdrain: an expired Live Activity START row had no exact "
                "receipt (" + str(row.get("id")) + "). No banner was sent.",
            )
            _finish(row, "expired malformed la_start payload")
            return False
        reconciled = _reconcile_live_activity_start_result(row, token)
        if reconciled is True:
            _finish(row, "expired after Apple result reconciliation")
        elif reconciled is False:
            terminal_reason = str(payload.get(
                "live_activity_start_terminal_reason") or "").strip()
            _park_live_activity_start_result(
                row,
                token,
                "terminal" if terminal_reason else "delivered",
                terminal_reason or None,
            )
        else:
            _finish(row, "expired before Live Activity START delivery")
        return False
    if row.get("kind") == "la_end":
        tokens = payload.get("tokens") or []
        token = tokens[0] if isinstance(tokens, list) and len(tokens) == 1 else None
        if token and _live_activity_end_identity(row, token):
            _exhaust_live_activity_end(
                row, token,
                max(MAX_ATTEMPTS, int(row.get("attempts") or 0)),
                "expired before Live Activity END delivery",
            )
        else:
            _alert_owner("la_end_bad_payload",
                         "pushdrain: an expired Live Activity END row had no exact "
                         "phone identity (" + str(row.get("id")) + "). No token was deleted.")
            _finish(row, "expired malformed la_end payload")
        return False
    if _row_had_delivery(row):
        _finish(row, "expired after partial delivery; fallback suppressed")
        return False
    fell_back = _send_fallback(row)
    _finish(row, "expired before delivery" +
            (", telegram fallback sent" if fell_back else ""))
    return fell_back


_read_fail_streak = 0
_last_purge = 0.0


def work_once():
    global _read_fail_streak, _last_purge
    now = datetime.now(timezone.utc)
    depth = _queue_depth()
    expired_n = claimed_n = delivered_n = fellback_n = 0
    stale_iso = _iso(now - timedelta(minutes=STALE_CLAIM_MINUTES))
    now_iso = _iso(now)

    # Provider alerts are durable, non-perishable rows. Their independent due
    # time avoids the legacy five-attempt stop and 15-minute expiry blackout.
    webhook_ids = _sb_select("push_queue", {
        "select": "id",
        "outbox_type": "eq.webhook_telegram",
        "done_at": "is.null",
        "dead_lettered_at": "is.null",
        "next_attempt_at": "lte." + now_iso,
        "or": "(claimed_at.is.null,claimed_at.lt." + stale_iso + ")",
        "order": "next_attempt_at.asc,created_at.asc",
        "limit": str(BATCH_LIMIT),
    })
    for candidate in (webhook_ids or []):
        claim_stamp = _now_iso()
        rows = _sb_patch(
            "push_queue",
            {
                "id": "eq." + str(candidate["id"]),
                "outbox_type": "eq.webhook_telegram",
                "done_at": "is.null",
                "dead_lettered_at": "is.null",
                "next_attempt_at": "lte." + now_iso,
                "or": "(claimed_at.is.null,claimed_at.lt." + stale_iso + ")",
            },
            {"claimed_at": claim_stamp},
            want_rows=True,
        )
        for row in (rows or []):
            claimed_n += 1
            try:
                _delivered, sent = _process_webhook_outbox(row)
                if sent:
                    fellback_n += 1
            except Exception:
                log.exception("webhook outbox row %s crashed", row.get("id"))
                try:
                    _park_webhook_outbox_retry(row, "drainer exception")
                except Exception:
                    pass

    # 1) perishable sweep: select IDs, then compare-and-set a fresh claim before
    # touching them. This prevents one drainer from expiring/falling back a row
    # while another drainer is actively sending it.
    old_ids = _sb_select("push_queue", {
        "select": "id",
        "outbox_type": "eq.push",
        "done_at": "is.null",
        "created_at": "lt." + _iso(now - timedelta(minutes=EXPIRE_MINUTES)),
        "or": "(claimed_at.is.null,claimed_at.lt." + stale_iso + ")",
        "order": "created_at.asc",
        "limit": str(BATCH_LIMIT),
    })
    for candidate in (old_ids or []):
        claim_stamp = _now_iso()
        old_rows = _sb_patch(
            "push_queue",
            {"id": "eq." + str(candidate["id"]),
             "outbox_type": "eq.push",
             "done_at": "is.null",
             "created_at": "lt." + _iso(now - timedelta(minutes=EXPIRE_MINUTES)),
             "or": "(claimed_at.is.null,claimed_at.lt." + stale_iso + ")"},
            {"claimed_at": claim_stamp},
            want_rows=True,
        )
        for row in (old_rows or []):
            expired_n += 1
            if _expire_claimed_row(row):
                fellback_n += 1

    # 2) claim a batch: unclaimed rows, plus claims older than
    # STALE_CLAIM_MINUTES (we died mid-row on a previous run). The
    # stale predicate is REPEATED inside the claim PATCH itself so a
    # second drainer instance (e.g. the docstring's manual test run
    # alongside the systemd service) matches zero rows instead of
    # overwriting a fresh claim and double-sending - the same guarded
    # claim-PATCH discipline the worker uses on shifts.
    ids = _sb_select("push_queue", {
        "select": "id",
        "outbox_type": "eq.push",
        "done_at": "is.null",
        "attempts": "lt." + str(MAX_ATTEMPTS),
        "or": "(claimed_at.is.null,claimed_at.lt." + stale_iso + ")",
        "order": "created_at.asc",
        "limit": str(BATCH_LIMIT),
    })
    if ids is None:
        _read_fail_streak += 1
        if _read_fail_streak >= 10:
            _alert_owner("queue_read",
                         "pushdrain: cannot read push_queue from Supabase ("
                         + str(_read_fail_streak) + " straight failures). Owner phone alerts are NOT "
                         "flowing. ssh root@138.197.105.163 then: systemctl status pushdrain; "
                         "journalctl -u pushdrain -n 50")
    else:
        _read_fail_streak = 0
        if ids:
            for candidate in ids:
                claim_stamp = _now_iso()
                rows = _sb_patch(
                    "push_queue",
                    {"id": "eq." + str(candidate["id"]),
                     "outbox_type": "eq.push",
                     "done_at": "is.null",
                     "attempts": "lt." + str(MAX_ATTEMPTS),
                     "or": "(claimed_at.is.null,claimed_at.lt." + stale_iso + ")"},
                    {"claimed_at": claim_stamp},
                    want_rows=True,
                )
                for row in (rows or []):
                    claimed_n += 1
                    try:
                        d, fb = _process_row(row)
                        delivered_n += d
                        if fb:
                            fellback_n += 1
                    except Exception:
                        log.exception("row %s crashed; un-claiming for retry", row.get("id"))
                        try:
                            _persist_queue_patch(
                                row,
                                {"claimed_at": None,
                                 "attempts": int(row.get("attempts") or 0) + 1,
                                 "last_error": "drainer exception"},
                            )
                        except Exception:
                            pass

    # 3) heartbeat: one line per loop, always.
    log.info("loop: depth=%s expired=%d claimed=%d delivered=%d fellback=%d",
             "?" if depth is None else depth, expired_n, claimed_n, delivered_n, fellback_n)

    # 4) hourly purge of old finished rows (keeps the table small).
    if time.time() - _last_purge > 3600:
        _last_purge = time.time()
        _sb_delete("push_queue", {"done_at": "lt." + _iso(now - timedelta(days=PURGE_AFTER_DAYS))})


def main():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY missing; cannot drain. "
                  "Fix /opt/jarvis-invoice-bot/.env then: systemctl restart pushdrain")
        raise SystemExit(1)
    if not _APNS_CONFIGURED:
        log.warning("APNs not fully configured (APNS_P8_PATH / APNS_KEY_ID / APPLE_TEAM_ID); "
                    "running in Telegram-fallback-only mode")
    outbox_problem = _webhook_outbox_configuration_error()
    if outbox_problem:
        # Keep the daemon alive for legacy APNs work. Encrypted provider rows
        # remain pending on their own backoff until this config is repaired.
        _warn_webhook_outbox_configuration(outbox_problem)
    log.info("pushdrain starting: interval=%ss apns=%s queue=%s",
             INTERVAL_SECONDS, "on" if _APNS_CONFIGURED else "OFF",
             SUPABASE_URL + "/rest/v1/push_queue")
    while True:
        try:
            work_once()
        except Exception:
            log.exception("work_once crashed (loop continues)")
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
