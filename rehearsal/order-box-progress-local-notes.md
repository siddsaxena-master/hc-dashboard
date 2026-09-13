# Box production and loading, local foundation

Not deployed. Migration 037 is a new local database change and leaves the completed 036 sample-photo change untouched. No live customer data, invoices, payroll, builds, messages, or delivery statuses were changed.

## Contract

- `hc_get_order_box_progress(p_order_id uuid)` returns `plan`, `boxes`, `totals`, `ready_to_load`, `fully_loaded`, and `readiness_reasons`.
- `plan` is `{version,target_coconuts,source,updated_at}`. The target starts unknown and never copies `orders.coconuts_qty`. `source:'owner_confirmed'` means explicit owner or authorized manager confirmation. Plan version changes only when the target is confirmed or adjusted.
- Each box is `{id,box_number,coconuts_qty,created_by,created_at,loaded,loaded_at,loaded_by,voided,voided_at,voided_by,void_reason,latest_photo}`. `latest_photo` is null until an upload finishes, then `{id,path,revision,captured_at,finished_at,photographer_id,photographer_name,artwork_current}`. `artwork_current` also becomes false if the selected private file is unavailable.
- `totals` contains `reserved_coconuts`, `completed_coconuts`, `loaded_coconuts`, `completed_boxes`, `pending_boxes`, `needs_review_boxes`, `remaining_coconuts`, and `unreserved_coconuts`. Voided boxes are excluded from all totals but retained in `boxes` for history. Sample photos from 036 never contribute to these counts.
- `hc_save_order_production_plan(p_order_id uuid,p_expected_version integer,p_target_coconuts integer)` is owner/manager only. Target must be positive and cannot be reduced below quantities already reserved for active physical boxes. It returns refreshed progress.
- `hc_reserve_order_box_photo(p_order_id uuid,p_box_id uuid,p_photo_id uuid,p_captured_at timestamptz,p_expected_artwork jsonb,p_coconuts_qty integer,p_expected_plan_version integer)` returns `{id,photo_id,box_id,box_number,coconuts_qty,revision,path}`. Reuse all original identifiers, capture time and quantity on retry. `p_expected_artwork` uses the same staff-visible identity as 036. A current stamp check and confirmed plan are required. Box numbers are assigned by the server. A retake reuses the box ID and quantity but gets a new photo ID and revision.
- Upload to private `order-box-media`, with `contentType:'image/jpeg'` and `upsert:false`. The server-created path is `order UUID/auth user UUID/photo UUID.jpg`. The hard size limit is 8 MiB; compress comfortably below 6 MB for normal upload reliability.
- `hc_finish_order_box_photo(p_order_id uuid,p_box_id uuid,p_photo_id uuid)` verifies the uploader, actual Storage object, metadata and unchanged artwork. It returns refreshed progress plus `confirmed_box_id`, `confirmed_photo_id`, and `confirmed_photo_path`. Validate these exact receipt fields, since a newer retake can already be the displayed photo. An old queued upload cannot replace a newer revision. Retakes never increase box counts or quantity. A new displayed retake clears that box's loading confirmation.
- `hc_set_order_box_loaded(p_order_id uuid,p_box_id uuid,p_expected_photo_id uuid,p_loaded boolean)` confirms loading or unloading of one box. Loading requires the exact current finished photo. Individual loading does not imply the whole order is ready.
- `hc_mark_order_loaded(p_order_id uuid,p_expected_plan_version integer)` is a bulk physical-loading confirmation. It refuses incomplete quantities, missing/current-artwork proof, unresolved invoice instructions, or missing 036 cracking/straws/staffing/tools checks. A fully loaded order is not delivered.
- `hc_void_order_production_box(p_order_id uuid,p_box_id uuid,p_reason text)` is owner/manager only. A clear 5 to 500 character reason is required. Loaded boxes must first be explicitly unloaded. This correction preserves the row, photos and audit history, frees its reserved quantity, and rejects future uploads/finalizations or reuse of the retired box ID. Use a new box ID for the corrected physical record.

## Accuracy boundaries

This is physical production evidence, not calculated labor time, payroll, inventory movements, or order profit. Capture time comes from the phone; reservation, completion and audit times come from the server. Staff confirm actual whole-number coconuts in each box, including partial boxes. The backend cannot visually prove a photo contains the stated count or enforce the same physical box identity if someone deliberately creates a second record.

Existing `invoice_fulfillment` is checked when present. Mixed cracking (`review`), invalid source/read status/linked invoice/timestamp, unknown cracking, or a conflict with the confirmed prep method prevents whole-order readiness. A missing snapshot still relies on explicit manager target and prep confirmation, never raw invoice quantity or `crack_type`. Mixed-method quantity breakdowns need a separate reviewed feature; do not guess the remaining quantity or bypass the warning for mixed orders.

Only active authenticated owners or same-market managers/team can read/write operational progress. Only owners/managers set quantities or retire mistakes. Tables and audit history have no direct client access. Restrictive Storage guards protect this bucket even when older permissive policies are broad. The 036 sample bucket is unchanged.

## Local verification and release gate

```text
node rehearsal/run-order-box-progress-pglite.mjs <absolute path to @electric-sql/pglite 0.5.8 package>
```

The in-memory PostgreSQL runner accepts no live connection URL and uses only fake identities, files and orders. Its 94 scenarios cover migration reruns, access control, partial counts, reservations exceeding targets, late/duplicate uploads, retakes, file metadata, stale artwork, corrections, loading prerequisites, mixed invoices, missing stored files, and unchanged invoice/customer data.

These are SQL tests, not actual camera/Storage HTTP tests or a true multi-connection race test. Per-order write operations serialize using a plan-row lock. Before enabling: review production prerequisites with explicit owner approval, test actual uploads/private reads and denied roles in staging, then test the phone's durable queue, reconnect, permission denial, rapid taps, multiworker coordination, corrections and artwork changes. Keep the app feature disabled until the UI and approved backend rollout are verified together.
