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
       Telegram fallback if the row carries telegram_text, then done.
    2. claims a batch (max 20, attempts < 5, unclaimed or stale-claimed)
       and for each row sends the payload's aps to every device token
       via curl --http2.
       - any 200                        -> done
       - 410 / BadDeviceToken /
         Unregistered / ExpiredToken    -> delete that token row
         (push_tokens for kind=alert, live_activity_tokens otherwise)
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

ENV (loaded from /opt/jarvis-invoice-bot/.env, then optionally
overridden by /opt/jarvis-invoice-bot/.pushdrain.env if that exists):
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (already in the Jarvis .env)
    TELEGRAM_BOT_TOKEN                   (already there; fallback sender)
    TELEGRAM_OWNER_ID                    (already there; daemon-health alerts,
                                          comma-separated)
    APNS_P8_PATH      path to the .p8 key file
                      (default /opt/jarvis-invoice-bot/apns-authkey.p8)
    APNS_KEY_ID       10-char key id from the .p8 filename
    APPLE_TEAM_ID     Apple developer team id
    PUSHDRAIN_INTERVAL_SECONDS  loop sleep, default 20
    PUSHDRAIN_ALERT_COOLDOWN    owner-alert cooldown seconds, default 21600

DEPS: requests, python-dotenv, cryptography (all in requirements.txt),
plus the system curl binary (HTTP/2 capable, stock on this droplet).
Without the three APNS_* vars the daemon still runs in
Telegram-fallback-only mode: alert rows skip straight to their
telegram_text, Live Activity rows just close. Restart after adding them.
"""

import base64
import json
import logging
import os
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

# Env FIRST, then the optional overlay, before anything reads os.environ.
_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, ".env"), override=True)
load_dotenv(os.path.join(_HERE, ".pushdrain.env"), override=True)  # optional; missing file is a no-op

import requests  # noqa: E402  (kept after load_dotenv to match house import order)
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] pushdrain: %(message)s",
)
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_OWNER_ID = os.environ.get("TELEGRAM_OWNER_ID", "").strip()
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
    one. Records the new timestamp when it returns True. Never raises."""
    try:
        state = {}
        if state_path.exists():
            state = json.loads(state_path.read_text() or "{}")
        last = float(state.get(kind, 0))
        if now - last < _ALERT_COOLDOWN_SECONDS:
            return False
        state[kind] = now
        state_path.write_text(json.dumps(state))
        return True
    except Exception:
        return True


def _alert_owner(kind: str, text: str) -> None:
    """Best-effort Telegram alert to the bot owner(s). Never raises;
    failure to alert must not break the drain loop."""
    try:
        if not _alert_due(kind, time.time(), _ALERT_STATE):
            return
        if not TELEGRAM_BOT_TOKEN or not TELEGRAM_OWNER_ID:
            log.warning("alert wanted but TELEGRAM creds unset: %s", text)
            return
        for chat_id in [o.strip() for o in TELEGRAM_OWNER_ID.split(",") if o.strip()]:
            try:
                requests.post(
                    f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                    json={"chat_id": chat_id, "text": text},
                    timeout=10,
                )
            except Exception:
                log.exception("failed sending owner alert to %s", chat_id)
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


