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
START_DELIVERY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
START_DEVICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
OUTBOX_CURRENT_KEY = bytes(range(32))
OUTBOX_PREVIOUS_KEY = bytes(reversed(range(32)))
OUTBOX_CURRENT_CONFIG = "current:" + pd.base64.b64encode(
    OUTBOX_CURRENT_KEY).decode("ascii")
OUTBOX_PREVIOUS_CONFIG = "previous:" + pd.base64.b64encode(
    OUTBOX_PREVIOUS_KEY).decode("ascii")


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


def telegram_outbox_row(queue_id, chat_id, text, attempts=0,
                        key=OUTBOX_CURRENT_KEY, key_version="current"):
    nonce = bytes(range(12))
    aad = ("hc-telegram-outbox-v2\0" + key_version + "\0"
           + queue_id).encode("utf-8")
    plaintext = json.dumps({
        "chat_id": chat_id,
        "text": text,
    }, separators=(",", ":")).encode("utf-8")
    ciphertext = pd.AESGCM(key).encrypt(nonce, plaintext, aad)
    return {
        "id": queue_id,
        "kind": "alert",
        "outbox_type": "webhook_telegram",
        "attempts": attempts,
        "claimed_at": QUEUE_CLAIM_STAMP,
        "next_attempt_at": "2026-08-25T14:00:00.000Z",
        "payload": {
            "tokens": [],
            "headers": {},
            "aps": {},
            "telegram_outbox": {
                "version": 2,
                "key_version": key_version,
                "nonce": pd.base64.b64encode(nonce).decode("ascii"),
                "ciphertext": pd.base64.b64encode(ciphertext).decode("ascii"),
            },
        },
    }


def start_row(attempts=0):
    return {
        "id": QUEUE_ID,
        "kind": "la_start",
        "attempts": attempts,
        "claimed_at": QUEUE_CLAIM_STAMP,
        "payload": {
            "tokens": [TOKEN_A],
            "headers": {
                "topic": "com.hamptonscoconuts.field.push-type.liveactivity",
                "push_type": "liveactivity",
                "priority": 10,
                "collapse_id": QUEUE_ID,
            },
            "aps": {
                "event": "start",
                "attributes-type": "ShiftAttributes",
                "attributes": {"shiftId": SHIFT_ID},
                "content-state": {"status": "At NJ Garage",
                                  "statusMinutes": 0},
            },
            "telegram_text": None,
            "fallback_chat_ids": [],
            "live_activity_start_delivery_id": START_DELIVERY_ID,
            "live_activity_start_shift_id": SHIFT_ID,
            "live_activity_start_device_id": START_DEVICE_ID,
            "live_activity_start_queue_id": QUEUE_ID,
            "live_activity_start_generation": 1,
            "live_activity_start_claimed_at": CLAIM_STAMP,
        },
    }


class PushdrainDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.old_configured = pd._APNS_CONFIGURED
        self.old_blocked = pd._LA_BLOCKED_UNTIL
        self.old_jwt = dict(pd._JWT)
        self.old_outbox_current = pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT
        self.old_outbox_previous = pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS
        self.old_webhook_config_warning_at = pd._WEBHOOK_CONFIG_WARNING_AT
        pd._APNS_CONFIGURED = True
        pd._LA_BLOCKED_UNTIL = 0.0
        pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT = OUTBOX_CURRENT_CONFIG
        pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS = ""
        pd._WEBHOOK_CONFIG_WARNING_AT = 0.0

    def tearDown(self):
        pd._APNS_CONFIGURED = self.old_configured
        pd._LA_BLOCKED_UNTIL = self.old_blocked
        pd._JWT.clear()
        pd._JWT.update(self.old_jwt)
        pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT = self.old_outbox_current
        pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS = self.old_outbox_previous
        pd._WEBHOOK_CONFIG_WARNING_AT = self.old_webhook_config_warning_at

    def test_start_success_rechecks_open_shift_and_records_before_queue_close(self):
        events = []

        def send(_token, headers, _aps, _request_id):
            self.assertEqual(headers["expiration"], 0)
            events.append("send")
            return (200, "")

        def record(_row, _token, outcome, reason=None):
            events.append("record-" + outcome)
            self.assertIsNone(reason)
            return True

        def save_state(_table, _params, body, want_rows=False):
            if "done_at" in body:
                events.append("finish")
            return True

        with patch.object(pd, "_validate_live_activity_start",
                          return_value=True) as validate, \
             patch.object(pd, "_apns_send", side_effect=send), \
             patch.object(pd, "_record_live_activity_start_result",
                          side_effect=record), \
             patch.object(pd, "_sb_patch", side_effect=save_state), \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(start_row())

        self.assertEqual(result, (1, False))
        validate.assert_called_once()
        self.assertEqual(events, ["send", "record-delivered", "finish"])

    def test_closed_start_is_finished_without_contacting_apple(self):
        with patch.object(pd, "_validate_live_activity_start",
                          return_value=False), \
             patch.object(pd, "_apns_send") as send, \
             patch.object(pd, "_sb_patch", return_value=True) as state, \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(start_row())

        self.assertEqual(result, (0, False))
        send.assert_not_called()
        done = next(call.args[2] for call in state.call_args_list
                    if "done_at" in call.args[2])
        self.assertEqual(done["last_error"],
                         "Live Activity START no longer eligible")

    def test_malformed_start_receipt_is_rejected_before_any_send(self):
        row = start_row()
        row["payload"]["live_activity_start_delivery_id"] = "not-a-uuid"
        with patch.object(pd, "_validate_live_activity_start") as validate, \
             patch.object(pd, "_apns_send") as send, \
             patch.object(pd, "_sb_patch", return_value=True), \
             patch.object(pd, "_alert_owner") as alert:
            result = pd._process_row(row)

        self.assertEqual(result, (0, False))
        validate.assert_not_called()
        send.assert_not_called()
        alert.assert_called_once()

    def test_non_object_start_headers_are_rejected_before_any_send(self):
        row = start_row()
        row["payload"]["headers"] = ["not", "an", "object"]
        with patch.object(pd, "_validate_live_activity_start") as validate, \
             patch.object(pd, "_apns_send") as send, \
             patch.object(pd, "_sb_patch", return_value=True) as state:
            result = pd._process_row(row)

        self.assertEqual(result, (0, False))
        validate.assert_not_called()
        send.assert_not_called()
        done = next(call.args[2] for call in state.call_args_list
                    if "done_at" in call.args[2])
        self.assertEqual(done["last_error"],
                         "bad payload (headers is not an object)")

    def test_non_object_start_aps_is_rejected_before_any_send(self):
        row = start_row()
        row["payload"]["aps"] = "not an object"
        with patch.object(pd, "_validate_live_activity_start") as validate, \
             patch.object(pd, "_apns_send") as send, \
             patch.object(pd, "_sb_patch", return_value=True) as state:
            result = pd._process_row(row)

        self.assertEqual(result, (0, False))
        validate.assert_not_called()
        send.assert_not_called()
        done = next(call.args[2] for call in state.call_args_list
                    if "done_at" in call.args[2])
        self.assertEqual(done["last_error"],
                         "bad payload (aps is not an object)")

    def test_start_eligibility_read_failure_retries_without_sending(self):
        with patch.object(pd, "_validate_live_activity_start",
                          return_value=None), \
             patch.object(pd, "_apns_send") as send, \
             patch.object(pd, "_sb_patch", return_value=True) as state, \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(start_row())

        self.assertEqual(result, (0, False))
        send.assert_not_called()
        retry = next(call.args[2] for call in state.call_args_list
                     if call.args[2].get("claimed_at", "missing") is None)
        self.assertEqual(retry["attempts"], 1)
        self.assertIn("eligibility check unavailable", retry["last_error"])

    def test_dead_start_token_is_recorded_terminal_before_exact_cleanup(self):
        events = []

        def record(_row, _token, outcome, reason=None):
            events.append(("record", outcome, reason))
            return True

        def cleanup(_row, _token):
            events.append(("delete",))
            return True

        with patch.object(pd, "_validate_live_activity_start",
                          return_value=True), \
             patch.object(pd, "_apns_send",
                          return_value=(410, "Unregistered")), \
             patch.object(pd, "_record_live_activity_start_result",
                          side_effect=record), \
             patch.object(pd, "_delete_live_activity_start_token",
                          side_effect=cleanup), \
             patch.object(pd, "_sb_patch", return_value=True), \
             patch.object(pd, "_send_fallback", return_value=False), \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(start_row())

        self.assertEqual(result, (0, False))
        self.assertEqual(events[0][0:2], ("record", "terminal"))
        self.assertIn("410 Unregistered", events[0][2])
        self.assertEqual(events[1], ("delete",))

    def test_token_not_for_topic_is_terminal_and_never_retried(self):
        with patch.object(pd, "_validate_live_activity_start",
                          return_value=True), \
             patch.object(pd, "_apns_send",
                          return_value=(400, "DeviceTokenNotForTopic")), \
             patch.object(pd, "_record_live_activity_start_result",
                          return_value=True) as record, \
             patch.object(pd, "_delete_live_activity_start_token",
                          return_value=True) as cleanup, \
             patch.object(pd, "_sb_patch", return_value=True) as state, \
             patch.object(pd, "_send_fallback", return_value=False), \
             patch.object(pd, "_alert_owner"):
            result = pd._process_row(start_row())

        self.assertEqual(result, (0, False))
        record.assert_called_once()
        self.assertEqual(record.call_args.args[2], "terminal")
        self.assertIn("400 DeviceTokenNotForTopic", record.call_args.args[3])
        cleanup.assert_called_once()
        retry_writes = [call for call in state.call_args_list
                        if "payload" in call.args[2]]
        self.assertEqual(retry_writes, [])

    def test_lost_start_receipt_write_latches_success_and_never_resends(self):
        saved_bodies = []

        def patch_state(_table, _params, body, want_rows=False):
            saved_bodies.append(copy.deepcopy(body))
            return True

        first = start_row()
        with patch.object(pd, "_validate_live_activity_start",
                          return_value=True), \
             patch.object(pd, "_apns_send", return_value=(200, "")) as send, \
             patch.object(pd, "_record_live_activity_start_result",
                          return_value=False), \
             patch.object(pd, "_sb_patch", side_effect=patch_state), \
             patch.object(pd, "_alert_owner"):
            self.assertEqual(pd._process_row(first), (1, False))

        latched = next(body for body in saved_bodies if "payload" in body)
        self.assertTrue(latched["payload"]["delivery_succeeded"])
        self.assertIsNone(latched["claimed_at"])
        send.assert_called_once()

        retry = start_row(attempts=1)
        retry["payload"] = latched["payload"]
        with patch.object(pd, "_record_live_activity_start_result",
                          return_value=True) as record, \
             patch.object(pd, "_apns_send") as resend, \
             patch.object(pd, "_sb_patch", return_value=True), \
             patch.object(pd, "_alert_owner"):
            self.assertEqual(pd._process_row(retry), (0, False))

        record.assert_called_once()
        resend.assert_not_called()

    def test_start_result_write_uses_exact_generation_and_token_receipt(self):
        with patch.object(pd, "_sb_patch",
                          return_value=[{"id": START_DELIVERY_ID}]) as save, \
             patch.object(pd, "_alert_owner"):
            result = pd._record_live_activity_start_result(
                start_row(), TOKEN_A, "delivered")

        self.assertTrue(result)
        table, params, body = save.call_args.args
        self.assertEqual(table, "live_activity_start_deliveries")
        self.assertEqual(params["id"], "eq." + START_DELIVERY_ID)
        self.assertEqual(params["shift_id"], "eq." + SHIFT_ID)
        self.assertNotIn("device_id", params)
        self.assertEqual(params["queue_id"], "eq." + QUEUE_ID)
        self.assertEqual(params["generation"], "eq.1")
        self.assertEqual(params["start_token"], "eq." + TOKEN_A)
        self.assertEqual(params["terminal_at"], "is.null")
        self.assertIn("delivered_at", body)
        self.assertTrue(save.call_args.kwargs["want_rows"])

    def test_start_validation_uses_immutable_receipt_not_mutable_device_id(self):
        with patch.object(pd, "_sb_rpc", return_value=True) as rpc:
            result = pd._validate_live_activity_start(start_row(), TOKEN_A)

        self.assertTrue(result)
        name, body = rpc.call_args.args
        self.assertEqual(name, "hc_validate_live_activity_start_delivery")
        self.assertEqual(body["p_delivery_id"], START_DELIVERY_ID)
        self.assertEqual(body["p_shift_id"], SHIFT_ID)
        self.assertEqual(body["p_queue_id"], QUEUE_ID)
        self.assertEqual(body["p_generation"], 1)
        self.assertEqual(body["p_start_token"], TOKEN_A)
        self.assertNotIn("p_device_id", body)

    def test_dead_start_cleanup_uses_exact_token_across_device_remap(self):
        with patch.object(pd, "_sb_delete", return_value=True) as delete:
            result = pd._delete_live_activity_start_token(start_row(), TOKEN_A)

        self.assertTrue(result)
        table, params = delete.call_args.args
        self.assertEqual(table, "live_activity_tokens")
        self.assertEqual(params["token_type"], "eq.push_to_start")
        self.assertEqual(params["shift_id"], "is.null")
        self.assertEqual(params["token"], "eq." + TOKEN_A)
        self.assertNotIn("device_id", params)

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
            "expiration": 0,
        }
        with patch.object(pd, "_apns_jwt", return_value="offline-jwt"), \
             patch.object(pd.subprocess, "run", return_value=completed) as run:
            result = pd._apns_send(TOKEN_A, headers, {"alert": "test"}, QUEUE_ID)

        self.assertEqual(result, (200, ""))
        command = run.call_args.args[0]
        self.assertIn("apns-id: " + QUEUE_ID, command)
        self.assertIn("apns-collapse-id: " + QUEUE_ID, command)
        self.assertIn("apns-expiration: 0", command)

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

    def test_encrypted_telegram_outbox_decrypts_and_closes_after_acceptance(self):
        row = telegram_outbox_row(
            "12121212-1212-4212-8212-121212121212",
            "private-chat",
            "Private webhook alert",
        )
        stored = json.dumps(row)
        self.assertNotIn("private-chat", stored)
        self.assertNotIn("Private webhook alert", stored)
        accepted = Mock(ok=True, status_code=200, text="ok")

        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
             patch.object(pd.requests, "post", return_value=accepted) as post, \
             patch.object(pd, "_sb_patch", return_value=True) as sb_patch:
            result = pd._process_row(row)

        self.assertEqual(result, (0, True))
        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs["json"], {
            "chat_id": "private-chat",
            "text": "Private webhook alert",
        })
        done = next(call.args[2] for call in sb_patch.call_args_list
                    if "done_at" in call.args[2])
        self.assertIsNone(done["last_error"])

    def test_partial_multi_chat_failure_retries_only_the_unfinished_chat(self):
        row_a = telegram_outbox_row(
            "13131313-1313-4313-8313-131313131313",
            "chat-a",
            "Alert A",
        )
        row_b = telegram_outbox_row(
            "14141414-1414-4414-8414-141414141414",
            "chat-b",
            "Alert B",
        )
        sent = []
        chat_b_attempts = 0
        done_ids = set()

        def send(_url, json=None, timeout=None):
            nonlocal chat_b_attempts
            self.assertEqual(timeout, 10)
            sent.append(json["chat_id"])
            if json["chat_id"] == "chat-b":
                chat_b_attempts += 1
                if chat_b_attempts == 1:
                    return Mock(ok=False, status_code=503, text="offline")
            return Mock(ok=True, status_code=200, text="ok")

        def save(_table, params, body, want_rows=False):
            self.assertTrue(want_rows)
            row_id = params["id"].replace("eq.", "", 1)
            if "done_at" in body:
                done_ids.add(row_id)
            return [{"id": row_id}]

        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
             patch.object(pd.requests, "post", side_effect=send), \
             patch.object(pd, "_sb_patch", side_effect=save):
            self.assertEqual(pd._process_row(row_a), (0, True))
            self.assertEqual(pd._process_row(row_b), (0, False))

            # This mirrors pushdrain's done_at-is-null selector. The completed
            # chat A row is absent from the retry set, while chat B remains.
            pending = [row for row in (row_a, row_b)
                       if row["id"] not in done_ids]
            self.assertEqual([row["id"] for row in pending], [row_b["id"]])
            pending[0]["attempts"] = 1
            self.assertEqual(pd._process_row(pending[0]), (0, True))

        self.assertEqual(sent, ["chat-a", "chat-b", "chat-b"])
        self.assertEqual(done_ids, {row_a["id"], row_b["id"]})

    def test_ambiguous_telegram_response_stays_pending_for_at_least_once_retry(self):
        row = telegram_outbox_row(
            "15151515-1515-4515-8515-151515151515",
            "ambiguous-chat",
            "Ambiguous alert",
        )
        accepted = Mock(ok=True, status_code=200, text="ok")
        patches = []

        def save(_table, params, body, want_rows=False):
            self.assertTrue(want_rows)
            patches.append(copy.deepcopy(body))
            return [{"id": params["id"].replace("eq.", "", 1)}]

        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
             patch.object(pd.requests, "post",
                          side_effect=[TimeoutError("response lost"), accepted]) as post, \
             patch.object(pd, "_sb_patch", side_effect=save):
            self.assertEqual(pd._process_row(row), (0, False))
            self.assertNotIn("done_at", patches[-1])
            self.assertIsNone(patches[-1]["claimed_at"])
            self.assertIn("next_attempt_at", patches[-1])
            row["attempts"] = 1
            self.assertEqual(pd._process_row(row), (0, True))

        self.assertEqual(post.call_count, 2)
        self.assertIn("done_at", patches[-1])

    def test_expired_telegram_outbox_uses_dedicated_retry_schedule(self):
        row = telegram_outbox_row(
            "16161616-1616-4616-8616-161616161616",
            "outage-chat",
            "Outage alert",
            attempts=pd.MAX_ATTEMPTS,
        )
        refused = Mock(ok=False, status_code=503, text="offline")
        patches = []

        def save(_table, params, body, want_rows=False):
            self.assertTrue(want_rows)
            patches.append(copy.deepcopy(body))
            return [{"id": params["id"].replace("eq.", "", 1)}]

        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
             patch.object(pd.requests, "post", return_value=refused), \
             patch.object(pd, "_sb_patch", side_effect=save):
            self.assertFalse(pd._expire_claimed_row(row))

        self.assertEqual(len(patches), 1)
        self.assertNotIn("done_at", patches[0])
        self.assertIsNone(patches[0]["claimed_at"])
        self.assertIn("next_attempt_at", patches[0])
        self.assertEqual(patches[0]["attempts"], pd.MAX_ATTEMPTS + 1)
        self.assertIn("temporarily unavailable", patches[0]["last_error"])

    def test_previous_encryption_key_decrypts_during_rotation(self):
        row = telegram_outbox_row(
            "17171717-1717-4717-8717-171717171717",
            "previous-key-chat",
            "Rotated alert",
            key=OUTBOX_PREVIOUS_KEY,
            key_version="previous",
        )
        accepted = Mock(ok=True, status_code=200, text="ok")
        pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_PREVIOUS = OUTBOX_PREVIOUS_CONFIG

        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
             patch.object(pd.requests, "post", return_value=accepted) as post, \
             patch.object(pd, "_sb_patch", return_value=True):
            self.assertEqual(pd._process_row(row), (0, True))

        self.assertEqual(post.call_args.kwargs["json"], {
            "chat_id": "previous-key-chat",
            "text": "Rotated alert",
        })

    def test_markdown_characters_are_plain_and_final_length_is_4096(self):
        prefix = "*_[link](https://example.test) `code` # "
        text = prefix + "x" * (4096 - len(prefix))
        self.assertEqual(len(text), 4096)
        row = telegram_outbox_row(
            "18181818-1818-4818-8818-181818181818",
            "plain-chat",
            text,
        )
        accepted = Mock(ok=True, status_code=200, text="ok")

        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
             patch.object(pd.requests, "post", return_value=accepted) as post, \
             patch.object(pd, "_sb_patch", return_value=True):
            self.assertEqual(pd._process_row(row), (0, True))

        request_json = post.call_args.kwargs["json"]
        self.assertEqual(request_json, {"chat_id": "plain-chat", "text": text})
        self.assertNotIn("parse_mode", request_json)

    def test_terminal_telegram_statuses_dead_letter_without_retry(self):
        for offset, status in enumerate((400, 403), start=1):
            with self.subTest(status=status):
                row = telegram_outbox_row(
                    f"19191919-1919-4919-8919-{offset:012d}",
                    "terminal-chat",
                    "Terminal alert",
                )
                patches = []

                def save(_table, _params, body, want_rows=False):
                    self.assertTrue(want_rows)
                    patches.append(copy.deepcopy(body))
                    return [{"id": row["id"]}]

                refused = Mock(ok=False, status_code=status, text="refused")
                with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
                     patch.object(pd.requests, "post", return_value=refused), \
                     patch.object(pd, "_sb_patch", side_effect=save), \
                     patch.object(pd, "_alert_owner") as alert:
                    self.assertEqual(pd._process_row(row), (0, False))

                terminal = patches[-1]
                self.assertIn("done_at", terminal)
                self.assertIn("dead_lettered_at", terminal)
                self.assertIn("permanently rejected", terminal["dead_letter_reason"])
                self.assertNotIn("next_attempt_at", terminal)
                alert.assert_called_once()

    def test_retryable_telegram_statuses_and_network_use_backoff(self):
        outcomes = (
            Mock(ok=False, status_code=409, text="conflict"),
            Mock(ok=False, status_code=429, text="rate limited"),
            Mock(ok=False, status_code=500, text="offline"),
            TimeoutError("response lost"),
        )
        for offset, outcome in enumerate(outcomes, start=1):
            with self.subTest(outcome=type(outcome).__name__):
                row = telegram_outbox_row(
                    f"20202020-2020-4020-8020-{offset:012d}",
                    "retry-chat",
                    "Retry alert",
                )
                patches = []

                def save(_table, _params, body, want_rows=False):
                    self.assertTrue(want_rows)
                    patches.append(copy.deepcopy(body))
                    return [{"id": row["id"]}]

                with patch.object(pd, "TELEGRAM_BOT_TOKEN", "offline-bot-token"), \
                     patch.object(pd.requests, "post", side_effect=[outcome]), \
                     patch.object(pd, "_sb_patch", side_effect=save), \
                     patch.object(pd, "_alert_owner") as alert:
                    self.assertEqual(pd._process_row(row), (0, False))

                retry = patches[-1]
                self.assertNotIn("done_at", retry)
                self.assertIsNone(retry["claimed_at"])
                self.assertIn("next_attempt_at", retry)
                self.assertEqual(retry["attempts"], 1)
                alert.assert_not_called()

    def test_missing_or_rejected_bot_configuration_retries_with_warning(self):
        cases = (("missing", None), ("http", 401), ("http", 404))
        for offset, (kind, status) in enumerate(cases, start=1):
            with self.subTest(kind=kind, status=status):
                row = telegram_outbox_row(
                    f"21212121-2121-4121-8121-{offset:012d}",
                    "config-chat",
                    "Configuration alert",
                )
                patches = []

                def save(_table, _params, body, want_rows=False):
                    self.assertTrue(want_rows)
                    patches.append(copy.deepcopy(body))
                    return [{"id": row["id"]}]

                pd._WEBHOOK_CONFIG_WARNING_AT = 0.0
                response = (Mock(ok=False, status_code=status, text="refused")
                            if status is not None else None)
                with patch.object(
                        pd, "TELEGRAM_BOT_TOKEN",
                        "" if kind == "missing" else "bad-token"), \
                     patch.object(pd.requests, "post", return_value=response) as post, \
                     patch.object(pd, "_sb_patch", side_effect=save), \
                     patch.object(pd, "_alert_owner") as alert:
                    self.assertEqual(pd._process_row(row), (0, False))

                retry = patches[-1]
                self.assertNotIn("done_at", retry)
                self.assertNotIn("dead_lettered_at", retry)
                self.assertIsNone(retry["claimed_at"])
                self.assertIn("next_attempt_at", retry)
                self.assertIn("configuration", retry["last_error"])
                alert.assert_called_once()
                if kind == "missing":
                    post.assert_not_called()

    def test_unknown_or_mismatched_key_retries_without_dead_letter(self):
        cases = ("unknown", "mismatched")
        for offset, kind in enumerate(cases, start=1):
            with self.subTest(kind=kind):
                row = telegram_outbox_row(
                    f"23232323-2323-4323-8323-{offset:012d}",
                    "key-chat",
                    "Key recovery alert",
                )
                if kind == "unknown":
                    row["payload"]["telegram_outbox"]["key_version"] = "old-key"
                else:
                    pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT = (
                        "current:" + pd.base64.b64encode(
                            OUTBOX_PREVIOUS_KEY).decode("ascii"))
                patches = []

                def save(_table, _params, body, want_rows=False):
                    self.assertTrue(want_rows)
                    patches.append(copy.deepcopy(body))
                    return [{"id": row["id"]}]

                pd._WEBHOOK_CONFIG_WARNING_AT = 0.0
                with patch.object(pd.requests, "post") as post, \
                     patch.object(pd, "_sb_patch", side_effect=save), \
                     patch.object(pd, "_alert_owner") as alert:
                    self.assertEqual(pd._process_row(row), (0, False))

                post.assert_not_called()
                self.assertNotIn("done_at", patches[-1])
                self.assertNotIn("dead_lettered_at", patches[-1])
                self.assertIn("next_attempt_at", patches[-1])
                self.assertIn("key unavailable", patches[-1]["last_error"])
                alert.assert_called_once()
                pd.WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT = OUTBOX_CURRENT_CONFIG

    def test_structurally_corrupt_payload_is_operator_visible_dead_letter(self):
        row = telegram_outbox_row(
            "24242424-2424-4424-8424-242424242424",
            "hidden-chat",
            "Hidden alert",
        )
        row["payload"]["telegram_outbox"]["nonce"] = "!" * 16
        patches = []

        def save(_table, _params, body, want_rows=False):
            self.assertTrue(want_rows)
            patches.append(copy.deepcopy(body))
            return [{"id": row["id"]}]

        with patch.object(pd.requests, "post") as post, \
             patch.object(pd, "_sb_patch", side_effect=save), \
             patch.object(pd, "_alert_owner") as alert:
            self.assertEqual(pd._process_row(row), (0, False))

        post.assert_not_called()
        self.assertIn("dead_lettered_at", patches[-1])
        self.assertIn("undecryptable", patches[-1]["dead_letter_reason"])
        alert.assert_called_once()

    def test_startup_preflight_requires_current_key_and_telegram_token(self):
        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "configured-token"):
            self.assertIsNone(pd._webhook_outbox_configuration_error())
        with patch.object(pd, "TELEGRAM_BOT_TOKEN", ""):
            self.assertIn("token", pd._webhook_outbox_configuration_error())
        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "configured-token"), \
             patch.object(pd, "WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT", ""):
            self.assertIn("current", pd._webhook_outbox_configuration_error())
        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "configured-token"), \
             patch.object(pd, "WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT", "bad"):
            self.assertIn("invalid", pd._webhook_outbox_configuration_error())
        with patch.object(pd, "TELEGRAM_BOT_TOKEN", "configured-token"), \
             patch.object(
                 pd, "WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT",
                 "é:" + pd.base64.b64encode(OUTBOX_CURRENT_KEY).decode("ascii")):
            self.assertIn("invalid", pd._webhook_outbox_configuration_error())

    def test_webhook_backoff_never_turns_five_failures_into_15_minute_blackout(self):
        self.assertEqual(
            [pd._webhook_outbox_backoff_seconds(attempt)
             for attempt in range(1, 8)],
            [20, 40, 80, 160, 300, 300, 300],
        )

    def test_work_loop_claims_due_webhook_rows_in_separate_scan(self):
        row = telegram_outbox_row(
            "22222222-2222-4222-8222-222222222222",
            "due-chat",
            "Due alert",
        )

        def claim(_table, params, body, want_rows=False):
            self.assertEqual(params["outbox_type"], "eq.webhook_telegram")
            self.assertIn("next_attempt_at", params)
            self.assertTrue(want_rows)
            return [{**row, "claimed_at": body["claimed_at"]}]

        old_purge = pd._last_purge
        old_streak = pd._read_fail_streak
        pd._last_purge = time.time()
        pd._read_fail_streak = 0
        try:
            with patch.object(pd, "_queue_depth", return_value=1), \
                 patch.object(pd, "_sb_select", side_effect=[
                     [{"id": row["id"]}], [], [],
                 ]) as select, \
                 patch.object(pd, "_sb_patch", side_effect=claim), \
                 patch.object(pd, "_process_webhook_outbox",
                              return_value=(0, True)) as process, \
                 patch.object(pd, "_sb_delete"):
                pd.work_once()
        finally:
            pd._last_purge = old_purge
            pd._read_fail_streak = old_streak

        process.assert_called_once()
        self.assertEqual(
            select.call_args_list[0].args[1]["outbox_type"],
            "eq.webhook_telegram",
        )
        self.assertEqual(select.call_args_list[1].args[1]["outbox_type"],
                         "eq.push")
        self.assertEqual(select.call_args_list[2].args[1]["outbox_type"],
                         "eq.push")

    def test_expiry_loser_does_not_fallback_or_release_another_drainers_row(self):
        old_purge = pd._last_purge
        old_streak = pd._read_fail_streak
        pd._last_purge = time.time()
        pd._read_fail_streak = 0
        try:
            with patch.object(pd, "_queue_depth", return_value=1), \
                 patch.object(pd, "_sb_select",
                              side_effect=[[], [{"id": QUEUE_ID}], []]), \
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
                 patch.object(pd, "_sb_select", side_effect=[[], [], [
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
