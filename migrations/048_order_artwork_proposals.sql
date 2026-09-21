-- ============================================================================
-- 048_order_artwork_proposals.sql
-- A customer's artwork file (a logo as .png, .jpg, .pdf, .eps, .ai, .ps or
-- .svg) found on an email about a booked job, waiting for the owner's
-- Use it or Not this one in the HC Field app. Written 2026-09-21 against
-- PHASE3-ARTWORK-PLAN-2026-09-21.md section 3.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- Why: the crew brand the coconuts the day before delivery from the file
-- the customer sent. Until now that file reached the card by a hand import
-- (Alison's .ps on 2026-09-17, Allie's SVG on 2026-09-21) or not at all.
-- Now the outlook poller records each kept email's attachment listing, the
-- droplet's artwork pass downloads and previews the files into the PRIVATE
-- order-logos bucket, and this table is where each file waits for a human.
-- Nothing here puts a file on a card by itself: approval-first (Sidd,
-- 2026-07-25) stays the rule. Only the owner's tap, through
-- hc_decide_proposed_artwork, writes orders.logo_asset.
--
-- What this adds:
--   * public.intake_messages.email_meta: the sender's display name, the
--     To and Cc addresses, the email's permanent internetMessageId and the
--     attachment listing (id, name, content type, size, inline), written by
--     the poller at insert and by the replay script. Never bytes, never a
--     URL. RLS on intake_messages stays zero-policy (service key only).
--   * public.intake_messages.artwork_scanned_at: stamped by the droplet
--     pass once every attachment on the row has a verdict or a skip reason.
--     Left null while the order has no invoice, so the row is read again
--     once invoiced (the address_scanned_at trick from 045).
--   * public.order_artwork_proposals: one row per FILE (an email can carry
--     a front and a back), with its own identity id, unique on
--     (order_id, sha256) and on (intake_id, attachment_id). The same bytes
--     can never be proposed twice for one order, so a file the owner
--     refuses once never comes back. The row carries the object paths in
--     the private bucket, the verdict (ready, no_preview, too_large,
--     fetch_failed), the words the phone prints, and a snapshot of the
--     invoice, the delivery day and the card's checked_at at scan time, so
--     a later tap can refuse when any of them moved (the 045 shape).
--   * public.hc_decide_proposed_artwork(order, proposal, decision): the
--     owner's Use it (use), Not this one (skip) or Dismiss (dismiss, the
--     same as skip). Use it appends the ONE file to orders.logo_asset in
--     the 035 shape with the keys the hand imports wrote plus approved_at
--     and approved_by, sets logo_received true, and makes the record read
--     'approved' only when every listed file carries approved_at (else
--     'received'; a needs_review record stays needs_review). It refuses,
--     and says so instead of raising, when the order is cancelled, the
--     delivery day has passed, the invoice changed, the card's artwork
--     changed since the scan, the file was never saved, the same bytes
--     are already on the card, or the card already holds 12 files. Both
--     decisions dismiss the intake row so the Telegram queue stops nagging.
--   * public.hc_approve_order_artwork(order, checked_at): the owner's
--     Approve artwork on a record already on a card (the two hand imports,
--     or a card that gained a second file beside an older unapproved one).
--     Compare-and-set on checked_at, refuses a record whose files lack a
--     usage word from the 035 vocabulary, refuses needs_review, stamps
--     approved_at on every file, flips the status to approved and resets
--     checked_at (the 036 prep fingerprint) on purpose.
--   * public.hc_can_read_order_logo(text) re-created: the 035 body kept
--     verbatim as the first branch, OR one clause that lets an active
--     OWNER phone (never a manager or crew phone) sign a URL for a
--     proposal's original or preview while the row is pending or was
--     decided in the last 30 days. The three 035 storage policies call the
--     helper by name and are untouched. The rollback restores the 035 text
--     byte for byte.
--   * storage.buckets.file_size_limit = 25000000 on order-logos: the
--     server-side backstop of the pass's 25 MB cap.
--
-- Reading: owner only (row level security with public.hc_is_owner()), a
-- SELECT grant to the authenticated role, nothing for anon or PUBLIC.
-- Managers see nothing. The public dashboard's anon key sees nothing. The
-- droplet pass (service key) inserts rows and stamps the intake row; the
-- worker (service key) stamps notified_at and retires stale rows.
--
-- What this never touches: orders.logo_asset's column or its 035 check,
-- the three 035 storage policies, order_address_proposals,
-- order_time_proposals, order_reconfirmations, every Phase 2 function,
-- and the intake rows themselves beyond the two new columns and the status
-- flip a decision makes.
--
-- Three places this file deviates from the plan's words on purpose
-- (reviewer findings, 2026-09-21):
--   * Plan 3D and 5b compare the card's checked_at with each row's
--     snapshot on every Use it and on every worker tick. Read literally, a
--     front and a back in ONE email could never both be used: the first
--     Use it moves checked_at, so the second row is refused as
--     artwork_changed, and the unique (order_id, sha256) key means the
--     file can never be proposed again. So a Use it re-takes the snapshot
--     of every OTHER pending row for that order in the same transaction
--     (the owner's own tap is not a change under him). The worker's retire
--     step and the app then see matching values.
--   * Plan 3D dismisses the intake row on both decisions. Here the
--     dismissal lands only once the worker has read the email
--     (intake_messages.address_scanned_at is not null). The droplet pass
--     makes a row about 3 minutes after the email while the worker ticks
--     every 5, and the app lists pending rows without waiting for the
--     banner, so a tap could otherwise hide a reply that carries the logo
--     AND an answer to our bullets from the reply scan and the time and
--     address scan. A row the worker has not read yet stays
--     pending_review and the next tick reads it.
--   * Plan 3B lets a PNG or JPEG original be its own preview
--     (preview_path = original_path) when Pillow is missing. The pass
--     never writes that: a raster that could not be shrunk is verdict
--     no_preview with preview_path null, and the app's manifest draws a
--     raster original on its own (order-logo-files.js). The check admits a
--     ...-preview.png only, so the table never documents a value no writer
--     produces.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
  v_check text;
  v_type text;
  v_src text;
  v_secdef boolean;
  v_lang text;
  v_public boolean;
  -- The 035 body of hc_can_read_order_logo, byte for byte (035:80-116).
  -- The preflight refuses unless the installed helper is exactly this text,
  -- or exactly this text with 048's one clause already in it (a re-run).
  v_035 constant text := $body035$
  select auth.uid() is not null
    and p_name is not null
    and pg_catalog.length(p_name) > 0
    and exists (
      select 1
      from public.orders as order_row
      join public.field_workers as worker
        on worker.auth_user_id = auth.uid()
       and worker.active is true
      where (
        lower(trim(worker.role)) = 'owner'
        or (
          lower(trim(worker.role)) in ('manager', 'team')
          and nullif(lower(trim(worker.market)), '') is not null
          and nullif(lower(trim(order_row.market)), '') is not null
          and lower(trim(order_row.market)) = lower(trim(worker.market))
        )
      )
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(order_row.logo_asset -> 'files') = 'array'
            then order_row.logo_asset -> 'files' else '[]'::jsonb end
        ) as logo_file(value)
        where pg_catalog.jsonb_typeof(logo_file.value) = 'object'
        and (
          (
            pg_catalog.jsonb_typeof(logo_file.value -> 'original_path') = 'string'
            and logo_file.value ->> 'original_path' = p_name
          )
          or (
            pg_catalog.jsonb_typeof(logo_file.value -> 'preview_path') = 'string'
            and logo_file.value ->> 'preview_path' = p_name
          )
        )
      )
    );
