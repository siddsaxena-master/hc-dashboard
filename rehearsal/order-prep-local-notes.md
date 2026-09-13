# Order preparation, local backend foundation

Not deployed. No real records, invoices, payroll, emails, customer approvals, production holds, or Expo builds were changed by this work.

Confirmed operating rule: staff submit the sample and continue. Neither owner nor customer
approval holds production. The owner monitors and intervenes if something is wrong. Saving
the sample remains separate from sending it to the customer or recording customer approval.

## App contract

- `hc_get_order_prep_state(p_order_id uuid)` returns `{version, stamp_checked, cracking_method, staffing, onsite_cracking_method, checks, latest_sample, updated_at}`. Missing requirements are `null`; missing checks are `false`. It does not infer instructions from an invoice. The stamp check is tied to a server-only artwork snapshot; a later artwork change makes the returned check false.
- `hc_save_order_prep_state(p_order_id uuid, p_expected_version integer, p_patch jsonb, p_expected_artwork jsonb default null)` accepts only `stamp_checked`, `cracking_method`, `staffing`, `onsite_cracking_method`, and the five named `checks`. A true stamp check requires the exact artwork identity displayed to the user. Only active owners/managers can set requirements. Staff can confirm the physical checks. Prep cracking and on-site cracking are independent, so whole prep can still require cocktail-opening tools at a staffed event. Changing prep cracking clears the prep check; changing staffing or on-site cracking clears tool checks. This also resets affected checkmarks sent in the same patch. Reconfirm in a subsequent save.
- `hc_reserve_order_prep_photo(p_order_id uuid, p_photo_id uuid, p_captured_at timestamptz, p_expected_artwork jsonb default null)` requires both the exact displayed artwork identity and a physical stamp check for the current selected artwork, then returns `{id,path}`. Retrying must reuse the same identity and capture time. Paths are exactly `order UUID/auth user UUID/photo UUID.jpg`.
- Expected artwork is `{status,checked_at,files:[{file_name,mime_type,original_path,preview_path,usage}]}`. Keep raw strings, replace nonstrings/missing values with null, keep file order, and omit non-object file entries. Never include private source references or source-received time. The server compares that exact staff-visible identity, including when a changed file reuses the previous checked timestamp. Stored stamp and sample snapshots use the same safe identity.
- Upload a JPEG to private `order-prep-media` with `upsert:false` and `contentType:'image/jpeg'`. Keep compressed photos comfortably below 6 MB for normal upload reliability; the bucket hard limit is 8 MiB (8,388,608 bytes).
- `hc_finish_order_prep_photo(p_order_id uuid, p_photo_id uuid)` verifies the uploader, exact uploaded object, JPEG metadata, size, and unchanged selected artwork. It returns refreshed state plus `confirmed_photo_id` and `confirmed_photo_path`, and increments the state version once. Retrying an already finished photo is safe. Validate those exact receipt fields, since `latest_sample` may belong to a later upload. If an upload response is uncertain, retry finalization before creating another sample. Never retry by overwriting a path.
- `latest_sample` contains `{id,path,captured_at,logo_checked_at,artwork_current}`. Capture time is device-reported. Reservation, completion, checklist time, and actor are server-owned. A completed sample is not customer approval. `artwork_current` is only correspondence to the current selected artwork, not a quality or approval decision. Client still validates timestamps and stamp readiness.

Only active authenticated owners or active same-market managers/team can access an order. Staff with blank markets cannot access assigned or unassigned orders. Owners have global order access. Pending photos are readable only by their reserving user; finished photos are visible to authorized order viewers. All sample and checklist history is private and direct app table access is denied. Retakes retain old photos and audit records. This foundation does not delete abandoned reservations or uploads.

## Local verification

Run from `hc-dashboard`:

```text
node rehearsal/run-order-prep-pglite.mjs <absolute path to @electric-sql/pglite 0.5.8 package>
```

The runner creates an in-memory PostgreSQL database with fake users and orders. It accepts no connection URL. It applies the real 034/035/036 changes and reruns 036. The 91 tested scenarios include unauthorized roles, another market, anonymous access with a forged subject, direct-table denial, broad preexisting Storage policies, ownership, forged paths, lost-update rejection, invalid input, invalid photo metadata, stale displayed artwork before stamp checks and reservations, changed artwork during upload, private-reference changes, independent prep and on-site requirements, exact photo receipts, retry safety, retakes, audit fields, unchanged invoice data, and incompatible-bucket refusal.

## Required before enabling

1. Separate explicit owner approval for any live database change. Review the SQL and current production roles, bucket configuration, table definitions, and Storage policies first.
2. Test actual Supabase Storage HTTP uploads, private reads, expired signed links, permissions, upload retry after a dropped connection, oversized/non-JPEG rejection, and cross-market denial with staging accounts.
3. Test an iPhone camera, denied camera permission, interrupted uploads, rapid taps, stale checklist versions, sign-out during upload, and current versus replaced artwork. SQL tests do not prove photo bytes are a valid image or that the phone flow works.
4. Keep the app feature disabled until its UI, source-data rules, and backend are released together. Never infer customer consent from a sample or send real customer messages as part of this feature.

The broader workflow still needs separate work: assigning prep across days, box-by-box production photos and counts, first-sample customer review, route tracking, delivery evidence, expenses, and order cost allocation.

Official references: [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads), and [bucket upload limits](https://supabase.com/docs/guides/storage/buckets/creating-buckets).
