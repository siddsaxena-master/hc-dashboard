"""Offline tests for the temporary migration-017 END sender."""

import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import enddrain017 as ed  # noqa: E402

TOKEN_ID = "11111111-1111-4111-8111-111111111111"
QUEUE_ID = "22222222-2222-4222-8222-222222222222"
SHIFT_ID = "33333333-3333-4333-8333-333333333333"
TOKEN = "a" * 64
CLAIM_STAMP = "2026-08-27T20:00:00.000Z"


def end_row(attempts=0):
    return {
        "id": QUEUE_ID,
        "kind": "la_end",
        "claimed_at": CLAIM_STAMP,
        "done_at": None,
        "attempts": attempts,
        "payload": {
            "tokens": [TOKEN],
            "headers": {
                "topic": ed.LIVE_ACTIVITY_TOPIC,
                "push_type": "liveactivity",
                "priority": 10,
                "collapse_id": QUEUE_ID,
            },
            "aps": {
                "timestamp": 1787857200,
                "event": "end",
                "content-state": {
                    "status": "Clocked out",
                    "statusMinutes": 135,
                    "boxesLine": "Shift ended",
                },
                "dismissal-date": 1787857199,
            },
            "telegram_text": None,
            "fallback_chat_ids": [],
            "live_activity_token_id": TOKEN_ID,
            "live_activity_shift_id": SHIFT_ID,
            "live_activity_queue_id": QUEUE_ID,
            "live_activity_end_requested_at": CLAIM_STAMP,
        },
    }