$body035$;
  -- 048's one clause, exactly as section F below writes it.
  v_clause constant text := $clause048$
    or (
      auth.uid() is not null
      and p_name is not null
      and pg_catalog.length(p_name) > 0
      and exists (
        select 1
        from public.field_workers as worker
        where worker.auth_user_id = auth.uid()
          and worker.active is true
          and lower(trim(worker.role)) = 'owner'
      )
      and exists (
        select 1
        from public.order_artwork_proposals as proposal
        where (proposal.original_path = p_name or proposal.preview_path = p_name)
          and (proposal.status = 'pending' or proposal.decided_at > pg_catalog.now() - interval '30 days')
      )
    )$clause048$;
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.intake_messages') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regclass('storage.buckets') is null
     or pg_catalog.to_regclass('storage.objects') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null
     or pg_catalog.to_regclass('public.order_address_proposals') is null then
    raise exception using
      errcode = '55000',
      message = '048 requires orders, intake_messages, field_workers, Supabase Storage, auth.uid(), public.hc_is_owner() (015) and public.order_address_proposals (045)';
  end if;

  -- The decision function appends to logo_asset (035) and sets logo_received.
  foreach v_column in array array['id', 'stage', 'market', 'delivery_at_utc', 'event_start_at', 'external_invoice_id', 'logo_asset', 'logo_received', 'updated_at'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.orders'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('048 requires column public.orders.%s (035 adds logo_asset)', v_column);
    end if;
  end loop;
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.orders'::regclass and a.attname = 'logo_asset' and a.attnum > 0 and not a.attisdropped;
  if v_type <> 'jsonb' then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format('048 refuses public.orders.logo_asset of type %s (035 made it jsonb)', v_type);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.orders'::regclass
      and c.conname = 'orders_logo_asset_object'
      and c.contype = 'c'
  ) then
    raise exception using
      errcode = '55000',
      message = '048 requires the 035 check orders_logo_asset_object on public.orders.logo_asset';
  end if;

  -- The decision dismisses the intake row; the pass reads the 045 columns
  -- beside the new ones (replayed_at and address_scanned_at prove the lineage).
  foreach v_column in array array['id', 'source_msg_id', 'order_id', 'status', 'reviewed_at', 'error_detail', 'classified_at', 'conversation_id', 'replayed_at', 'address_scanned_at'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.intake_messages'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('048 requires column public.intake_messages.%s (004/005/044/045)', v_column);
    end if;
  end loop;

  -- The helper's owner clause reads these.
  foreach v_column in array array['auth_user_id', 'role', 'market', 'active'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.field_workers'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('048 requires column public.field_workers.%s (003/015)', v_column);
    end if;
  end loop;

  -- A decision dismisses the intake row; the status list must allow it.
  select pg_catalog.pg_get_constraintdef(c.oid) into v_check
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.intake_messages'::regclass
    and c.conname = 'intake_messages_status_check';
  if v_check is null or pg_catalog.strpos(v_check, 'dismissed') = 0 then
    raise exception using
      errcode = '55000',
      message = '048 requires the intake_messages status list to admit ''dismissed'' (004/005)';
  end if;

  -- The 035 helper must be the text 035 wrote (or this file's re-run of
  -- it): a security definer sql function whose body is v_035, or v_035
  -- with v_clause in it. Anything else means somebody changed it, and 048
  -- stops rather than overwrite their work. Carriage returns are ignored
  -- so a body pasted with Windows line endings still matches.
  if pg_catalog.to_regprocedure('public.hc_can_read_order_logo(text)') is null then
    raise exception using
      errcode = '55000',
      message = '048 requires public.hc_can_read_order_logo(text) (035)';
  end if;
  select p.prosrc, p.prosecdef, l.lanname into v_src, v_secdef, v_lang
  from pg_catalog.pg_proc as p
  join pg_catalog.pg_language as l on l.oid = p.prolang
  where p.oid = pg_catalog.to_regprocedure('public.hc_can_read_order_logo(text)');
  -- Every side is compared with ALL whitespace removed (carriage returns,
  -- newlines, spaces, tabs): the live 035 helper was pasted on 2026-09-06
  -- from a copy of the file with different line breaks ("select 1 from
  -- public.orders" on one line), and an exact text match refused it on
  -- 2026-09-21 although the logic is the same. Removing the 048 clause from
  -- a re-run's helper then leaves nothing behind either. The two strpos
  -- checks below still read the text with its spaces.
  v_src := pg_catalog.replace(v_src, pg_catalog.chr(13), '');
  if v_secdef is not true
     or v_lang <> 'sql'
     or pg_catalog.strpos(v_src, 'logo_file.value ->> ''preview_path'' = p_name') = 0
     or pg_catalog.strpos(v_src, 'lower(trim(order_row.market)) = lower(trim(worker.market))') = 0
     or pg_catalog.replace(
          pg_catalog.regexp_replace(v_src, '\s', '', 'g'),
          pg_catalog.regexp_replace(v_clause, '\s', '', 'g'), '')
        <> pg_catalog.regexp_replace(v_035, '\s', '', 'g') then
    raise exception using
      errcode = '55000',
      message = '048 found an unrecognized public.hc_can_read_order_logo; it must be the 035 text (or the 035 text with 048''s clause); review it before applying';
  end if;

  -- The bucket must exist and be private (035:52-68).
  select b.public into v_public from storage.buckets as b where b.id = 'order-logos';
  if not found then
    raise exception using
      errcode = '55000',
      message = '048 requires the private order-logos bucket (035)';
  end if;
  if v_public is distinct from false then
    raise exception using
      errcode = '55000',
      message = '048 refuses a public order-logos bucket; review it separately';
  end if;

  -- An email_meta or artwork_scanned_at that already exists must have the
  -- right shape, or the poller and the pass would write into a column of
  -- the wrong type and nobody would notice for days.
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.intake_messages'::regclass
    and a.attname = 'email_meta'
    and a.attnum > 0
    and not a.attisdropped;
  if v_type is not null and v_type <> 'jsonb' then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format('048 refuses an existing public.intake_messages.email_meta of type %s; review that column before applying', v_type);
  end if;
  v_type := null;
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.intake_messages'::regclass
    and a.attname = 'artwork_scanned_at'
    and a.attnum > 0
    and not a.attisdropped;
  if v_type is not null and v_type <> 'timestamp with time zone' then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format('048 refuses an existing public.intake_messages.artwork_scanned_at of type %s; review that column before applying', v_type);
  end if;

  if pg_catalog.to_regclass('public.order_artwork_proposals') is not null then
    foreach v_column in array array['id', 'intake_id', 'order_id', 'attachment_id', 'file_name', 'mime_type', 'sha256', 'size_bytes', 'original_path', 'preview_path', 'verdict', 'sender_kind', 'card_checked_at_snapshot', 'invoice_id_snapshot', 'delivery_day_snapshot', 'source_received_at', 'found_at', 'status', 'notified_at'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'public.order_artwork_proposals'::regclass
          and attname = v_column
          and attnum > 0
          and not attisdropped
      ) then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format(
            '048 refuses an existing public.order_artwork_proposals with no %s column; review that table before applying',
            v_column);
      end if;
    end loop;
  end if;
end
$preflight$;

-- A. Two nullable columns on the intake row (the 044/045 pattern). Rows the
-- poller wrote before this migration stay null on both, and the pass never
-- reads a row with no email_meta.
alter table public.intake_messages
  add column if not exists email_meta jsonb;

alter table public.intake_messages
  add column if not exists artwork_scanned_at timestamptz;

do $email_meta_check$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.intake_messages'::regclass
      and conname = 'intake_messages_email_meta_object'
  ) then
    alter table public.intake_messages add constraint intake_messages_email_meta_object
      check (email_meta is null or pg_catalog.jsonb_typeof(email_meta) = 'object');
  end if;
end
$email_meta_check$;

comment on column public.intake_messages.email_meta is
  'Written by the outlook poller at insert (insert_intake_message extra_fields) and by the replay script: {internet_message_id, sender_name, to:[...], cc:[...], attachments:[{id, name, content_type, size, inline}]}, at most 25 attachment entries, names cut at 255, addresses lower-cased. Never bytes, never a URL. The linker reads sender_name and to/cc; the artwork pass reads attachments. Null on rows written before 048.';

comment on column public.intake_messages.artwork_scanned_at is
  'Stamped by the droplet artwork pass (artwork_fetch.py) once every attachment on the row has a verdict or a skip reason. Left null while the order has no invoice yet (re-read once invoiced) and never stamped on a pass the budget cut short.';

-- B. One proposal per FILE. Cascades away with the email row or the order.
create table if not exists public.order_artwork_proposals (
  id bigint generated always as identity primary key,
  intake_id bigint not null references public.intake_messages(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  -- Graph's tag for this file on this email, needed to download its bytes.
  -- Owner-only by RLS like every other column here.
  attachment_id text not null check (pg_catalog.length(attachment_id) between 1 and 512),
  -- The file name as the customer sent it. Printed on a row only after the
  -- phone's scrubContacts and a cut at 60 characters, never in a banner.
  file_name text not null check (pg_catalog.length(file_name) between 1 and 255 and file_name !~ '[[:cntrl:]]'),
  -- Decided from magic bytes by the pass, never from the email's label.
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'application/pdf', 'application/postscript', 'application/illustrator', 'image/svg+xml')),
  -- The fingerprint of the original bytes: identical bytes give identical
  -- fingerprints, which is how "the same file again" is told.
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 25000000),
  -- What the email's listing said the size was; a difference is a warning
  -- on the file entry, never a failure.
  attachment_listed_size_bytes integer check (attachment_listed_size_bytes is null or attachment_listed_size_bytes >= 0),
  -- Object names inside the private order-logos bucket, flat like the hand
  -- imports ({DocNumber or order id prefix}-{slug}-{sha256[:16]}.{ext} and
  -- ...-preview.png), under the app's safeLogoPath rule
  -- (order-logo-files.js:6-11): no '.', '..' or empty segment, no leading
  -- slash, at most 500 characters (the length is checked apart because
  -- Postgres regular expressions cap a repetition count at 255).
  original_path text check (original_path is null or (
    pg_catalog.length(original_path) <= 500
    and original_path ~ '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$'
    and original_path !~ '(^|/)\.{1,2}(/|$)'
    and original_path !~ '//'
    and original_path !~ '/$')),
  -- The PNG the phone shows: always a rendered ...-preview.png. A PNG or
  -- JPEG original whose preview could not be shrunk (no Pillow) is verdict
  -- no_preview with preview_path null, never its own preview: the pass
  -- (artwork_fetch.py render_preview) writes nothing else, and the app's
  -- manifest draws a raster original by itself (order-logo-files.js).
  preview_path text constraint order_artwork_proposals_preview_path_check check (preview_path is null or (
    pg_catalog.length(preview_path) <= 500
    and preview_path ~ '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$'
    and preview_path !~ '(^|/)\.{1,2}(/|$)'
    and preview_path !~ '//'
    and preview_path !~ '/$'
    and preview_path like '%-preview.png')),
  preview_sha256 text check (preview_sha256 is null or preview_sha256 ~ '^[0-9a-f]{64}$'),
  preview_size_bytes integer check (preview_size_bytes is null or (preview_size_bytes > 0 and preview_size_bytes <= 2000000)),
  preview_width integer check (preview_width is null or preview_width > 0),
  preview_height integer check (preview_height is null or preview_height > 0),
  -- The pass's one-word outcome for the file.
  verdict text not null check (verdict in ('ready', 'no_preview', 'too_large', 'fetch_failed')),
  -- 'Ghostscript exit 1', 'file is 31 MB, cap 25 MB', 'Graph 404 after 24 h'.
  verdict_note text check (verdict_note is null or pg_catalog.length(verdict_note) <= 200),
  -- PDFs only: page 1 is rendered; a PDF over 2 pages is a document, never a row.
  page_count integer check (page_count is null or page_count between 1 and 2),
  -- own = our own mailbox (a forward Sidd sent himself); customer = the
  -- order's client_email; other = anyone else.
  sender_kind text not null check (sender_kind in ('customer', 'other', 'own')),
  -- A raster narrower than 400 px (it may be a signature picture).
  small_image boolean not null default false,
  -- 'extension says .pdf, bytes say PNG'.
  mismatch_note text check (mismatch_note is null or pg_catalog.length(mismatch_note) <= 120),
  -- The imports' listed-size sentence, copied onto the file entry on Use it.
  warnings jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(warnings) = 'array'),
  -- How many files logo_asset held when the row was made, and the card's
  -- checked_at then (null = the card was empty). A Use it refuses when the
  -- card's checked_at moved since: the artwork changed under the tap.
  card_files_at_scan integer not null default 0 check (card_files_at_scan >= 0),
  card_checked_at_snapshot text,
  -- orders.external_invoice_id and the delivery day at scan time.
  invoice_id_snapshot text,
  delivery_day_snapshot date,
  -- The body line naming the logo, contacts scrubbed by the pass.
  evidence_line text check (evidence_line is null or pg_catalog.length(evidence_line) <= 200),
  -- When the email was received (the row says 'Received Aug 22').
  source_received_at timestamptz not null,
  found_at timestamptz not null default pg_catalog.now(),
  status text not null default 'pending' check (status in ('pending', 'used', 'declined', 'superseded')),
  decided_at timestamptz,
  decided_by uuid,
  decided_via text check (decided_via is null or decided_via in ('app', 'cancelled', 'date_passed', 'invoice_changed', 'artwork_changed', 'already_on_card')),
  -- The usage word written on the file entry by Use it ('Coconut' in v1).
  usage_written text check (usage_written is null or usage_written in ('Coconut front', 'Coconut back', 'Display', 'Coconut', 'Usage needs confirmation')),
  -- When the owner's banner for this email went out (the worker).
  notified_at timestamptz,
  error_detail text check (error_detail is null or pg_catalog.length(error_detail) <= 300),
  updated_at timestamptz not null default pg_catalog.now(),
  -- A saved file has an original; only a rendered one has a preview.
  constraint order_artwork_proposals_verdict_original_check
    check ((verdict in ('ready', 'no_preview')) = (original_path is not null)),
  constraint order_artwork_proposals_verdict_preview_check
    check ((verdict = 'ready') = (preview_path is not null)),
  -- A decided row always carries its decision time and nothing else does.
  constraint order_artwork_proposals_decided_check
    check ((status in ('used', 'declined', 'superseded')) = (decided_at is not null)),
  -- The dedupe rule lives in the database: the same bytes can never be
  -- proposed twice for one order (a re-sent file, our own preview quoted
  -- back, a race between two passes), and a Not this one is remembered for
  -- good for that order. The same bytes on a DIFFERENT order (a repeat
  -- customer) get a fresh row: artwork comes from files supplied for THAT
  -- order.
  constraint order_artwork_proposals_order_sha256_key unique (order_id, sha256),
  -- One row per file per email.
  constraint order_artwork_proposals_intake_attachment_key unique (intake_id, attachment_id)
);

