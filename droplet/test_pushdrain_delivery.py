"""Offline pushdrain delivery tests. No network or database access."""

import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pushdrain as pd


TOKEN_A = "a" * 64
TOKEN_B = "b" * 64
TOKEN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SHIFT_ID = "11111111-1111-4111-8111-111111111111"
CLAIM_STAMP = "2026-08-25T14:16:00.000Z"
QUEUE_CLAIM_STAMP = "2026-08-25T14:16:01.000Z"
QUEUE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


def end_row(attempts=0):
    return {
        "id": QUEUE_ID,
        "kind": "la_end",
        "attempts": attempts,
        "claimed_at": QUEUE_CLAIM_STAMP,
        "payload": {
            "tokens": [TOKEN_A],
            "headers": {
                "topic": "com.hamptonscoconuts.field.push-type.liveactivity",
                "push_type": "liveactivity",
                "priority": 10,
            },
            "aps": {
                "event": "end",
                "dismissal-date": 1,
                "content-state": {
                    "status": "Clocked out",
                    "statusMinutes": 135,
                    "boxesLine": "Shift ended",
                },
            },
            "telegram_text": None,
            "fallback_chat_ids": [],
            "live_activity_token_id": TOKEN_ID,
            "live_activity_shift_id": SHIFT_ID,
            "live_activity_queue_id": QUEUE_ID,
            "live_activity_end_requested_at": CLAIM_STAMP,
        },
    }


def alert_row(attempts=0):
    return {
        "id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "kind": "alert",
        "attempts": attempts,
        "claimed_at": QUEUE_CLAIM_STAMP,
        "payload": {
            "tokens": [TOKEN_A, TOKEN_B],
            "headers": {
                "topic": "com.hamptonscoconuts.field",
                "push_type": "alert",
                "priority": 10,
            },
            "aps": {"alert": {"title": "Clocked in", "body": "Test"}},
            "telegram_text": "fallback copy",
            "fallback_chat_ids": ["offline-chat"],
        },
    }


class PushdrainDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.old_configured = pd._APNS_CONFIGURED
        self.old_blocked = pd._LA_BLOCKED_UNTIL
        self.old_jwt = dict(pd._JWT)
        pd._APNS_CONFIGURED = True
        pd._LA_BLOCKED_UNTIL = 0.0

    def tearDown(self):
        pd._APNS_CONFIGURED = self.old_configured
        pd._LA_BLOCKED_UNTIL = self.old_blocked
        pd._JWT.clear()
        pd._JWT.update(self.old_jwt)

    def test_end_success_deletes_exact_token_only_after_apns_200(self):
        events = []

        def send(token, _headers, _aps, _request_id):
            events.append(("send", token))
            return (200, "")

        def delete(table, params):
            events.append(("delete", table, params))
            return True

        with patch.object(pd, "_apns_send", side_effect=send), \
             patch.object(pd, "_sb_delete", side_effect=delete), \
             patch.object(pd, "_sb_patch", return_value=True) as sb_patch, \
             patch.object(pd, "_alert_owner"):
            delivered, fell_back = pd._process_row(end_row())

        self.assertEqual((delivered, fell_back), (1, False))
        self.assertEqual(events[0], ("send", TOKEN_A))
        self.assertEqual(events[1][0:2], ("delete", "live_activity_tokens"))
        identity = events[1][2]
        self.assertEqual(identity["id"], "eq." + TOKEN_ID)
        self.assertEqual(identity["token"], "eq." + TOKEN_A)
        self.assertEqual(identity["shift_id"], "eq." + SHIFT_ID)
        self.assertEqual(identity["end_queue_id"], "eq." + QUEUE_ID)
        self.assertEqual(identity["end_requested_at"], "eq." + CLAIM_STAMP)
        self.assertTrue(any("done_at" in call.args[2] for call in sb_patch.call_args_list))

    def test_terminal_dead_end_token_is_deleted_exactly_and_not_retried(self):
        with patch.object(pd, "_apns_send", return_value=(410, "Unregistered")), \
             patch.object(pd, "_sb_delete", return_value=True) as sb_delete, \
             patch.object(pd, "_sb_patch", return_value=True) as sb_patch, \
             patch.object(pd, "_send_fallback", return_value=False) as fallback, \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(end_row())

        self.assertEqual(result, (0, False))
        sb_delete.assert_called_once()
        self.assertEqual(sb_delete.call_args.args[0], "live_activity_tokens")
        fallback.assert_called_once()
        self.assertTrue(any("done_at" in call.args[2] for call in sb_patch.call_args_list))

    def test_partial_alert_retries_only_failed_phone_and_never_falls_back(self):
        patches = []

        def record_patch(table, params, body, want_rows=False):
            patches.append((table, params, copy.deepcopy(body), want_rows))
            return True

        send = Mock(side_effect=[(200, ""), (503, "ServiceUnavailable")])
        with patch.object(pd, "_apns_send", send), \
             patch.object(pd, "_sb_patch", side_effect=record_patch), \
             patch.object(pd, "_sb_delete", return_value=True), \
             patch.object(pd, "_send_fallback") as fallback, \
             patch.object(pd, "_alert_owner"):
            delivered, fell_back = pd._process_row(alert_row())
            self.assertEqual((delivered, fell_back), (1, False))
            retry_body = next(body for table, _params, body, _want in patches
                              if table == "push_queue" and "payload" in body)
            self.assertEqual(retry_body["payload"]["tokens"], [TOKEN_B])
            self.assertTrue(retry_body["payload"]["delivery_succeeded"])
            self.assertIsNone(retry_body["claimed_at"])

            retry_row = alert_row(attempts=1)
            retry_row["payload"] = retry_body["payload"]
            send.reset_mock()
            send.side_effect = None
            send.return_value = (200, "")
            pd._process_row(retry_row)

        self.assertEqual([call.args[0] for call in send.call_args_list], [TOKEN_B])
        fallback.assert_not_called()

    def test_partial_delivery_patch_failure_retries_state_write_before_return(self):
        send = Mock(side_effect=[(200, ""), (503, "ServiceUnavailable")])
        persist = Mock(side_effect=[False, False, True])
        with patch.object(pd, "_apns_send", send), \
             patch.object(pd, "_refresh_queue_claim", return_value=True), \
             patch.object(pd, "_sb_patch", persist), \
             patch.object(pd, "_sb_delete", return_value=True), \
             patch.object(pd.time, "sleep"), \
             patch.object(pd, "_send_fallback") as fallback, \
             patch.object(pd, "_alert_owner") as alert:
            result = pd._process_row(alert_row())

        self.assertEqual(result, (1, False))
        self.assertEqual(send.call_count, 2)
        self.assertEqual(persist.call_count, 3)
        for call in persist.call_args_list:
            self.assertEqual(call.args[2]["payload"]["tokens"], [TOKEN_B])
            self.assertTrue(call.args[2]["payload"]["delivery_succeeded"])
        fallback.assert_not_called()
        alert.assert_not_called()

    def test_claim_refresh_rotates_only_the_exact_owned_lease(self):
        row = alert_row()
        new_stamp = "2026-08-25T14:16:20.000Z"
        with patch.object(pd, "_now_iso", return_value=new_stamp), \
             patch.object(pd, "_sb_patch",
                          return_value=[{"claimed_at": new_stamp}]) as refresh:
            refreshed = pd._refresh_queue_claim(row)

        self.assertTrue(refreshed)
        params = refresh.call_args.args[1]
        self.assertEqual(params["id"], "eq." + row["id"])
        self.assertEqual(params["claimed_at"], "eq." + QUEUE_CLAIM_STAMP)
        self.assertEqual(params["done_at"], "is.null")
        self.assertEqual(refresh.call_args.args[2], {"claimed_at": new_stamp})
        self.assertTrue(refresh.call_args.kwargs["want_rows"])
        self.assertEqual(row["claimed_at"], new_stamp)

    def test_long_row_refreshes_before_every_later_apns_destination(self):
        row = alert_row()
        row["payload"]["tokens"] = [format(i + 1, "064x") for i in range(14)]
        send = Mock(return_value=(200, ""))
        with patch.object(pd, "_refresh_queue_claim", return_value=True) as refresh, \
             patch.object(pd, "_apns_send", send), \
             patch.object(pd, "_sb_patch", return_value=True), \
             patch.object(pd, "_sb_delete", return_value=True), \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(row)

        self.assertEqual(result, (14, False))
        self.assertEqual(send.call_count, 14)
        self.assertEqual(refresh.call_count, 13)

    def test_long_row_stops_when_second_drainer_wins_refresh(self):
        row = alert_row()
        row["payload"]["tokens"] = [format(i + 1, "064x") for i in range(14)]
        send = Mock(return_value=(200, ""))
        refresh_results = [True] * 6 + [False]
        with patch.object(pd, "_refresh_queue_claim",
                          side_effect=refresh_results) as refresh, \
             patch.object(pd, "_apns_send", send), \
             patch.object(pd, "_sb_patch") as persist, \
             patch.object(pd, "_sb_delete", return_value=True), \
             patch.object(pd, "_send_fallback") as fallback, \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(row)

        self.assertEqual(result, (7, False))
        self.assertEqual(send.call_count, 7)
        self.assertEqual(refresh.call_count, 7)
        persist.assert_not_called()
        fallback.assert_not_called()

    def test_finish_patch_failure_is_bounded_and_does_not_resend_in_same_pass(self):
        send = Mock(return_value=(200, ""))
        with patch.object(pd, "_apns_send", send), \
             patch.object(pd, "_sb_delete", return_value=True), \
             patch.object(pd, "_sb_patch", return_value=False) as persist, \
             patch.object(pd.time, "sleep"), \
             patch.object(pd, "_alert_owner") as alert:
            result = pd._process_row(end_row())

        self.assertEqual(result, (1, False))
        send.assert_called_once()
        self.assertEqual(persist.call_count, 3)
        self.assertTrue(all("done_at" in call.args[2]
                            for call in persist.call_args_list))
        alert.assert_called_once()
        self.assertEqual(alert.call_args.args[0], "queue_state_write")

    def test_stale_drainer_cannot_finish_after_newer_claim_wins(self):
        stale_row = alert_row()
        stale_row["claimed_at"] = "2026-08-25T14:00:00.000Z"
        with patch.object(pd, "_sb_patch", return_value=[]) as persist, \
             patch.object(pd, "_alert_owner") as alert:
            saved = pd._finish(stale_row, "old drainer finished late")

        self.assertFalse(saved)
        persist.assert_called_once()
        params = persist.call_args.args[1]
        self.assertEqual(params["id"], "eq." + stale_row["id"])
        self.assertEqual(params["claimed_at"],
                         "eq." + stale_row["claimed_at"])
        self.assertEqual(params["done_at"], "is.null")
        self.assertTrue(persist.call_args.kwargs["want_rows"])
        alert.assert_not_called()

    def test_lost_finish_response_verifies_committed_done_state(self):
        done_stamp = "2026-08-25T14:17:00.000Z"
        committed = {
            "id": QUEUE_ID,
            "claimed_at": QUEUE_CLAIM_STAMP,
            "done_at": done_stamp,
            "last_error": None,
        }
        with patch.object(pd, "_now_iso", return_value=done_stamp), \
             patch.object(pd, "_sb_patch", return_value=None) as persist, \
             patch.object(pd, "_sb_select", return_value=[committed]) as verify, \
             patch.object(pd, "_alert_owner") as alert:
            saved = pd._finish(end_row(), None)

        self.assertTrue(saved)
        persist.assert_called_once()
        verify.assert_called_once()
        alert.assert_not_called()

    def test_apns_retry_uses_stable_request_and_collapse_headers(self):
        completed = Mock(returncode=0, stdout="\n200", stderr="")
        headers = {
            "topic": "com.hamptonscoconuts.field",
            "push_type": "alert",
            "priority": 10,
            "collapse_id": QUEUE_ID,
        }
        with patch.object(pd, "_apns_jwt", return_value="offline-jwt"), \
             patch.object(pd.subprocess, "run", return_value=completed) as run:
            result = pd._apns_send(TOKEN_A, headers, {"alert": "test"}, QUEUE_ID)

        self.assertEqual(result, (200, ""))
        command = run.call_args.args[0]
        self.assertIn("apns-id: " + QUEUE_ID, command)
        self.assertIn("apns-collapse-id: " + QUEUE_ID, command)

    def test_temporary_end_failure_stays_retryable_without_token_delete(self):
        with patch.object(pd, "_apns_send", return_value=(503, "ServiceUnavailable")), \
             patch.object(pd, "_sb_patch", return_value=True) as sb_patch, \
             patch.object(pd, "_sb_delete") as sb_delete, \
             patch.object(pd, "_alert_owner") as alert:
            result = pd._process_row(end_row(attempts=0))

        self.assertEqual(result, (0, False))
        sb_delete.assert_not_called()
        alert.assert_not_called()
        retry = next(call.args[2] for call in sb_patch.call_args_list
                     if call.args[0] == "push_queue" and "payload" in call.args[2])
        self.assertEqual(retry["payload"]["tokens"], [TOKEN_A])
        self.assertIsNone(retry["claimed_at"])
        self.assertEqual(retry["attempts"], 1)

    def test_expired_provider_login_retries_without_live_activity_topic_block(self):
        pd._JWT["jwt"] = "expired-offline-token"
        pd._JWT["at"] = 1.0
        with patch.object(pd, "_apns_send", return_value=(403, "ExpiredProviderToken")), \
             patch.object(pd, "_sb_patch", return_value=True) as sb_patch, \
             patch.object(pd, "_sb_delete") as sb_delete, \
             patch.object(pd, "_alert_owner") as alert:
            result = pd._process_row(end_row())

        self.assertEqual(result, (0, False))
        self.assertIsNone(pd._JWT["jwt"])
        self.assertEqual(pd._LA_BLOCKED_UNTIL, 0.0)
        sb_delete.assert_not_called()
        alert.assert_not_called()
        retry = next(call.args[2] for call in sb_patch.call_args_list
                     if "payload" in call.args[2])
        self.assertEqual(retry["payload"]["tokens"], [TOKEN_A])
        self.assertEqual(retry["attempts"], 1)

    def test_partial_delivery_survives_temporary_missing_apns_config(self):
        row = alert_row(attempts=1)
        row["payload"]["tokens"] = [TOKEN_B]
        row["payload"]["delivery_succeeded"] = True
        pd._APNS_CONFIGURED = False

        with patch.object(pd, "_sb_patch", return_value=True) as sb_patch, \
             patch.object(pd, "_send_fallback") as fallback, \
             patch.object(pd, "_apns_send") as send:
            result = pd._process_row(row)

        self.assertEqual(result, (0, False))
        send.assert_not_called()
        fallback.assert_not_called()
        retry = next(call.args[2] for call in sb_patch.call_args_list
                     if "payload" in call.args[2])
        self.assertEqual(retry["payload"]["tokens"], [TOKEN_B])
        self.assertTrue(retry["payload"]["delivery_succeeded"])
        self.assertEqual(retry["attempts"], 2)
        self.assertIsNone(retry["claimed_at"])

    def test_exhausted_end_releases_exact_lease_and_rate_limited_alert_path(self):
        patches = []

        def record_patch(table, params, body, want_rows=False):
            patches.append((table, params, copy.deepcopy(body), want_rows))
            return True

        with patch.object(pd, "_apns_send", return_value=(503, "ServiceUnavailable")), \
             patch.object(pd, "_sb_patch", side_effect=record_patch), \
             patch.object(pd, "_sb_delete") as sb_delete, \
             patch.object(pd, "_alert_owner") as alert:
            result = pd._process_row(end_row(attempts=pd.MAX_ATTEMPTS - 1))

        self.assertEqual(result, (0, False))
        sb_delete.assert_not_called()
        release = next((params, body) for table, params, body, _want in patches
                       if table == "live_activity_tokens")
        self.assertEqual(release[0]["id"], "eq." + TOKEN_ID)
        self.assertEqual(release[0]["token"], "eq." + TOKEN_A)
        self.assertEqual(release[0]["end_queue_id"], "eq." + QUEUE_ID)
        self.assertEqual(release[0]["end_requested_at"], "eq." + CLAIM_STAMP)
        self.assertEqual(release[1], {
            "end_requested_at": None,
            "end_queue_id": None,
        })
        finished = next(body for table, _params, body, _want in patches
                        if table == "push_queue" and "done_at" in body)
        self.assertEqual(finished["attempts"], pd.MAX_ATTEMPTS)
        alert.assert_called_once()
        self.assertEqual(alert.call_args.args[0], "la_end_exhausted")

    def test_total_alert_failure_preserves_telegram_fallback(self):
        with patch.object(pd, "_apns_send", return_value=(503, "ServiceUnavailable")), \
             patch.object(pd, "_sb_patch", return_value=True) as sb_patch, \
             patch.object(pd, "_send_fallback", return_value=True) as fallback, \
             patch.object(pd, "_alert_owner"):
            delivered, fell_back = pd._process_row(
                alert_row(attempts=pd.MAX_ATTEMPTS - 1),
            )

        self.assertEqual((delivered, fell_back), (0, True))
        fallback.assert_called_once()
        done_body = next(call.args[2] for call in sb_patch.call_args_list
                         if "done_at" in call.args[2])
        self.assertIn("telegram fallback sent", done_body["last_error"])

    def test_expiry_loser_does_not_fallback_or_release_another_drainers_row(self):
        old_purge = pd._last_purge
        old_streak = pd._read_fail_streak
        pd._last_purge = time.time()
        pd._read_fail_streak = 0
        try:
            with patch.object(pd, "_queue_depth", return_value=1), \
                 patch.object(pd, "_sb_select",
                              side_effect=[[{"id": QUEUE_ID}], []]), \
                 patch.object(pd, "_sb_patch", return_value=[]) as claim, \
                 patch.object(pd, "_process_row") as process, \
                 patch.object(pd, "_send_fallback") as fallback, \
                 patch.object(pd, "_release_live_activity_end") as release, \
                 patch.object(pd, "_alert_owner") as alert, \
                 patch.object(pd, "_sb_delete"):
                pd.work_once()
        finally:
            pd._last_purge = old_purge
            pd._read_fail_streak = old_streak

        self.assertEqual(claim.call_count, 1)
        params = claim.call_args.args[1]
        self.assertIn("created_at", params)
        self.assertIn("claimed_at.is.null", params["or"])
        self.assertTrue(claim.call_args.kwargs["want_rows"])
        process.assert_not_called()
        fallback.assert_not_called()
        release.assert_not_called()
        alert.assert_not_called()

    def test_normal_rows_are_claimed_just_before_each_is_processed(self):
        row_a = alert_row()
        row_b = alert_row()
        row_b["id"] = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        events = []

        def claim_one(_table, params, body, want_rows=False):
            self.assertTrue(want_rows)
            row = row_a if row_a["id"] in params["id"] else row_b
            events.append(("claim", row["id"]))
            return [{**row, "claimed_at": body["claimed_at"]}]

        def process(row):
            events.append(("process", row["id"]))
            return (0, False)

        old_purge = pd._last_purge
        old_streak = pd._read_fail_streak
        pd._last_purge = time.time()
        pd._read_fail_streak = 0
        try:
            with patch.object(pd, "_queue_depth", return_value=2), \
                 patch.object(pd, "_sb_select", side_effect=[[], [
                     {"id": row_a["id"]}, {"id": row_b["id"]},
                 ]]), \
                 patch.object(pd, "_sb_patch", side_effect=claim_one), \
                 patch.object(pd, "_process_row", side_effect=process), \
                 patch.object(pd, "_sb_delete"):
                pd.work_once()
        finally:
            pd._last_purge = old_purge
            pd._read_fail_streak = old_streak

        self.assertEqual(events, [
            ("claim", row_a["id"]),
            ("process", row_a["id"]),
            ("claim", row_b["id"]),
            ("process", row_b["id"]),
        ])

    def test_failed_operator_alert_does_not_start_cooldown(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "alert-state.json"
            refused = Mock(ok=False, status_code=500, text="offline refusal")
            accepted = Mock(ok=True, status_code=200, text="ok")
            with patch.object(pd, "_ALERT_STATE", state_path), \
                 patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-token"), \
                 patch.object(pd, "TELEGRAM_OWNER_ID", "offline-owner"), \
                 patch.object(pd.requests, "post", return_value=refused) as post:
                pd._alert_owner("retry-me", "offline test")
                pd._alert_owner("retry-me", "offline test")
                self.assertEqual(post.call_count, 2)
                self.assertFalse(state_path.exists())

            with patch.object(pd, "_ALERT_STATE", state_path), \
                 patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-token"), \
                 patch.object(pd, "TELEGRAM_OWNER_ID", "offline-owner"), \
                 patch.object(pd.requests, "post", return_value=accepted) as post:
                pd._alert_owner("retry-me", "offline test")
                pd._alert_owner("retry-me", "offline test")
                self.assertEqual(post.call_count, 1)
                state = json.loads(state_path.read_text())
                self.assertIn("retry-me", state)


if __name__ == "__main__":
    unittest.main(verbosity=2)