def _apns_send(device_token, headers_cfg, aps):
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
        cmd = [
            "curl", "-s", "--http2", "--max-time", "15",
            "-o", "-", "-w", "\n%{http_code}",
            "-H", "authorization: bearer " + jwt,
            "-H", "apns-topic: " + str(headers_cfg.get("topic", "")),
            "-H", "apns-push-type: " + str(headers_cfg.get("push_type", "alert")),
            "-H", "apns-priority: " + str(headers_cfg.get("priority", 10)),
            "-H", "content-type: application/json",
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
_DEAD_TOKEN_REASONS = ("BadDeviceToken", "Unregistered", "ExpiredToken")


def _delete_dead_token(kind, token):
    """410-style cleanup, moved here from the worker. The app re-upserts
    a fresh token on next login/launch, so deleting is always safe."""
    if kind == "alert":
        _sb_delete("push_tokens", {"apns_token": "eq." + str(token)})
    else:
        _sb_delete("live_activity_tokens", {"token": "eq." + str(token)})


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


def _finish(row, error=None):
    _sb_patch("push_queue", {"id": "eq." + str(row["id"])},
              {"done_at": _now_iso(), "last_error": error})


def _park_for_retry(row, error):
    """Fallback WANTED but Telegram refused it: leave the row undone and
    un-claimed with attempts bumped, so the next loop retries Telegram
    and, once attempts max out, the 15-minute expiry sweep gives it a
    final try. Closing here would permanently lose an owner alert after
    ONE failed Telegram attempt."""
    _sb_patch("push_queue", {"id": "eq." + str(row["id"])},
              {"claimed_at": None,
               "attempts": int(row.get("attempts") or 0) + 1,
               "last_error": error})


def _process_row(row):
    """Returns (delivered_count, fell_back_bool) for the heartbeat."""
    global _LA_BLOCKED_UNTIL
    kind = row.get("kind") or "alert"
    payload = row.get("payload") or {}
    if not isinstance(payload, dict):
        _finish(row, "bad payload (not an object)")
        return (0, False)
    tokens = payload.get("tokens") or []
    headers_cfg = payload.get("headers") or {}
    aps = payload.get("aps") or {}

    # Live Activity topic is blocked: close la_* rows immediately
    # (cosmetic, perishable, no fallback). Alert rows are unaffected.
    if kind != "alert" and time.time() < _LA_BLOCKED_UNTIL:
        _finish(row, "topic-blocked")
        return (0, False)

    # APNs not configured at all: alerts skip straight to Telegram,
    # la_* rows just close. This is the old worker hasApns()=false
    # behavior, relocated. A WANTED fallback that Telegram refused
    # keeps the row alive for retries; closing on one failed Telegram
    # attempt would lose the alert forever.
    if tokens and not _APNS_CONFIGURED:
        fb = _send_fallback(row)
        if fb or not _fallback_wanted(row):
            _finish(row, "apns not configured" + (", telegram fallback sent" if fb else ""))
        else:
            _park_for_retry(row, "apns not configured, telegram fallback FAILED")
        return (0, fb)

    delivered = 0
    dead = 0
    errors = []
    for t in tokens:
        status, reason = _apns_send(t, headers_cfg, aps)
        if status == 200:
            delivered += 1
            continue
        errors.append(str(status) + " " + reason)
        if status == 410 or reason in _DEAD_TOKEN_REASONS:
            _delete_dead_token(kind, t)
            dead += 1
            continue
        if reason == "ExpiredProviderToken":
            _JWT["jwt"] = None  # mint fresh on the next send
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

    if delivered > 0:
        # matches the old worker rule: ANY device getting the banner
        # counts as delivered, no fallback, no retry for the rest.
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

    new_attempts = int(row.get("attempts") or 0) + 1
    err = ("; ".join(errors))[:300] or "unknown"
    if new_attempts >= MAX_ATTEMPTS:
        fb = _send_fallback(row)
        if fb or not _fallback_wanted(row):
            _sb_patch("push_queue", {"id": "eq." + str(row["id"])},
                      {"done_at": _now_iso(), "attempts": new_attempts,
                       "last_error": err + (", telegram fallback sent" if fb else ", no fallback configured")})
        else:
            # fallback WANTED but Telegram refused it: leave the row
            # undone (attempts maxed, so the claim query skips it) and
            # let the 15-minute expiry sweep give Telegram one more try.
            _sb_patch("push_queue", {"id": "eq." + str(row["id"])},
                      {"attempts": new_attempts, "last_error": err + ", telegram fallback FAILED"})
        return (0, fb)

    # retryable: bump attempts, record why, un-claim for the next loop
    _sb_patch("push_queue", {"id": "eq." + str(row["id"])},
              {"claimed_at": None, "attempts": new_attempts, "last_error": err})
    return (0, False)


_read_fail_streak = 0
_last_purge = 0.0


def work_once():
    global _read_fail_streak, _last_purge
    now = datetime.now(timezone.utc)
    depth = _queue_depth()
    expired_n = claimed_n = delivered_n = fellback_n = 0

    # 1) perishable sweep: anything undone and older than 15 minutes is
    # fallen back (when it has telegram_text) and closed, no matter its
    # claim or attempts state (single daemon: stale claims are ours).
    old_rows = _sb_select("push_queue", {
        "select": "*",
        "done_at": "is.null",
        "created_at": "lt." + _iso(now - timedelta(minutes=EXPIRE_MINUTES)),
        "order": "created_at.asc",
        "limit": str(BATCH_LIMIT),
    })
    for row in (old_rows or []):
        fb = _send_fallback(row)
        _finish(row, "expired before delivery" + (", telegram fallback sent" if fb else ""))
        expired_n += 1
        if fb:
            fellback_n += 1

    # 2) claim a batch: unclaimed rows, plus claims older than
    # STALE_CLAIM_MINUTES (we died mid-row on a previous run). The
    # stale predicate is REPEATED inside the claim PATCH itself so a
    # second drainer instance (e.g. the docstring's manual test run
    # alongside the systemd service) matches zero rows instead of
    # overwriting a fresh claim and double-sending - the same guarded
    # claim-PATCH discipline the worker uses on shifts.
    stale_iso = _iso(now - timedelta(minutes=STALE_CLAIM_MINUTES))
    ids = _sb_select("push_queue", {
        "select": "id",
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
            rows = _sb_patch("push_queue",
                             {"id": "in.(" + ",".join(str(r["id"]) for r in ids) + ")",
                              "done_at": "is.null",
                              "attempts": "lt." + str(MAX_ATTEMPTS),
                              "or": "(claimed_at.is.null,claimed_at.lt." + stale_iso + ")"},
                             {"claimed_at": _iso(now)}, want_rows=True)
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
                        _sb_patch("push_queue", {"id": "eq." + str(row["id"])},
                                  {"claimed_at": None,
                                   "attempts": int(row.get("attempts") or 0) + 1,
                                   "last_error": "drainer exception"})
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