create index if not exists order_artwork_proposals_order_status_idx
  on public.order_artwork_proposals (order_id, status);

-- The worker's banner read: pending rows not yet notified.
create index if not exists order_artwork_proposals_pending_notify_idx
  on public.order_artwork_proposals (status, notified_at)
  where status = 'pending';

create index if not exists order_artwork_proposals_intake_idx
  on public.order_artwork_proposals (intake_id);

-- C. Grants and row security, byte for byte the 045 shape.
alter table public.order_artwork_proposals enable row level security;

revoke all on table public.order_artwork_proposals from public, anon, authenticated;
grant select on table public.order_artwork_proposals to authenticated;
grant select, insert, update, delete on table public.order_artwork_proposals to service_role;

drop policy if exists order_artwork_proposals_owner_select on public.order_artwork_proposals;
create policy order_artwork_proposals_owner_select
on public.order_artwork_proposals
for select to authenticated
using (public.hc_is_owner());

-- D. The owner's decision. Returns jsonb:
--   { applied: true,  outcome: 'used' | 'declined', files }
--   { applied: false, outcome: 'used' | 'declined' | 'superseded' | 'cancelled'
--                   | 'refused', message }
-- Use it appends the one file to orders.logo_asset and sets logo_received;
-- skip (Not this one) and dismiss (Dismiss) write nothing to orders. Never
-- raises for a state the app should simply show; raises 42501 for the
-- wrong caller and 22023 for a malformed call.
create or replace function public.hc_decide_proposed_artwork(
  p_order_id uuid,
  p_proposal_id bigint,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_decision text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_decision, '')));
  v_p public.order_artwork_proposals%rowtype;
  v_stage text;
  v_invoice_id text;
  v_delivery_at timestamptz;
  v_event_start timestamptz;
  v_asset jsonb;
  v_files jsonb;
  v_file jsonb;
  v_ref jsonb;
  v_ids jsonb;
  v_status text;
  v_day date;
  v_today date;
  v_source_msg_id text;
  v_received timestamptz;
  v_existing_received timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
  -- The stamps the hand imports print: checked_at with milliseconds and a
  -- Z, source_received_at to the second with a Z.
  v_now_text text;
  v_outcome text;
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'only the owner can decide a proposed artwork file';
  end if;

  if v_decision not in ('use', 'skip', 'dismiss') then
    raise exception using
      errcode = '22023',
      message = 'decision must be use, skip or dismiss';
  end if;

  if p_order_id is null or p_proposal_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id and a proposal id are required';
  end if;

  select p.* into v_p
  from public.order_artwork_proposals as p
  where p.id = p_proposal_id
    and p.order_id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such artwork proposal';
  end if;

  -- Already decided: report it, write nothing.
  if v_p.status <> 'pending' then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', v_p.status, 'decided_at', v_p.decided_at,
      'message', 'Already decided.');
  end if;

  -- The row lock makes the append atomic against a hand import's
  -- logo_asset=is.null PATCH (which then answers 0 rows and stops) and
  -- against a second tap.
  select o.stage, o.external_invoice_id, o.delivery_at_utc, o.event_start_at, o.logo_asset
  into v_stage, v_invoice_id, v_delivery_at, v_event_start, v_asset
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such order';
  end if;

  if v_stage = 'cancelled' then
    update public.order_artwork_proposals
       set status = 'superseded', decided_via = 'cancelled', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where id = p_proposal_id;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'cancelled',
      'message', 'This order is cancelled.');
  end if;

  -- The delivery day the way the app and 045 bucket days (the UTC calendar
  -- date of the delivery marker, else of the event start), against today
  -- in New York. A day that has passed has nothing left to brand.
  v_day := coalesce(
    (v_delivery_at at time zone 'UTC')::date,
    (v_event_start at time zone 'UTC')::date);
  v_today := (v_now at time zone 'America/New_York')::date;
  if v_day is not null and v_day < v_today then
    update public.order_artwork_proposals
       set status = 'superseded', decided_via = 'date_passed', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where id = p_proposal_id;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'superseded',
      'message', 'The delivery day has passed.');
  end if;

  -- The invoice on the order is not the one the file was read against.
  if v_invoice_id is distinct from v_p.invoice_id_snapshot then
    update public.order_artwork_proposals
       set status = 'superseded', decided_via = 'invoice_changed', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where id = p_proposal_id;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'superseded',
      'message', 'The invoice on this order changed after this email.');
  end if;

  if v_decision = 'use' then
    -- The card's artwork changed since the scan (a hand import, another
    -- Use it, an Approve): the row's picture of the card is stale.
    if coalesce(v_asset ->> 'checked_at', '') is distinct from coalesce(v_p.card_checked_at_snapshot, '') then
      update public.order_artwork_proposals
         set status = 'superseded', decided_via = 'artwork_changed', decided_at = v_now,
             decided_by = v_uid, updated_at = v_now
       where id = p_proposal_id;
      return pg_catalog.jsonb_build_object(
        'applied', false, 'outcome', 'superseded',
        'message', 'The artwork on the card changed since this email was read. Open the Calendar.');
    end if;

    -- Nothing was saved (too large, or the email moved before the fetch).
    -- The app never offers Use it on such a row; this is the net.
    if v_p.verdict not in ('ready', 'no_preview') or v_p.original_path is null then
      return pg_catalog.jsonb_build_object(
        'applied', false, 'outcome', 'refused',
        'message', 'Nothing was saved from this email. Get the file another way, then Dismiss.');
    end if;

    v_files := case when pg_catalog.jsonb_typeof(v_asset -> 'files') = 'array'
      then v_asset -> 'files' else '[]'::jsonb end;

    -- The same bytes are already on the card (as an original or as a
    -- preview): nothing to add. The row is closed as used so it never
    -- shows again; logo_asset is untouched.
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_files) as logo_file(value)
      where pg_catalog.jsonb_typeof(logo_file.value) = 'object'
        and (logo_file.value ->> 'sha256' = v_p.sha256
          or logo_file.value ->> 'preview_sha256' = v_p.sha256)
    ) then
      update public.order_artwork_proposals
         set status = 'used', decided_via = 'already_on_card', decided_at = v_now,
             decided_by = v_uid, updated_at = v_now
       where id = p_proposal_id;
      -- Same guard as the dismissal at the end: only an email the worker
      -- has already read (address_scanned_at set) is closed here.
      update public.intake_messages
         set status = 'dismissed',
             reviewed_at = v_now,
             error_detail = 'artwork proposal used by the owner in HC Field'
       where id = v_p.intake_id
         and status = 'pending_review'
         and address_scanned_at is not null;
      return pg_catalog.jsonb_build_object(
        'applied', false, 'outcome', 'used',
        'message', 'Already on the card.');
    end if;

    -- The app renders at most 12 files on a card (order-logo-files.js:17).
    if pg_catalog.jsonb_array_length(v_files) >= 12 then
      return pg_catalog.jsonb_build_object(
        'applied', false, 'outcome', 'refused',
        'message', 'This card already holds 12 files. Remove one by hand first.');
    end if;

    select m.source_msg_id into v_source_msg_id
    from public.intake_messages as m
    where m.id = v_p.intake_id;

    v_now_text := pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_received := v_p.source_received_at;

    -- Exactly the keys the hand imports wrote (import_alison_logo.py:86-94),
    -- plus the two owner-only approval keys. The 035 crew projection strips
    -- everything but file_name, mime_type, original_path, preview_path and
    -- usage; the 036 fingerprint ignores the rest.
    v_file := pg_catalog.jsonb_build_object(
      'usage', 'Coconut',
      'sha256', v_p.sha256,
      'warnings', v_p.warnings,
      'file_name', v_p.file_name,
      'mime_type', v_p.mime_type,
      'size_bytes', v_p.size_bytes,
      'source_ref', pg_catalog.jsonb_build_object('kind', 'email', 'message_id', v_source_msg_id),
      'preview_path', v_p.preview_path,
      'original_path', v_p.original_path,
      'preview_sha256', v_p.preview_sha256,
      'preview_size_bytes', v_p.preview_size_bytes,
      'source_received_at', pg_catalog.to_char(v_received at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'attachment_listed_size_bytes', v_p.attachment_listed_size_bytes,
      'approved_at', v_now_text,
      'approved_by', v_uid);
    v_files := v_files || pg_catalog.jsonb_build_array(v_file);

    -- 'approved' only when every listed file carries approved_at: an older
    -- file never inherits approval from a new tap, a new file never
    -- inherits an old approval. needs_review is never lifted here.
    v_status := case
      when v_asset ->> 'status' = 'needs_review' then 'needs_review'
      when not exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_files) as logo_file(value)
        where pg_catalog.jsonb_typeof(logo_file.value) <> 'object'
           or coalesce(pg_catalog.jsonb_typeof(logo_file.value -> 'approved_at'), 'missing') <> 'string'
           or pg_catalog.btrim(coalesce(logo_file.value ->> 'approved_at', '')) = '')
        then 'approved'
      else 'received' end;

    -- source_ref.message_ids appended distinct; source_received_at the
    -- newer of the two (an unreadable existing stamp yields to this one).
    v_ref := case when pg_catalog.jsonb_typeof(v_asset -> 'source_ref') = 'object'
      then v_asset -> 'source_ref' else '{}'::jsonb end;
    v_ids := case when pg_catalog.jsonb_typeof(v_ref -> 'message_ids') = 'array'
      then v_ref -> 'message_ids' else '[]'::jsonb end;
    if v_source_msg_id is not null and not (v_ids ? v_source_msg_id) then
      v_ids := v_ids || pg_catalog.to_jsonb(v_source_msg_id);
    end if;
    v_ref := v_ref || pg_catalog.jsonb_build_object('kind', coalesce(v_ref ->> 'kind', 'email'), 'message_ids', v_ids);
    v_existing_received := null;
    begin
      if (v_asset ->> 'source_received_at') ~ '^\d{4}-\d{2}-\d{2}T' then
        v_existing_received := (v_asset ->> 'source_received_at')::timestamptz;
      end if;
    exception when others then
      v_existing_received := null;
    end;
    if v_existing_received is not null and v_existing_received > v_received then
      v_received := v_existing_received;
    end if;

    v_asset := coalesce(v_asset, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'status', v_status,
      'checked_at', v_now_text,
      'files', v_files,
      'source_ref', v_ref,
      'source_received_at', pg_catalog.to_char(v_received at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

    -- The one write to the order. logo_url is never touched (the Telegram
    -- forward path keeps writing it).
    update public.orders
       set logo_asset = v_asset,
           logo_received = true,
           updated_at = v_now
     where id = p_order_id;

    update public.order_artwork_proposals
       set status = 'used', decided_via = 'app', decided_at = v_now,
           decided_by = v_uid, usage_written = 'Coconut', updated_at = v_now
     where id = p_proposal_id;
    v_outcome := 'used';

    -- The card just moved under every OTHER pending row for this order (a
    -- second file from the same email, a front and a back): their snapshot
    -- of the card is re-taken here, in the same transaction, so the next
    -- Use it lands instead of being refused as artwork_changed, and the
    -- worker's retire step (which compares the same two values) leaves them
    -- alone. Without this a second file could never be used or proposed
    -- again (unique on order and sha256). The plan promises "three rows,
    -- decided one by one".
    update public.order_artwork_proposals
       set card_checked_at_snapshot = v_now_text,
           card_files_at_scan = pg_catalog.jsonb_array_length(v_files),
           updated_at = v_now
     where order_id = p_order_id
       and status = 'pending'
       and id <> p_proposal_id;
  else
    -- Not this one, or Dismiss on a row nothing was saved from. Nothing
    -- else anywhere: orders is untouched. The unique (order_id, sha256)
    -- key remembers the refusal for good.
    update public.order_artwork_proposals
       set status = 'declined', decided_via = 'app', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where id = p_proposal_id;
    v_outcome := 'declined';
    v_files := case when pg_catalog.jsonb_typeof(v_asset -> 'files') = 'array'
      then v_asset -> 'files' else '[]'::jsonb end;
  end if;

  -- The email is answered either way; the Telegram queue stops nagging.
  -- Status-guarded: a row a time or address decision, or the replay,
  -- already dismissed is left alone. A second file from the same email
  -- keeps its own row; only its intake row is already dismissed.
  -- THE WINDOW: the droplet pass makes this row about 3 minutes after the
  -- email lands and the worker reads pending_review rows every 5 minutes,
  -- so a tap can come BEFORE the worker's reply scan and its time and
  -- address scan ever read the email. A reply that carries the logo AND
  -- "we moved to 2 PM" must not vanish from those scans, so the dismissal
  -- lands only once the worker has read the email (address_scanned_at is
  -- the stamp of that read, 045). A row the worker has not read yet stays
  -- pending_review; the next tick reads it, and its Telegram card already
  -- says to decide in the app.
  update public.intake_messages
     set status = 'dismissed',
         reviewed_at = v_now,
         error_detail = 'artwork proposal ' || v_outcome || ' by the owner in HC Field'
   where id = v_p.intake_id
     and status = 'pending_review'
     and address_scanned_at is not null;

  return pg_catalog.jsonb_build_object(
    'applied', true, 'outcome', v_outcome, 'files', pg_catalog.jsonb_array_length(v_files));
end
$function$;

-- Supabase default privileges hand execute on a new function to anon,
-- authenticated AND service_role. Take every default back, then grant the
-- one caller: a logged-in phone (the function checks the owner role
-- itself). The worker and the droplet never call this.
revoke all on function public.hc_decide_proposed_artwork(uuid, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_decide_proposed_artwork(uuid, bigint, text)
  to authenticated;

comment on function public.hc_decide_proposed_artwork(uuid, bigint, text) is
  'Owner-only Use it (use), Not this one (skip) or Dismiss (dismiss) of an artwork file proposed from a customer email about a booked job. Use it appends that ONE file to orders.logo_asset in the 035 shape (usage Coconut, approved_at and approved_by on the entry), sets logo_received true, makes the record approved only when every listed file carries approved_at (needs_review is never lifted), and re-takes the card snapshot of every other pending row for the order so a second file from the same email can still be used. A cancelled order, a passed delivery day, a changed invoice, a card whose artwork changed since the scan, a file that was never saved, bytes already on the card or a card holding 12 files is reported as not applied, never raised. Both decisions dismiss the intake row, but only once the worker has read the email (address_scanned_at set); an unread row stays pending_review for the next tick.';

-- E. The owner's Approve artwork on a record already on a card. Returns:
--   { applied: true,  outcome: 'approved', checked_at }
--   { applied: false, outcome: 'changed' | 'incomplete' | 'needs_review'
--                   | 'approved', message }
-- Compare-and-set on checked_at: an approval never lands on a card that
-- changed under the tap. Every file gains approved_at and approved_by,
-- the status becomes approved, checked_at moves (the 036 fingerprint
-- resets on purpose: the crew re-do the stamp check against the approved
-- set), logo_received becomes true.
create or replace function public.hc_approve_order_artwork(
  p_order_id uuid,
  p_checked_at text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_asset jsonb;
  v_files jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_now_text text;
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'only the owner can approve artwork';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id is required';
  end if;

  select o.logo_asset into v_asset
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such order';
  end if;

  if v_asset is null
     or pg_catalog.jsonb_typeof(v_asset -> 'files') <> 'array'
     or pg_catalog.jsonb_array_length(v_asset -> 'files') = 0 then
    raise exception using
      errcode = '22023',
      message = 'No artwork on this order';
  end if;

  -- The card the owner looked at is the card being approved.
  if coalesce(v_asset ->> 'checked_at', '') is distinct from coalesce(pg_catalog.btrim(p_checked_at), '') then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'changed',
      'message', 'The artwork on the card changed since you looked. Open the Calendar.');
  end if;

  if v_asset ->> 'status' = 'needs_review' then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'needs_review',
      'message', 'This artwork is marked needs review; fix it by hand first.');
  end if;

  -- Every file needs a usage word from the 035 vocabulary; the imports'
  -- free text and 'Usage needs confirmation' are refused.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_asset -> 'files') as logo_file(value)
    where pg_catalog.jsonb_typeof(logo_file.value) <> 'object'
       or coalesce(logo_file.value ->> 'usage', '') not in ('Coconut front', 'Coconut back', 'Display', 'Coconut')
  ) then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'incomplete',
      'message', 'Every file needs a usage word before approval.');
  end if;

  -- Already approved with every file stamped: a re-tap moves nothing (the
  -- 036 fingerprint would reset the crew's stamp check for no reason).
  if v_asset ->> 'status' = 'approved' and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_asset -> 'files') as logo_file(value)
    where coalesce(pg_catalog.jsonb_typeof(logo_file.value -> 'approved_at'), 'missing') <> 'string'
       or pg_catalog.btrim(coalesce(logo_file.value ->> 'approved_at', '')) = ''
  ) then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'approved',
      'message', 'Already approved.');
  end if;

  v_now_text := pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- Every file lacking approved_at gets it now; files already approved keep
  -- their own stamp. Order and every other key are kept.
  select pg_catalog.jsonb_agg(
    case when coalesce(pg_catalog.jsonb_typeof(logo_file.value -> 'approved_at'), 'missing') = 'string'
              and pg_catalog.btrim(coalesce(logo_file.value ->> 'approved_at', '')) <> ''
         then logo_file.value
         else logo_file.value || pg_catalog.jsonb_build_object('approved_at', v_now_text, 'approved_by', v_uid) end
    order by logo_file.position)
  into v_files
  from pg_catalog.jsonb_array_elements(v_asset -> 'files') with ordinality as logo_file(value, position);

  v_asset := v_asset || pg_catalog.jsonb_build_object(
    'status', 'approved',
    'checked_at', v_now_text,
    'files', v_files);

  update public.orders
     set logo_asset = v_asset,
         logo_received = true,
         updated_at = v_now
   where id = p_order_id;

  return pg_catalog.jsonb_build_object(
    'applied', true, 'outcome', 'approved', 'checked_at', v_now_text);