class EndDrain017Tests(unittest.TestCase):
    def setUp(self):
        ed._TOPIC_BLOCKED_UNTIL = 0.0
        ed._JWT["jwt"] = None

    def test_source_uses_only_schema_017_queue_contract(self):
        source = Path(ed.__file__).read_text(encoding="utf-8")
        for forbidden in (
                "outbox" + "_type",
                "next" + "_attempt_at",
                "dead" + "_lettered_at"):
            self.assertNotIn(forbidden, source)
        self.assertNotIn("push_tokens", source)
        self.assertNotIn("delete(\"push_queue\"", source)

    def test_exact_identity_contains_every_migration_017_guard(self):
        identity = ed._end_identity(end_row(), TOKEN)
        self.assertEqual(identity, {
            "id": "eq." + TOKEN_ID,
            "token": "eq." + TOKEN,
            "token_type": "eq.activity_update",
            "shift_id": "eq." + SHIFT_ID,
            "end_queue_id": "eq." + QUEUE_ID,
            "end_requested_at": "eq." + CLAIM_STAMP,
        })

    def test_success_deletes_exact_token_then_finishes_owned_queue(self):
        events = []
        with patch.object(ed, "_exact_token_present", return_value=True), \
                patch.object(ed, "_apns_configured", return_value=True), \
                patch.object(ed, "_apns_send", return_value=(200, "")), \
                patch.object(ed, "_delete_exact_token",
                             side_effect=lambda _identity: events.append("delete") or True), \
                patch.object(ed, "_finish_queue",
                             side_effect=lambda *_args, **_kwargs: events.append("finish") or True):
            self.assertEqual(ed._process_row(end_row()), "delivered")
        self.assertEqual(events, ["delete", "finish"])

    def test_every_terminal_dead_reason_cleans_exact_token(self):
        for reason in sorted(ed.TERMINAL_TOKEN_REASONS):
            with self.subTest(reason=reason), \
                    patch.object(ed, "_exact_token_present", return_value=True), \
                    patch.object(ed, "_apns_configured", return_value=True), \
                    patch.object(ed, "_apns_send", return_value=(400, reason)), \
                    patch.object(ed, "_delete_exact_token", return_value=True) as delete, \
                    patch.object(ed, "_finish_queue", return_value=True):
                self.assertEqual(ed._process_row(end_row()), "terminal_cleaned")
                delete.assert_called_once()

    def test_http_410_is_terminal_even_without_reason(self):
        with patch.object(ed, "_exact_token_present", return_value=True), \
                patch.object(ed, "_apns_configured", return_value=True), \
                patch.object(ed, "_apns_send", return_value=(410, "")), \
                patch.object(ed, "_delete_exact_token", return_value=True), \
                patch.object(ed, "_finish_queue", return_value=True):
            self.assertEqual(ed._process_row(end_row()), "terminal_cleaned")

    def test_temporary_failure_parks_without_deleting_or_releasing(self):
        with patch.object(ed, "_exact_token_present", return_value=True), \
                patch.object(ed, "_apns_configured", return_value=True), \
                patch.object(ed, "_apns_send", return_value=(503, "Unavailable")), \
                patch.object(ed, "_park_retry", return_value=True) as park, \
                patch.object(ed, "_delete_exact_token") as delete, \
                patch.object(ed, "_release_exact_lease") as release:
            self.assertEqual(ed._process_row(end_row()), "retry")
            park.assert_called_once()
            delete.assert_not_called()
            release.assert_not_called()

    def test_retry_exhaustion_closes_before_exact_lease_release(self):
        events = []
        with patch.object(ed, "_exact_token_present", return_value=True), \
                patch.object(ed, "_apns_configured", return_value=True), \
                patch.object(ed, "_apns_send", return_value=(503, "Unavailable")), \
                patch.object(ed, "_finish_queue",
                             side_effect=lambda *_args, **_kwargs: events.append("finish") or True), \
                patch.object(ed, "_release_exact_lease",
                             side_effect=lambda _identity: events.append("release") or True):
            self.assertEqual(
                ed._process_row(end_row(attempts=ed.MAX_ATTEMPTS - 1)),
                "exhausted_released",
            )
        self.assertEqual(events, ["finish", "release"])

    def test_failed_queue_close_never_releases_token_lease(self):
        with patch.object(ed, "_exact_token_present", return_value=True), \
                patch.object(ed, "_apns_configured", return_value=True), \
                patch.object(ed, "_apns_send", return_value=(503, "Unavailable")), \
                patch.object(ed, "_finish_queue", return_value=False), \
                patch.object(ed, "_release_exact_lease") as release:
            self.assertEqual(
                ed._process_row(end_row(attempts=ed.MAX_ATTEMPTS - 1)),
                "finish_failed",
            )
            release.assert_not_called()

    def test_topic_rejection_blocks_without_cleanup_or_attempt_exhaustion(self):
        with patch.object(ed, "_exact_token_present", return_value=True), \
                patch.object(ed, "_apns_configured", return_value=True), \
                patch.object(ed, "_apns_send", return_value=(403, "TopicDisallowed")), \
                patch.object(ed, "_park_retry", return_value=True) as park, \
                patch.object(ed, "_delete_exact_token") as delete, \
                patch.object(ed, "_release_exact_lease") as release:
            self.assertEqual(ed._process_row(end_row()), "topic_blocked")
            self.assertGreater(ed._TOPIC_BLOCKED_UNTIL, 0)
            self.assertFalse(park.call_args.kwargs["increment"])
            delete.assert_not_called()
            release.assert_not_called()

    def test_expired_provider_token_refreshes_and_retries_without_blocking(self):
        ed._JWT["jwt"] = "expired-login"
        with patch.object(ed, "_exact_token_present", return_value=True), \
                patch.object(ed, "_apns_configured", return_value=True), \
                patch.object(
                    ed, "_apns_send", return_value=(403, "ExpiredProviderToken")), \
                patch.object(ed, "_park_retry", return_value=True) as park, \
                patch.object(ed, "_delete_exact_token") as delete, \
                patch.object(ed, "_release_exact_lease") as release:
            self.assertEqual(ed._process_row(end_row()), "retry")
            self.assertIsNone(ed._JWT["jwt"])
            self.assertEqual(ed._TOPIC_BLOCKED_UNTIL, 0.0)
            park.assert_called_once()
            delete.assert_not_called()
            release.assert_not_called()

    def test_malformed_identity_never_reaches_apple_or_token_mutation(self):
        row = end_row()
        row["payload"]["tokens"] = ["not-hex"]
        with patch.object(ed, "_apns_send") as send, \
                patch.object(ed, "_finish_queue", return_value=True), \
                patch.object(ed, "_delete_exact_token") as delete, \
                patch.object(ed, "_release_exact_lease") as release:
            self.assertEqual(ed._process_row(row), "malformed")
            send.assert_not_called()
            delete.assert_not_called()
            release.assert_not_called()

    def test_valid_identity_with_bad_aps_releases_only_after_queue_close(self):
        row = end_row()
        row["payload"]["aps"] = []
        events = []
        with patch.object(ed, "_finish_queue",
                          side_effect=lambda *_args, **_kwargs: events.append("finish") or True), \
                patch.object(ed, "_release_exact_lease",
                             side_effect=lambda _identity: events.append("release") or True), \
                patch.object(ed, "_apns_send") as send:
            self.assertEqual(ed._process_row(row), "malformed")
            send.assert_not_called()
        self.assertEqual(events, ["finish", "release"])

    def test_claim_is_compare_and_set_and_filters_end_kind_only(self):
        patch_calls = []

        def fake_select(table, params):
            self.assertEqual(table, "push_queue")
            self.assertEqual(params["kind"], "eq.la_end")
            self.assertEqual(params["done_at"], "is.null")
            return [{"id": QUEUE_ID}]

        def fake_patch(table, params, body):
            patch_calls.append((table, params, body))
            return [end_row()]

        with patch.object(ed, "_sb_select", side_effect=fake_select), \
                patch.object(ed, "_sb_patch", side_effect=fake_patch):
            rows = ed._claim_rows(datetime(2026, 8, 27, 20, tzinfo=timezone.utc))
        self.assertEqual(len(rows), 1)
        table, params, body = patch_calls[0]
        self.assertEqual(table, "push_queue")
        self.assertEqual(params["kind"], "eq.la_end")
        self.assertEqual(params["id"], "eq." + QUEUE_ID)
        self.assertIn("claimed_at.is.null", params["or"])
        self.assertEqual(set(body), {"claimed_at"})

    def test_local_single_consumer_lock_rejects_second_copy(self):
        class FakeFcntl:
            LOCK_EX = 1
            LOCK_NB = 2
            LOCK_UN = 4

            def __init__(self):
                self.held = False

            def flock(self, _file_number, operation):
                if operation == self.LOCK_UN:
                    self.held = False
                elif self.held:
                    raise OSError("already locked")
                else:
                    self.held = True

        fake_lock = FakeFcntl()
        with patch.object(ed, "_fcntl", fake_lock), \
                patch.object(ed, "_msvcrt", None):
            with ed.single_consumer_lock(os.devnull):
                with self.assertRaises(ed.ConsumerAlreadyRunning):
                    with ed.single_consumer_lock(os.devnull):
                        pass

    def test_work_loop_stops_after_first_topic_rejection(self):
        rows = [end_row(), {**end_row(), "id":
                "44444444-4444-4444-8444-444444444444"}]
        with patch.object(ed, "_claim_rows", return_value=rows), \
                patch.object(ed, "_process_row", side_effect=["topic_blocked", "delivered"]) as process:
            result = ed.work_once()
        self.assertTrue(result["blocked"])
        self.assertEqual(process.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