end
$function$;

revoke all on function public.hc_approve_order_artwork(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_approve_order_artwork(uuid, text)
  to authenticated;

comment on function public.hc_approve_order_artwork(uuid, text) is
  'Owner-only Approve artwork on an order whose logo_asset (035) is on record. Compare-and-set on logo_asset.checked_at (a changed card is reported, never raised); refuses a record marked needs_review or any file without a usage word from the 035 vocabulary; stamps approved_at and approved_by on every file lacking them, sets status approved, moves checked_at (the 036 prep fingerprint resets on purpose) and logo_received true.';

-- F. The 035 logo-read helper, re-created with the 035 body verbatim as the
-- first branch OR one clause: an active OWNER phone may sign a URL for a
-- proposal's original or preview while the row is pending or was decided
-- in the last 30 days (the owner can re-look at what was declined). A
-- manager or crew phone can never sign a proposal path: for them the 035
-- rule (a path on a card in their market) is the whole answer. The three
-- 035 storage policies call this helper by name and are untouched.
create or replace function public.hc_can_read_order_logo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null
    and p_name is not null
    and pg_catalog.length(p_name) > 0
    and exists (
      select 1
      from public.orders as order_row
      join public.field_workers as worker
        on worker.auth_user_id = auth.uid()
       and worker.active is true
      where (
        lower(trim(worker.role)) = 'owner'
        or (
          lower(trim(worker.role)) in ('manager', 'team')
          and nullif(lower(trim(worker.market)), '') is not null
          and nullif(lower(trim(order_row.market)), '') is not null
          and lower(trim(order_row.market)) = lower(trim(worker.market))
        )
      )
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(order_row.logo_asset -> 'files') = 'array'
            then order_row.logo_asset -> 'files' else '[]'::jsonb end
        ) as logo_file(value)
        where pg_catalog.jsonb_typeof(logo_file.value) = 'object'
        and (
          (
            pg_catalog.jsonb_typeof(logo_file.value -> 'original_path') = 'string'
            and logo_file.value ->> 'original_path' = p_name
          )
          or (
            pg_catalog.jsonb_typeof(logo_file.value -> 'preview_path') = 'string'
            and logo_file.value ->> 'preview_path' = p_name
          )
        )
      )
    )
    or (
      auth.uid() is not null
      and p_name is not null
      and pg_catalog.length(p_name) > 0
      and exists (
        select 1
        from public.field_workers as worker
        where worker.auth_user_id = auth.uid()
          and worker.active is true
          and lower(trim(worker.role)) = 'owner'
      )
      and exists (
        select 1
        from public.order_artwork_proposals as proposal
        where (proposal.original_path = p_name or proposal.preview_path = p_name)
          and (proposal.status = 'pending' or proposal.decided_at > pg_catalog.now() - interval '30 days')
      )
    );
$function$;

revoke all on function public.hc_can_read_order_logo(text) from public, anon, authenticated;
grant execute on function public.hc_can_read_order_logo(text) to authenticated;

-- G. The bucket cap: the server-side backstop of the pass's 25 MB limit.
-- Only on the private bucket 035 made (the preflight refused a public one).
update storage.buckets
   set file_size_limit = 25000000
 where id = 'order-logos'
   and public = false;

comment on table public.order_artwork_proposals is
  'One artwork file proposed from a customer email about a booked job (fetched, fingerprinted and previewed into the private order-logos bucket by the droplet artwork pass), waiting for the owner''s Use it or Not this one in HC Field. Owner-readable only. Never changes an order by itself: only the owner''s tap through hc_decide_proposed_artwork writes orders.logo_asset.';

-- H. Postflight.
do $postflight$
declare
  v_src text;
  v_limit bigint;
  v_public boolean;
  v_policy text;
  v_ok boolean;
begin
  if pg_catalog.to_regclass('public.order_artwork_proposals') is null
     or not (select c.relrowsecurity from pg_catalog.pg_class as c where c.oid = 'public.order_artwork_proposals'::regclass) then
    raise exception using errcode = '55000', message = '048 postflight: the table or its row security is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'order_artwork_proposals'
      and policyname = 'order_artwork_proposals_owner_select'
  ) then
    raise exception using errcode = '55000', message = '048 postflight: the owner select policy is missing';
  end if;
  -- A name is not enough: a table that already existed could carry a
  -- second, wider read policy.
  if (select pg_catalog.count(*) from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'order_artwork_proposals') <> 1 then
    raise exception using errcode = '55000', message = '048 postflight: order_artwork_proposals must carry exactly one policy (the owner select)';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.order_artwork_proposals', 'select')
     or not pg_catalog.has_table_privilege('authenticated', 'public.order_artwork_proposals', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_artwork_proposals', 'insert')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_artwork_proposals', 'update')
     or not pg_catalog.has_table_privilege('service_role', 'public.order_artwork_proposals', 'insert') then
    raise exception using errcode = '55000', message = '048 postflight: table grants are wrong';
  end if;
  -- Both unique keys and the three check pairs.
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint as c
      where c.conrelid = 'public.order_artwork_proposals'::regclass
        and c.conname in ('order_artwork_proposals_order_sha256_key', 'order_artwork_proposals_intake_attachment_key')
        and c.contype = 'u') <> 2 then
    raise exception using errcode = '55000', message = '048 postflight: a unique constraint on order_artwork_proposals is missing';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint as c
      where c.conrelid = 'public.order_artwork_proposals'::regclass
        and c.conname in ('order_artwork_proposals_verdict_original_check', 'order_artwork_proposals_verdict_preview_check', 'order_artwork_proposals_decided_check')
        and c.contype = 'c') <> 3 then
    raise exception using errcode = '55000', message = '048 postflight: a check constraint on order_artwork_proposals is missing';
  end if;
  if pg_catalog.to_regclass('public.order_artwork_proposals_order_status_idx') is null
     or pg_catalog.to_regclass('public.order_artwork_proposals_pending_notify_idx') is null
     or pg_catalog.to_regclass('public.order_artwork_proposals_intake_idx') is null then
    raise exception using errcode = '55000', message = '048 postflight: an index on order_artwork_proposals is missing';
  end if;
  -- Both functions execute for authenticated only.
  if pg_catalog.to_regprocedure('public.hc_decide_proposed_artwork(uuid, bigint, text)') is null
     or pg_catalog.has_function_privilege('anon', 'public.hc_decide_proposed_artwork(uuid, bigint, text)', 'execute')
     or pg_catalog.has_function_privilege('public', 'public.hc_decide_proposed_artwork(uuid, bigint, text)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'public.hc_decide_proposed_artwork(uuid, bigint, text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_decide_proposed_artwork(uuid, bigint, text)', 'execute') then
    raise exception using errcode = '55000', message = '048 postflight: hc_decide_proposed_artwork grants are wrong';
  end if;
  if pg_catalog.to_regprocedure('public.hc_approve_order_artwork(uuid, text)') is null
     or pg_catalog.has_function_privilege('anon', 'public.hc_approve_order_artwork(uuid, text)', 'execute')
     or pg_catalog.has_function_privilege('public', 'public.hc_approve_order_artwork(uuid, text)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'public.hc_approve_order_artwork(uuid, text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_approve_order_artwork(uuid, text)', 'execute') then
    raise exception using errcode = '55000', message = '048 postflight: hc_approve_order_artwork grants are wrong';
  end if;
  -- The logo-read helper: authenticated only, carries both the 035
  -- fingerprint and the 048 clause, and the three 035 policies still stand.
  if pg_catalog.has_function_privilege('anon', 'public.hc_can_read_order_logo(text)', 'execute')
     or pg_catalog.has_function_privilege('public', 'public.hc_can_read_order_logo(text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_can_read_order_logo(text)', 'execute') then
    raise exception using errcode = '55000', message = '048 postflight: hc_can_read_order_logo grants are wrong';
  end if;
  select p.prosrc into v_src from pg_catalog.pg_proc as p
  where p.oid = pg_catalog.to_regprocedure('public.hc_can_read_order_logo(text)');
  if pg_catalog.strpos(v_src, 'order_artwork_proposals') = 0
     or pg_catalog.strpos(v_src, 'logo_file.value ->> ''preview_path'' = p_name') = 0
     or pg_catalog.strpos(v_src, 'lower(trim(order_row.market)) = lower(trim(worker.market))') = 0
     or pg_catalog.strpos(v_src, 'lower(trim(worker.role)) = ''owner''') = 0 then
    raise exception using errcode = '55000', message = '048 postflight: hc_can_read_order_logo does not carry the 035 text plus the 048 clause';
  end if;
  foreach v_policy in array array['hc_order_logos_selected_read', 'hc_order_logos_authenticated_read_guard', 'hc_order_logos_anonymous_read_guard'] loop
    if not exists (
      select 1 from pg_catalog.pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = v_policy
    ) then
      raise exception using errcode = '55000', message = pg_catalog.format('048 postflight: the 035 storage policy %s is missing', v_policy);
    end if;
  end loop;
  -- The migration role has no auth.uid(): the helper answers false.
  select public.hc_can_read_order_logo('nope') into v_ok;
  if v_ok is distinct from false then
    raise exception using errcode = '55000', message = '048 postflight: hc_can_read_order_logo answered true with no signed-in user';
  end if;
  -- The bucket is still private and carries the cap.
  select b.public, b.file_size_limit into v_public, v_limit from storage.buckets as b where b.id = 'order-logos';
  if not found or v_public is distinct from false or v_limit is distinct from 25000000::bigint then
    raise exception using errcode = '55000', message = '048 postflight: the order-logos bucket is not private with the 25000000 byte cap';
  end if;
  -- Both intake columns, the right types.
  if not exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.intake_messages'::regclass
      and a.attname = 'email_meta'
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'jsonb'
  ) or not exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.intake_messages'::regclass
      and a.attname = 'artwork_scanned_at'
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
  ) then
    raise exception using errcode = '55000', message = '048 postflight: intake_messages.email_meta or artwork_scanned_at is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.intake_messages'::regclass
      and c.conname = 'intake_messages_email_meta_object'
      and c.contype = 'c'
  ) then
    raise exception using errcode = '55000', message = '048 postflight: the email_meta object check is missing';
  end if;
end
$postflight$;

commit;
