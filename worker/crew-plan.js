// worker/crew-plan.js: the automatic crew plan's PURE rules (migration 073).
//
// Sidd asked on 2026-11-26: "Why do I have to do field team schedule by
// hand". This module is the robot's brain: rules R1 to R13 of the design
// (handoff-2026-10-15/crew-schedule-2026-11-27/CREW-SCHEDULE-DESIGN.md,
// critic edits binding) and the shared contract
// worker/test-vectors/crew-plan-cases.json (pinned by sha256 in
// worker/test-crew-plan.mjs).
//
// Nothing here touches the network, a clock or a global: the caller passes
// the moment ("now") and every fact. runCrewPlanScan in worker.js gathers
// the facts, calls planCrew, routes and writes through hc_crew_plan_put.
// The departure plan's own helpers (parseArrivalTime, leaveByMs,
// routeSanity, marketZone) come in through `lib`, so the leave-by here is
// the alarm's leave-by, byte for byte.
//
// Safety rules this file keeps (never break them):
// - It never invents a person, a place, a time or an address. When a fact
//   is missing it adds a gap flag (red: Sidd must answer; amber: a look).
// - The App Review login and every never_schedule worker are never picked
//   (second lock; the database refuses them too).
// - Crew words never carry money, an email, a phone, the supplier's name or
//   the word billed. Gap words are for Sidd; crew never see them.
// - Roster people are planned by their LIVE field_workers.market only.
// - Helpers (one-off crew outside the app) are named on rows; nothing here
//   ever messages them.
// ASCII only.

// ---------------------------------------------------------------- md5
// Postgres md5() as hex, in plain JavaScript (Web Crypto has no MD5 and
// Node's crypto is not in the Worker). Checked against node:crypto in the
// test file.
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = (() => {
  const k = new Int32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  return k;
})();
export function md5Hex(text) {
  const msg = new TextEncoder().encode(String(text));
  const len = msg.length;
  const blocks = ((len + 8) >>> 6) + 1;
  const w = new Int32Array(blocks * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= msg[i] << ((i % 4) * 8);
  w[len >> 2] |= 0x80 << ((len % 4) * 8);
  w[blocks * 16 - 2] = (len * 8) | 0;
  w[blocks * 16 - 1] = Math.floor(len / 536870912) | 0;
  let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
  for (let off = 0; off < w.length; off += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d; d = c; c = b;
      const x = (a + f + MD5_K[i] + w[off + g]) | 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const hex = (n) => { let s = ''; for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 255).toString(16).padStart(2, '0'); return s; };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
// Postgres md5(text)::uuid (the 070 banner id shape).
export function md5Uuid(text) {
  const h = md5Hex(text);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
// JSON with object keys sorted at every depth (arrays keep their order), so
// the same facts always give the same text and the same md5.
export function stableJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

// ---------------------------------------------------------------- constants
export const CREW_HOLD_WORDS = 'On hold: Sidd is checking this job.';
export const CREW_APP_REVIEW_EMAIL = 'appreview@hamptonscoconuts.com';
export const CREW_CONFIRMED_STAGES = ['invoiced', 'deposit_paid', 'paid_full'];
const DONE_STAGES = ['fulfilled', 'complete'];
export const CREW_MARKET_WORDS = { ny: 'New York', vegas: 'Las Vegas', miami: 'Miami', la: 'Los Angeles' };
// The states a market's crew can drive to. ny is the design's list (R9).
const DRIVE_AREA = { ny: ['NY', 'NJ', 'CT', 'PA'], vegas: ['NV'], miami: ['FL'], la: ['CA'] };
const CUT_WORDS = { straw: 'straw hole', straw_hole: 'straw hole', circle: 'circle', cocktail: 'cocktail', whole: 'whole' };
// The 073 seed values. Used only when a rule row is missing (crew_rules has
// a no-delete guard, so that happens only by hand); boxes_per_car missing
// is said as red rule_missing.
const RULE_SEED = { planned: 0, boxes_per_car: 25, two_people_over: 25, receive_people: 1, load_minutes: 15,
  unload_minutes: 30, earliest_start_min: 360, max_span_hours: 12 };
// The 26 stored task keys, in order (reply-shapes-073.md 2.1).
export const CREW_TASK_KEYS = ['key', 'source', 'kind', 'order_id', 'supply_id', 'from_site', 'to_site', 'to_address',
  'boxes', 'coconuts', 'cars', 'need', 'people', 'start', 'end', 'busy_from', 'busy_to', 'when', 'time_source',
  'leave_by', 'drive_min', 'route_at', 'gaps', 'label', 'words', 'why'];
// The 41 gap codes: level and who may see them (contract gap_codes).
export const CREW_GAPS = {
  no_time: ['red', false], no_address: ['red', false], address_conflict: ['red', true], people_short: ['red', false],
  no_crew_in_market: ['red', false], clash: ['red', false], person_off: ['red', false], no_staging: ['red', false],
  hold_too_long: ['red', false], hold_unknown: ['red', false], prep_place_unknown: ['red', false],
  equipment_no_time: ['red', false], equipment_no_home: ['red', false], rule_missing: ['red', false],
  out_of_area: ['red', false], needs_ampm: ['red', false], calendar_check: ['red', true], day_not_linked: ['red', true],
  count_missing: ['red', true], count_disputed: ['red', true], boxes_short: ['red', true],
  rule_unconfirmed: ['amber', false], helper_ask: ['amber', false], pending_day_off: ['amber', false],
  long_day: ['amber', false], no_arrival: ['amber', false], start_after_leave_by: ['amber', false],
  early_start: ['amber', false], site_closed: ['amber', false], late_supply: ['amber', false],
  cut_unknown: ['amber', false], branding_unknown: ['amber', false], no_supply_record: ['amber', true],
  drop_window_overlap: ['amber', false], time_unconfirmed: ['amber', false], time_proposal_pending: ['amber', false],
  route_pending: ['amber', false], hold_unconfirmed: ['amber', false], addon_not_on_card: ['amber', true],
  claim_no_drop_day: ['amber', true], market_not_planned: ['amber', true],
};
// How many route calls one run may make (design 4.2) and how long a
// cached drive time is trusted on a draft day.
export const CREW_ROUTE_CALLS_MAX = 3;
export const CREW_ROUTE_CACHE_HOURS = 24;
export const CREW_ROUTE_FAIL_RUNS = 3;
// A draft day keeps its own stored drive time while the departure plan's
// live-traffic drive is within this many minutes of it (the departure
// plan's own "ETA moved 10 or more minutes" rule).
export const CREW_DRIFT_MINUTES = 10;
// 073's stored task ranges (hc_crew_task_norm): a value outside them makes
// the server refuse the WHOLE day, so the robot never sends one.
export const CREW_LIMITS = { cars: 6, need: 8, boxes: 500, coconuts: 5000 };

// ---------------------------------------------------------------- small helpers
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const trimText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
function idOf(v) {
  const s = trimText(v).toLowerCase();
  return s || null;
}
export function crewMarketKey(market) {
  const key = trimText(market).toLowerCase();
  return key || 'ny';
}
// A PERSON's live market (field_workers.market, a helper's helper_market):
// blank is no market at all, so a person with no market is never planned
// and never sent a crew banner (073 refuses them in every market).
export function crewLiveMarket(market) {
  const key = trimText(market).toLowerCase();
  return key || null;
}
function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function dayMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}
export function crewDayAdd(day, n) {
  const ms = dayMs(day);
  return Number.isFinite(ms) ? new Date(ms + n * 86400000).toISOString().slice(0, 10) : '';
}
export function crewDayDiff(fromDay, toDay) {
  const a = dayMs(fromDay), b = dayMs(toDay);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
}
// The Monday that starts a day's Mon to Sun week.
export function crewWeekStart(day) {
  const ms = dayMs(day);
  if (!Number.isFinite(ms)) return '';
  const wd = new Date(ms).getUTCDay();
  return crewDayAdd(day, -((wd + 6) % 7));
}
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 070 hc_time_off_day_words: "Mon Nov 30", plus ", 2027" when the year is
// not this year.
export function crewDayWords(day, thisYear) {
  const ms = dayMs(day);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const base = WEEKDAY[d.getUTCDay()] + ' ' + MONTH[d.getUTCMonth()] + ' ' + d.getUTCDate();
  return thisYear && String(d.getUTCFullYear()) !== String(thisYear) ? base + ', ' + d.getUTCFullYear() : base;
}
// 'HH:MM' <-> minutes since midnight.
export function crewHmToMin(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm == null ? '' : hm).trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h >= 0 && h <= 23 && mm >= 0 && mm <= 59 ? h * 60 + mm : null;
}
export function crewMinToHm(min) {
  if (!isFiniteNum(min)) return null;
  const v = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}
// '6:00 AM' (12-hour, no leading zero), plus ' PT' in Las Vegas.
export function crewClock(min, market) {
  if (!isFiniteNum(min)) return '';
  const v = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  const hh = Math.floor(v / 60), mm = v % 60;
  const text = (hh % 12 === 0 ? 12 : hh % 12) + ':' + String(mm).padStart(2, '0') + ' ' + (hh < 12 ? 'AM' : 'PM');
  return crewMarketKey(market) === 'vegas' ? text + ' PT' : text;
}
function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}
function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function lowFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
// Wall-clock minutes and the calendar day of an instant in a time zone.
function zoneParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { day: get('year') + '-' + get('month') + '-' + get('day'), min: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}
export function crewDayInZone(ms, tz) { return zoneParts(ms, tz).day; }
export function crewMinInZone(ms, tz) { return zoneParts(ms, tz).min; }

// ---------------------------------------------------------------- the word check
// hc_crew_text_ok: no @, no $, no phone shape (072's regex), no run of 7 or
// more digits, no link, no control character, and never the supplier's name
// or the word billed as a whole word (073 refuses all of these, so a text
// that fails here would make the server refuse the whole day).
const PHONE_RE = /\(?[0-9]{3}\)?[-. ][0-9]{3}[-. ][0-9]{4}/;
export function crewTextOk(text) {
  const s = String(text == null ? '' : text);
  if (/[@$]/.test(s)) return false;
  if (PHONE_RE.test(s)) return false;
  if (/[0-9]{7,}/.test(s)) return false;
  if (/http/i.test(s)) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/\b(weee|billed)\b/i.test(s)) return false;
  return true;
}
// THE Navigate address rule, shared with the database's hold check (contract
// rules.held): every run of ASCII whitespace (space, tab, line break) becomes
// one space and the ends are trimmed; when the result fails the word check,
// only its comma parts that pass are kept, joined by ", "; nothing left, or
// more than 200 characters (073's to_address limit), is none. Never adds
// anything. ASCII whitespace only, so SQL's '[ \t\n\r\f\v]+' matches it.
const NAV_WS = /[ \t\n\r\f\v]+/g;
export const CREW_ADDRESS_MAX = 200;
const navSpaces = (v) => String(v == null ? '' : v).replace(NAV_WS, ' ').trim();
export function crewCleanAddress(text) {
  const s = navSpaces(text);
  if (!s) return null;
  let out = s;
  if (!crewTextOk(out)) {
    out = s.split(',').map((p) => p.trim()).filter((p) => p && crewTextOk(p)).join(', ');
    if (!out || !crewTextOk(out)) return null;
  }
  return out.length > CREW_ADDRESS_MAX ? null : out;
}
// company when not blank, else client_name, trimmed, first 40 characters.
export function crewClientLabel(order) {
  const o = order || {};
  const raw = trimText(o.company) || trimText(o.client_name);
  const label = raw.slice(0, 40).trim();
  return label && crewTextOk(label) ? label : 'the client';
}
// The first comma part of an address ("Test Pier").
export function crewVenueLabel(address) {
  const first = trimText(address).split(',')[0].trim();
  return first || null;
}
// The LAST 5-digit token of an address.
export function crewZipOf(address) {
  const all = trimText(address).match(/\b\d{5}\b/g);
  return all && all.length ? all[all.length - 1] : null;
}
// The 2-letter token before the last zip (", IL 60000"), else a final ", XX".
export function crewStateOf(address) {
  const s = trimText(address);
  const m = /,\s*([A-Za-z]{2})\s+\d{5}(?:-\d{4})?(?!.*\b\d{5}\b)/.exec(s);
  if (m) return m[1].toUpperCase();
  const e = /,\s*([A-Za-z]{2})\s*$/.exec(s);
  return e ? e[1].toUpperCase() : null;
}
// R1: 072 hc_order_family_day(coalesce(delivery_at_utc, event_start_at)): a
// 00:00 UTC marker is that date, any other time is its New York date.
export function crewOrderDay(order) {
  const o = order || {};
  const raw = o.delivery_at_utc || o.event_start_at;
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) return d.toISOString().slice(0, 10);
  return crewDayInZone(ms, 'America/New_York');
}
// The drop window: the first two clock times of delivery_window
// ("Arrival 10:00 AM - 06:00 PM" -> 10:00 to 18:00). Fewer than two: none.
export function crewSupplyWindow(text) {
  const s = String(text == null ? '' : text);
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\b\.?|\b(\d{1,2}):(\d{2})\b/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) && out.length < 2) {
    let h, mm;
    if (m[3]) {
      h = Number(m[1]); mm = Number(m[2] || 0);
      if (h < 1 || h > 12 || mm > 59) continue;
      const pm = m[3].toLowerCase() === 'p';
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    } else {
      h = Number(m[4]); mm = Number(m[5]);
      if (h > 23 || mm > 59) continue;
    }
    out.push(h * 60 + mm);
  }
  return out.length === 2 ? { start: out[0], end: out[1] } : null;
}
function cutWords(value) {
  const key = trimText(value).toLowerCase();
  return key && Object.prototype.hasOwnProperty.call(CUT_WORDS, key) ? CUT_WORDS[key] : null;
}
function invoiceOf(o) {
  return o && o.invoice_fulfillment && typeof o.invoice_fulfillment === 'object' ? o.invoice_fulfillment : null;
}
function requestOf(o) {
  return o && o.delivery_request && typeof o.delivery_request === 'object' ? o.delivery_request : null;
}
function orderCut(o) {
  if (!o) return null;
  return cutWords(o.crack_type) || cutWords((invoiceOf(o) || {}).cracking);
}
function isCancelled(o) {
  return String((o && o.stage) || '') === 'cancelled' || !!(o && o.cancelled_at != null && trimText(o.cancelled_at));
}
// The Navigate rule: delivery_notes, else venue (blank after the whitespace
// rule counts as missing), cleaned by crewCleanAddress.
export function crewNavAddress(order) {
  const o = order || {};
  return crewCleanAddress(navSpaces(o.delivery_notes) || navSpaces(o.venue));
}
// Why the Navigate address is not on the row: 'long' when the text is there
// but longer than 200 characters, else 'none'.
function navMissingReason(order) {
  const o = order || {};
  const raw = navSpaces(o.delivery_notes) || navSpaces(o.venue);
  return raw && raw.length > CREW_ADDRESS_MAX ? 'long' : 'none';
}
const DEFAULT_CARD = { stage: 'auto', prep: 'auto', branding: 'auto', crew_start: null, people_min: null, extras: [], on_site: [] };
// R3 branding: card yes or no wins; auto brands when the stamp is ordered
// or received or a logo is on file; stamp not_needed is plain with no
// question; anything else is amber branding_unknown.
export function crewBrandingOf(order, card) {
  const o = order || {};
  const c = card || DEFAULT_CARD;
  if (c.branding === 'yes') return { branded: true, unknown: false };
  if (c.branding === 'no') return { branded: false, unknown: false };
  const stamp = String(o.stamp_status || '').toLowerCase();
  const a = o.logo_asset;
  const logo = o.logo_received === true || (a != null && (Array.isArray(a) ? a.length > 0 : typeof a === 'object' ? Object.keys(a).length > 0 : !!trimText(a)));
  if (stamp === 'ordered' || stamp === 'received' || logo) return { branded: true, unknown: false };
  return { branded: false, unknown: stamp !== 'not_needed' };
}
// R8 arrival: the confirmed delivery_request window, else the invoice
// window, read by the departure plan's own parser on the job day. Kind
// assumed (no AM or PM) is never used. A pending coordinator time that is
// earlier wins, like the alarm; it only counts when a time is on file.
export function crewArrivalOf(order, day, tz, proposal, lib) {
  const o = order || {};
  const dr = requestOf(o), inv = invoiceOf(o);
  let windowText = '', fromInvoice = false;
  if (dr && dr.status === 'confirmed' && trimText(dr.window)) windowText = trimText(dr.window);
  else if (inv && trimText(inv.delivery_window)) { windowText = trimText(inv.delivery_window); fromInvoice = true; }
  const out = { windowText, fromInvoice, needsAmpm: false, ms: null, min: null, proposalMs: null, proposalMin: null };
  if (windowText && lib && lib.parseArrivalTime) {
    const p = lib.parseArrivalTime(windowText, day, tz);
    if (p && p.ok && p.kind === 'assumed') out.needsAmpm = true;
    else if (p && p.ok) { out.ms = Date.parse(p.arriveAtUtc); out.min = p.hh * 60 + p.mm; }
  }
  if (proposal && out.ms != null && isFiniteNum(proposal.ms)) {
    out.proposalMs = proposal.ms;
    out.proposalMin = crewMinInZone(proposal.ms, tz);
    if (proposal.ms < out.ms) { out.ms = proposal.ms; out.min = out.proposalMin; }
  }
  return out;
}
// A person's first name for words: helpers by their one name, roster
// rows by the 070 first name; never the "(helper)" suffix.
function personFirstName(p) {
  if (!p) return null;
  return trimText(p.kind === 'helper' ? (p.helper_name || p.name) : p.name).replace(/\s*\(helper\)\s*$/i, '').split(' ')[0] || null;
}

// ---------------------------------------------------------------- gap words
// 073 takes gap words of 1 to 300 characters that pass the word check and
// refuses the WHOLE day otherwise, so a long label is cut and a word that
// fails the check falls back to a plain sentence (Sidd still sees the code).
export const CREW_GAP_WORDS_MAX = 300;
function gapWords(words) {
  let s = String(words == null ? '' : words).replace(NAV_WS, ' ').trim();
  if (!s || !crewTextOk(s)) return 'Check this row.';
  if (s.length > CREW_GAP_WORDS_MAX) s = s.slice(0, CREW_GAP_WORDS_MAX - 4).trimEnd() + ' ...';
  return s;
}
function gapEntry(code, taskKey, words) {
  const g = CREW_GAPS[code] || ['red', true];
  return { code, level: g[0], owner_only: g[1], task_key: taskKey == null ? null : taskKey, words: gapWords(words) };
}
// Stored order: red first, then task_key (null first, byte order), then code.
export function crewSortGaps(list) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...list].sort((a, b) => {
    const la = a.level === 'red' ? 0 : 1, lb = b.level === 'red' ? 0 : 1;
    if (la !== lb) return la - lb;
    if (a.task_key !== b.task_key) {
      if (a.task_key == null) return -1;
      if (b.task_key == null) return 1;
      return cmp(a.task_key, b.task_key);
    }
    return cmp(a.code, b.code);
  });
}
function ruleWords(key, value) {
  if (key === 'boxes_per_car') return value + ' boxes per car';
  if (key === 'two_people_over') return '2 people above ' + value + ' boxes';
  if (key === 'receive_people') return value === 0 ? 'boxes can wait for the crew' : (value === 1 ? '1 person checks in a drop' : value + ' people check in a drop');
  return key.replace(/_/g, ' ');
}

// ---------------------------------------------------------------- the words (one place)
// The arrival a deliver row carries, read from its fields exactly as 073's
// hc_crew_words reads it (contract words.deliver): busy_to minus the unload
// minutes, when the row has a leave_by or has no busy_from (a robot deliver
// row with a known arrival always keeps busy_to = arrival + unload, and a
// row with no start keeps no busy_from, so it never clashes). A row with a
// crew start and no drive time yet has neither, so it shows its start only.
export function crewTaskArrivalMin(task, unloadMin) {
  const t = task || {};
  if (t.kind !== 'deliver') return null;
  const busyTo = crewHmToMin(t.busy_to), busyFrom = crewHmToMin(t.busy_from), leave = crewHmToMin(t.leave_by);
  if (leave == null && !(busyFrom == null && busyTo != null)) return null;
  const unload = unloadMin != null && Number.isFinite(Number(unloadMin)) ? Math.round(Number(unloadMin)) : 30;
  if (busyTo != null) return busyTo - unload;
  if (leave != null && t.drive_min != null && Number.isFinite(Number(t.drive_min))) return leave + Number(t.drive_min) + 60;
  return null;
}
// Builds a task's crew sentence from structured fields only. ctx:
// { market, siteLabel(id), personName(id), client(order_id), unloadMin,
//   jobDayWords(task), prepFacts(task) {cut, branded}, extraLabel(task),
//   held }. Every result passes crewTextOk or the caller gets the held
// constant's plain fallback.
function carsText(cars, people, ctx) {
  const n = plural(cars, 'car', 'cars');
  const list = (people || []).map((p) => {
    const name = ctx.personName(p.person_id) || 'crew';
    return p.car ? name + ' car ' + p.car : name;
  });
  return list.length ? n + ' (' + list.join(', ') + ')' : n;
}
export function crewWords(task, ctx) {
  const t = task || {};
  if (ctx.held) return CREW_HOLD_WORDS;
  const market = ctx.market;
  const clock = (min) => crewClock(min, market);
  const startMin = crewHmToMin(t.start);
  const endMin = crewHmToMin(t.end);
  const from = t.from_site ? ctx.siteLabel(t.from_site) : null;
  const to = t.to_site ? ctx.siteLabel(t.to_site) : null;
  const venue = crewVenueLabel(t.to_address) || 'the venue';
  const boxesText = (n) => plural(n, 'box', 'boxes');
  let s;
  if (t.kind === 'receive') {
    const head = (from ? from + ': check in ' : 'Check in ') + boxesText(Number(t.boxes) || 0) + ' when they arrive';
    s = startMin != null && endMin != null ? head + ' (' + clock(startMin) + ' to ' + clock(endMin) + ').' : head + '.';
  } else if (t.kind === 'move') {
    const lead = t.when === 'any_time' ? 'After prep'
      : (startMin != null && endMin != null ? 'After the boxes arrive (' + clock(startMin) + ' to ' + clock(endMin) + ')' : 'After the boxes arrive');
    s = lead + ': take ' + boxesText(Number(t.boxes) || 0) + ' from ' + (from || 'the base') + ' to ' + (to || 'cold storage') + '. ' + carsText(t.cars || 0, t.people, ctx) + '.';
  } else if (t.kind === 'prep') {
    const f = ctx.prepFacts ? ctx.prepFacts(t) : {};
    let what = 'prep ' + ctx.client(t.order_id) + ' for ' + (ctx.jobDayWords ? ctx.jobDayWords(t) : '');
    if (t.coconuts != null) what += ', ' + plural(Number(t.coconuts), 'coconut', 'coconuts');
    if (f.cut) what += ', ' + f.cut + ' cut';
    if (f.branded) what += ', branded';
    s = from ? 'Any time at ' + from + ': ' + what + '.' : 'Any time: ' + what + '. Place: Sidd will confirm.';
  } else if (t.kind === 'deliver') {
    const arrival = crewTaskArrivalMin(t, ctx.unloadMin);
    const prefix = [startMin != null ? clock(startMin) : null, from].filter(Boolean).join(' ');
    const what = t.boxes != null ? 'pick up ' + boxesText(Number(t.boxes)) : 'pick up the boxes';
    s = (prefix ? prefix + ': ' + what : capFirst(what)) + ', ' + carsText(t.cars || 0, t.people, ctx) + '.';
    s += t.to_address ? ' Deliver to ' + ctx.client(t.order_id) + ' at ' + t.to_address + '.' : ' Deliver to ' + ctx.client(t.order_id) + '. Address: Sidd will confirm.';
    if (arrival != null) s += ' Arrive by ' + clock(arrival) + '.';
    if (startMin == null && arrival == null) s += ' Time: Sidd will confirm.';
  } else if (t.kind === 'cart_drop') {
    const label = lowFirst(ctx.extraLabel ? ctx.extraLabel(t) : 'cart') || 'cart';
    const home = from ? ' (from ' + from + ')' : '';
    s = startMin != null
      ? 'Be at ' + venue + ' by ' + clock(startMin) + ' with the ' + label + home + '. ' + carsText(t.cars || 0, t.people, ctx) + '.'
      : 'Be at ' + venue + ' with the ' + label + home + '. ' + carsText(t.cars || 0, t.people, ctx) + '. Time: Sidd will confirm.';
  } else if (t.kind === 'cart_pickup') {
    const label = lowFirst(ctx.extraLabel ? ctx.extraLabel(t) : 'cart') || 'cart';
    const back = to ? ' and bring it back to ' + to : '';
    const when = startMin != null ? (endMin != null ? clock(startMin) + ' to ' + clock(endMin) : clock(startMin)) + ' at ' + venue : 'At ' + venue;
    s = when + ': pick up the ' + label + back + '. ' + carsText(t.cars || 0, t.people, ctx) + '.' + (startMin == null ? ' Time: Sidd will confirm.' : '');
  } else if (t.kind === 'on_site') {
    const when = startMin != null ? (endMin != null ? clock(startMin) + ' to ' + clock(endMin) : clock(startMin)) + ' at ' + venue : 'At ' + venue;
    s = when + ': stay with ' + ctx.client(t.order_id) + ' (on site).' + (startMin == null ? ' Time: Sidd will confirm.' : '');
  } else {
    const label = trimText(t.label).replace(/[.!?]+$/, '') || 'Task';
    s = startMin != null ? clock(startMin) + ': ' + label + '.' : label + '.';
  }
  return crewTextOk(s) ? s : 'Sidd will send the details for this task.';
}

// The same words for a task built outside a planner run (a stored row, an
// owner row, the test vectors' words_from). facts: { now, sites, people,
// orders, jobs (job cards), rules, held }. Like 073's hc_crew_words, it
// reads only the task's own fields (and the orders' labels).
export function crewWordsFor(task, market, facts, lib) {
  const f = facts || {};
  const m = crewMarketKey(market);
  const zone = (k) => (lib && lib.marketZone ? lib.marketZone(k) : 'America/New_York');
  const sitesById = new Map((f.sites || []).filter((s) => s && s.id).map((s) => [idOf(s.id), s]));
  const peopleById = new Map((f.people || []).filter((p) => p && p.person_id).map((p) => [idOf(p.person_id), p]));
  const ordersById = new Map((f.orders || []).filter((o) => o && o.id).map((o) => [idOf(o.id), o]));
  const cards = new Map((f.jobs || []).filter((j) => j && j.order_id).map((j) => [idOf(j.order_id), j]));
  const thisYear = crewDayInZone(Date.parse(f.now), zone('ny')).slice(0, 4);
  const unloadRule = (f.rules || []).find((r) => r && crewMarketKey(r.market) === m && r.key === 'unload_minutes');
  const headOf = (o) => (o && idOf(o.parent_order_id) ? ordersById.get(idOf(o.parent_order_id)) || null : null);
  const ctx = {
    market: m,
    held: !!f.held,
    siteLabel: (id) => { const s = sitesById.get(idOf(id)); return s ? trimText(s.label) : null; },
    personName: (id) => personFirstName(peopleById.get(idOf(id))),
    client: (id) => { const o = ordersById.get(idOf(id)); return o ? crewClientLabel(o) : 'the client'; },
    unloadMin: unloadRule && Number.isFinite(Number(unloadRule.value)) ? Number(unloadRule.value) : 30,
    jobDayWords: (t) => { const o = ordersById.get(idOf(t.order_id)); return o ? crewDayWords(crewOrderDay(o), thisYear) : ''; },
    prepFacts: (t) => {
      const o = ordersById.get(idOf(t.order_id));
      if (!o) return {};
      const head = headOf(o);
      const card = { ...DEFAULT_CARD, ...(cards.get(idOf(head ? head.id : o.id)) || {}) };
      return { cut: orderCut(o) || orderCut(head), branded: crewBrandingOf(o, card).branded };
    },
    extraLabel: (t) => {
      const parts = String(t.key || '').split(':');
      const card = cards.get(idOf(parts[1]));
      const e = card && Array.isArray(card.extras) ? card.extras.find((x) => x && String(x.key) === parts[2]) : null;
      return e ? (trimText(e.label) || 'cart') : 'cart';
    },
  };
  return crewWords(task, ctx);
}

// ---------------------------------------------------------------- held (read time)
// Why an approved row is on hold now: 'cancelled' (its order or the job's
// day 1 is cancelled), 'moved' (a deliver row whose job day is no longer
// its plan day), 'address' (a deliver row whose live Navigate address
// differs from its to_address), else null. Fulfilled or complete is done,
// not held. A count change alone is not held. ordersById must hold the
// order and its day 1; a row whose order is unknown reads as held.
export function crewHeldReason(task, planDay, ordersById) {
  const t = task || {};
  const oid = idOf(t.order_id);
  if (!oid) return null;
  const o = ordersById.get(oid);
  if (!o) return 'cancelled';
  const pid = idOf(o.parent_order_id);
  const head = pid ? ordersById.get(pid) : null;
  if (DONE_STAGES.includes(String(o.stage || ''))) return null;
  if (isCancelled(o) || (head && isCancelled(head))) return 'cancelled';
  if (t.kind === 'deliver') {
    if (crewOrderDay(o) !== planDay) return 'moved';
    if ((crewNavAddress(o) || null) !== (t.to_address || null)) return 'address';
  }
  return null;
}

// ---------------------------------------------------------------- the planner
// input: { now, settings, rules, sites, people, jobs, days, time_off,
//   orders, attachments, supply, findings, proposals, departures, routes }
// (shapes in reply-shapes-073.md 4.1 plus the read rows), lib: the
// departure plan's helpers. Returns { days: [...], routeNeeds: [...] }.
export function planCrew(input, lib) {
  const inp = input || {};
  const nowMs = Date.parse(inp.now);
  const settings = inp.settings || {};
  const never = new Set((settings.never_schedule || []).map(idOf).filter(Boolean));
  const zoneOf = (m) => (lib && lib.marketZone ? lib.marketZone(m) : 'America/New_York');
  const todayOf = (m) => crewDayInZone(nowMs, zoneOf(m));
  const thisYear = todayOf('ny').slice(0, 4);

  // -- normalized reads
  const rules = new Map();
  for (const r of inp.rules || []) {
    if (!r) continue;
    const m = crewMarketKey(r.market);
    if (!rules.has(m)) rules.set(m, new Map());
    rules.get(m).set(String(r.key), { value: Number(r.value), confirmed: r.confirmed === true, version: r.version });
  }
  const ruleOf = (m, k) => (rules.get(m) || new Map()).get(k) || null;
  const ruleVal = (m, k) => { const r = ruleOf(m, k); return r && Number.isFinite(r.value) ? r.value : RULE_SEED[k]; };
  const sites = (inp.sites || []).filter((s) => s && s.id && s.active !== false);
  const sitesById = new Map((inp.sites || []).filter((s) => s && s.id).map((s) => [idOf(s.id), s]));
  const siteLabel = (id) => { const s = sitesById.get(idOf(id)); return s ? trimText(s.label) : null; };
  const coordsOk = (s) => !!s && s.geo_status === 'confirmed' && isFiniteNum(s.lat) && isFiniteNum(s.lng);
  const baseOf = (m) => sites.find((s) => crewMarketKey(s.market) === m && s.kind === 'base' && coordsOk(s)) || null;
  const coldOf = (m) => sites.find((s) => crewMarketKey(s.market) === m && s.kind === 'cold_storage') || null;
  const planned = (m) => ruleVal(m, 'planned') === 1 && !!baseOf(m);
  const people = (inp.people || []).filter((p) => p && p.person_id);
  const peopleById = new Map(people.map((p) => [idOf(p.person_id), p]));
  const personName = (id) => personFirstName(peopleById.get(idOf(id)));
  const cards = new Map((inp.jobs || []).filter((j) => j && j.order_id).map((j) => [idOf(j.order_id), j]));
  const cardOf = (id) => ({ ...DEFAULT_CARD, ...(cards.get(idOf(id)) || {}) });
  const storedDays = new Map((inp.days || []).filter((d) => d && d.day).map((d) => [crewMarketKey(d.market) + '|' + String(d.day).slice(0, 10), d]));
  const timeOff = (inp.time_off || []).filter((t) => t && (t.status === 'approved' || t.status === 'pending'));
  const offOn = (workerId, day, status) => !!workerId && timeOff.some((t) => idOf(t.worker_id) === idOf(workerId) && t.status === status
    && String(t.start_day).slice(0, 10) <= day && String(t.end_day || t.start_day).slice(0, 10) >= day);
  const orders = [];
  const ordersById = new Map();
  for (const o of inp.orders || []) {
    const id = idOf(o && o.id);
    if (!id || ordersById.has(id)) continue;
    ordersById.set(id, o);
    orders.push(o);
  }
  // 072 calendar findings: keyed by an order, or only by day 1's invoice
  // ('<code>:qbo:<id>', order_id null). An invoice-keyed one belongs to the
  // day 1 (no parent) whose external_invoice_id is that invoice, as the
  // reconfirmation scan maps it, so the plan never looks cleaner than the
  // calendar.
  const headsByQbo = new Map();
  for (const o of orders) {
    const q = trimText(o.external_invoice_id);
    if (!q || idOf(o.parent_order_id)) continue;
    if (!headsByQbo.has(q)) headsByQbo.set(q, []);
    headsByQbo.get(q).push(idOf(o.id));
  }
  const findingsByOrder = new Map();
  const addFinding = (id, code) => {
    if (!findingsByOrder.has(id)) findingsByOrder.set(id, []);
    if (!findingsByOrder.get(id).includes(code)) findingsByOrder.get(id).push(code);
  };
  for (const f of inp.findings || []) {
    if (!f || !(f.status === 'open' || f.status === 'still_on')) continue;
    const id = idOf(f.order_id);
    if (id) { addFinding(id, String(f.code)); continue; }
    for (const head of headsByQbo.get(trimText(f.qbo_id)) || []) addFinding(head, String(f.code));
  }
  const addonsByHead = new Map();
  for (const a of inp.attachments || []) {
    if (!a || a.voided === true || (a.detached_at != null && trimText(a.detached_at))) continue;
    if (a.role && a.role !== 'addon') continue;
    if (a.total_cents == null || a.open_cents == null) continue; // read means Jarvis read its totals
    const id = idOf(a.head_order_id);
    if (!id) continue;
    if (!addonsByHead.has(id)) addonsByHead.set(id, []);
    addonsByHead.get(id).push(a);
  }
  const proposalsByOrder = new Map();
  for (const p of inp.proposals || []) {
    if (!p || (p.status && p.status !== 'pending')) continue;
    const id = idOf(p.order_id);
    const ms = Date.parse(p.proposed_arrive_at);
    if (!id || !Number.isFinite(ms)) continue;
    const cur = proposalsByOrder.get(id);
    if (!cur || ms < cur.ms) proposalsByOrder.set(id, { ms });
  }
  const departures = (inp.departures || []).filter(Boolean);
  // Route cache: "from|to" -> {drive_seconds, has_ferry, fail_runs, at,
  // dest_lat, dest_lng}. to is a site id or an address.
  const routes = new Map();
  for (const r of inp.routes || []) {
    if (!r || !r.from_site) continue;
    const to = r.to_site ? idOf(r.to_site) : trimText(r.to_address);
    if (!to) continue;
    routes.set(idOf(r.from_site) + '|' + to, r);
  }
  const routeNeeds = new Map();
  const needRoute = (fromId, toSite, toAddress, priority, day) => {
    const key = idOf(fromId) + '|' + (toSite ? idOf(toSite) : toAddress);
    const cur = routeNeeds.get(key);
    if (!cur || priority < cur.priority || (priority === cur.priority && day < cur.day)) {
      routeNeeds.set(key, { key, from_site: idOf(fromId), to_site: toSite ? idOf(toSite) : null, to_address: toSite ? null : toAddress, priority, day });
    }
  };
  // An address a router may be given: departureDestination's own test (a
  // comma and a state, a zip or a known town). "Test Pier" never is, so the
  // robot never times a trip from a geocoder's guess (no route, a gap).
  const addressUsable = (address) => {
    if (!trimText(address)) return false;
    if (!lib || typeof lib.departureDestination !== 'function') return true;
    const d = lib.departureDestination({ delivery_notes: address });
    return !!(d && d.usable);
  };
  // A usable drive time: {seconds, ferry, at} | {failed, tries, at} |
  // {pending, tries, at} | null.
  const driveFor = (fromId, toSite, toAddress) => {
    if (!fromId) return null;
    const site = sitesById.get(idOf(fromId));
    if (!coordsOk(site)) return null; // an unconfirmed place is never routed from
    if (!toSite && !addressUsable(toAddress)) return null;
    const to = toSite ? idOf(toSite) : trimText(toAddress);
    if (!to) return null;
    const r = routes.get(idOf(fromId) + '|' + to);
    if (!r) return null;
    if (isFiniteNum(r.drive_seconds) && r.drive_seconds >= 0) return { seconds: r.drive_seconds, ferry: r.has_ferry === true, at: r.at || null };
    if (Number(r.fail_runs) >= CREW_ROUTE_FAIL_RUNS) return { failed: true, tries: Number(r.fail_runs), at: r.at || null };
    return Number(r.fail_runs) > 0 ? { pending: true, tries: Number(r.fail_runs), at: r.at || null } : null;
  };
  // drive_min is the drive in whole minutes ROUNDED UP: leaveByMs floors to
  // the minute, so arrival - buffer - ceil(drive) is the alarm's own
  // leave-by, and a stored drive_min gives back exactly the same leave-by.
  const driveMinutes = (seconds) => Math.ceil(seconds / 60);
  // The robot row stored for (market, day, key): an approved or changed
  // day's approved row, or a draft day's own row when the database sends
  // the day whole. Its drive time is reused while its ends (from_site,
  // to_site, to_address) are the same: on an approved day ALWAYS (the
  // approved plan never drifts with traffic; the departure plan's alarm
  // still follows live traffic), on a draft day while a fresh departure
  // drive is within CREW_DRIFT_MINUTES of it (so a draft is not rewritten,
  // and Sidd's approve tap made stale, every hour).
  const storedRobotRow = (m, day, key) => {
    const sd = storedDays.get(m + '|' + day);
    if (!sd) return null;
    const approved = sd.status === 'approved' || sd.status === 'changed';
    const list = approved ? (sd.approved_tasks || []) : (Array.isArray(sd.tasks) ? sd.tasks : []);
    const t = list.find((x) => x && x.source !== 'owner' && String(x.key) === key);
    return t ? { t, approved } : null;
  };
  const keptDrive = (m, day, key, fromSite, toSite, toAddress) => {
    const s = storedRobotRow(m, day, key);
    if (!s) return null;
    const t = s.t;
    if (idOf(t.from_site) !== idOf(fromSite) || idOf(t.to_site) !== idOf(toSite) || (t.to_address || null) !== (toAddress || null)) return null;
    const dm = Number(t.drive_min);
    if (t.drive_min == null || !Number.isInteger(dm) || dm < 0) return null;
    return { approved: s.approved, minutes: dm, drive: { seconds: dm * 60, ferry: /Ferry on the route\./.test(String(t.why || '')), at: t.route_at || null } };
  };

  // -- R1 and R2: the job days
  const jobs = [];
  const unplannedNotes = [];
  for (const o of orders) {
    const day = crewOrderDay(o);
    if (!day) continue;
    const market = crewMarketKey(o.market);
    // Only the four crew markets have plan days (073 refuses any other
    // p_market, so a market like 'other' would fail its put every hour).
    if (!Object.prototype.hasOwnProperty.call(CREW_MARKET_WORDS, market)) continue;
    const today = todayOf(market);
    if (day < crewDayAdd(today, -1) || day > crewDayAdd(today, 8)) continue;
    if (isCancelled(o)) continue;
    const pid = idOf(o.parent_order_id);
    if (!pid && idOf(o.job_day_origin)) continue; // a day of a removed job
    const headOrder = pid ? (ordersById.get(pid) || null) : o;
    if (pid && headOrder && isCancelled(headOrder)) continue;
    const stage = pid && headOrder && headOrder !== o && !idOf(o.external_invoice_id) ? String(headOrder.stage || '') : String(o.stage || '');
    if (!CREW_CONFIRMED_STAGES.includes(stage)) continue;
    const id = idOf(o.id);
    const job = { id, o, headId: pid || id, headOrder: headOrder || o, day, market };
    if (!planned(market)) { unplannedNotes.push(job); continue; }
    jobs.push(job);
  }
  jobs.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // -- the day buckets
  const days = new Map();
  const dayOf = (market, day) => {
    const key = market + '|' + day;
    if (!days.has(key)) days.set(key, { market, day, rows: [], dayGaps: [], jobIds: new Set() });
    return days.get(key);
  };
  const supplyWindowOk = (m, d) => d >= crewDayAdd(todayOf(m), -3) && d <= crewDayAdd(todayOf(m), 8);
  const supplyMarket = (r) => (r && r.market ? crewMarketKey(r.market) : 'ny');
  const counting = (r, m) => {
    if (!r || supplyMarket(r) !== m || !posInt(r.boxes)) return false;
    if (r.status === 'confirmed') return !!r.delivery_date && supplyWindowOk(m, String(r.delivery_date).slice(0, 10)) && (m !== 'ny' || r.ship_to_garage === true);
    if (r.status === 'claimed') return !!r.prep_day && supplyWindowOk(m, String(r.prep_day).slice(0, 10));
    return false;
  };
  const supply = (inp.supply || []).filter(Boolean);

  // Unplanned markets: one owner-only note per job day, no rows.
  for (const j of unplannedNotes) {
    const anySupply = supply.some((r) => counting(r, j.market));
    const n = posInt(j.o.coconuts_qty);
    const words = crewClientLabel(j.o) + (n ? ', ' + plural(n, 'coconut', 'coconuts') : ', count unknown') + ': not planned ('
      + (CREW_MARKET_WORDS[j.market] || j.market.toUpperCase()) + ' is off).' + (anySupply ? '' : ' No coconut supply on record.');
    const d = dayOf(j.market, j.day);
    d.jobIds.add(j.id);
    d.dayGaps.push(gapEntry('market_not_planned', null, words));
  }

  // -- per job facts (R2 to R4, R9 address)
  for (const j of jobs) {
    const o = j.o;
    j.card = cardOf(j.headId);
    j.client = crewClientLabel(o);
    j.toAddress = crewNavAddress(o);
    j.addrUsable = addressUsable(j.toAddress);
    j.coconuts = posInt(o.coconuts_qty);
    j.boxes = j.coconuts ? Math.ceil(j.coconuts / 9) : null;
    j.hasPrep = j.card.prep !== 'skip';
    j.useDay = j.hasPrep ? crewDayAdd(j.day, -1) : j.day;
    j.P = crewDayAdd(j.day, -1);
    j.cut = orderCut(o) || (j.headOrder && j.headOrder !== o ? orderCut(j.headOrder) : null);
    j.base = baseOf(j.market);
    j.cold = coldOf(j.market);
    j.deliverGaps = [];
    j.prepGaps = [];
    // R9: out of the drive area by state, or the route ends too far away.
    j.ooa = null;
    const state = crewStateOf(j.toAddress);
    const area = DRIVE_AREA[j.market];
    if (state && area && !area.includes(state)) j.ooa = { words: j.client + ': address is in ' + state + '. Shipped, or another crew?' };
    if (!j.ooa && j.toAddress && j.base && lib && lib.routeSanity) {
      const r = routes.get(idOf(j.base.id) + '|' + j.toAddress);
      if (r && isFiniteNum(r.dest_lat) && isFiniteNum(r.dest_lng)) {
        const sane = lib.routeSanity({ meters: r.meters, driveSeconds: r.drive_seconds, endLat: r.dest_lat, endLng: r.dest_lng,
          originLat: j.base.lat, originLng: j.base.lng, marketCenter: { lat: j.base.lat, lng: j.base.lng } });
        if (sane && sane.reason === 'too_far') j.ooa = { words: j.client + ': address is more than 250 km from ' + trimText(j.base.label) + '. Shipped, or another crew?' };
      }
    }
    // Provisional R13 key for the supply split (the start is not known yet).
    const dr = requestOf(o);
    const inv = invoiceOf(o);
    let provMin = crewHmToMin(j.card.crew_start);
    if (provMin == null && lib && lib.parseArrivalTime) {
      const text = dr && dr.status === 'confirmed' && trimText(dr.window) ? trimText(dr.window) : (inv && trimText(inv.delivery_window) ? trimText(inv.delivery_window) : '');
      if (text) {
        const p = lib.parseArrivalTime(text, j.day, zoneOf(j.market));
        if (p && p.ok && p.kind !== 'assumed') provMin = p.hh * 60 + p.mm;
      }
    }
    j.provMin = provMin;
    j.shares = [];
  }

  // -- R5 supply, per planned market
  const groupsByMarket = new Map();
  for (const j of jobs) {
    if (!groupsByMarket.has(j.market)) groupsByMarket.set(j.market, new Map());
    const g = groupsByMarket.get(j.market);
    if (!g.has(j.P)) g.set(j.P, { P: j.P, jobs: [] });
    g.get(j.P).jobs.push(j);
  }
  const dropsByMarket = new Map();
  const plannedMarkets = [...new Set([...jobs.map((j) => j.market), ...supply.filter((r) => planned(supplyMarket(r))).map(supplyMarket)])].sort();
  for (const m of plannedMarkets) {
    const drops = supply.filter((r) => r.status === 'confirmed' && counting(r, m))
      .sort((a, b) => (String(a.delivery_date) < String(b.delivery_date) ? -1 : String(a.delivery_date) > String(b.delivery_date) ? 1 : Number(a.id) - Number(b.id)));
    const claims = supply.filter((r) => r.status === 'claimed' && counting(r, m));
    dropsByMarket.set(m, drops);
    const remaining = new Map(drops.map((d) => [d.id, Number(d.boxes)]));
    const groups = [...((groupsByMarket.get(m) || new Map()).values())].sort((a, b) => (a.P < b.P ? -1 : a.P > b.P ? 1 : 0));
    for (const g of groups) {
      const known = g.jobs.reduce((s, j) => s + (j.coconuts || 0), 0);
      const unknown = g.jobs.filter((j) => !j.coconuts).length;
      const need = Math.ceil(known / 9) + unknown;
      const latestUse = g.jobs.reduce((mx, j) => (j.useDay > mx ? j.useDay : mx), '');
      let credit = 0;
      const taken = [];
      for (const d of drops) {
        if (credit >= need) break;
        if (String(d.delivery_date).slice(0, 10) > latestUse) continue;
        const left = remaining.get(d.id) || 0;
        if (left <= 0) continue;
        const t = Math.min(left, need - credit);
        credit += t;
        remaining.set(d.id, left - t);
        taken.push({ drop: d, boxes: t });
      }
      const weee = claims.filter((r) => String(r.prep_day).slice(0, 10) === g.P && r.supplier === 'weee').reduce((s, r) => s + Number(r.boxes), 0);
      const other = claims.filter((r) => String(r.prep_day).slice(0, 10) === g.P && r.supplier !== 'weee').reduce((s, r) => s + Number(r.boxes), 0);
      const have = Math.max(credit, weee) + other;
      const short = need - have > 0 ? { have, need } : null;
      const lean = weee > credit || other > 0 ? weee + other : 0;
      // Split the taken drops to jobs in R13 order of their deliver rows.
      const ordered = [...g.jobs].sort((a, b) => {
        if (a.provMin !== b.provMin) {
          if (a.provMin == null) return 1;
          if (b.provMin == null) return -1;
          return a.provMin - b.provMin;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const parts = taken.map((t) => ({ ...t }));
      for (const j of ordered) {
        let want = j.boxes == null ? 1 : j.boxes;
        while (want > 0 && parts.length) {
          const p = parts[0];
          const t = Math.min(want, p.boxes);
          j.shares.push({ drop: p.drop, boxes: t });
          p.boxes -= t; want -= t;
          if (p.boxes <= 0) parts.shift();
        }
      }
      for (const j of g.jobs) {
        j.short = short;
        j.claimLean = lean;
      }
    }
  }

  // -- R6 staging and R7 prep place, per job
  for (const j of jobs) {
    const base = j.base;
    const cold = j.cold;
    const baseHold = base && base.hold_nights != null && Number.isFinite(Number(base.hold_nights)) ? Number(base.hold_nights) : null;
    const waits = j.shares.map((s) => crewDayDiff(String(s.drop.delivery_date).slice(0, 10), j.useDay)).filter((w) => w != null);
    const maxWait = waits.length ? Math.max(0, ...waits) : 0;
    const tooLongAtBase = baseHold != null && waits.some((w) => w > baseHold);
    const nightsWord = (n) => plural(n, 'night', 'nights');
    let staged = j.card.stage === 'always' || (j.card.stage === 'auto' && tooLongAtBase);
    if (j.card.stage === 'auto' && cold && maxWait >= 1 && base && base.hold_confirmed !== true) {
      j.deliverGaps.push(['hold_unconfirmed', 'Can boxes wait ' + nightsWord(maxWait) + ' at ' + trimText(base.label) + '?']);
    }
    if (j.card.stage === 'never' && tooLongAtBase) {
      j.deliverGaps.push(['hold_too_long', 'Boxes would wait ' + nightsWord(maxWait) + ' at ' + trimText(base.label) + '.']);
    }
    const coldUsable = !!cold && !!trimText(cold.address);
    if (staged && !coldUsable) {
      j.deliverGaps.push(['no_staging', 'Boxes wait ' + nightsWord(maxWait) + ' and there is no cold storage with an address.']);
      staged = false;
    }
    j.stagedCold = staged;
    j.fromSite = staged ? idOf(cold.id) : (base ? idOf(base.id) : null);
    j.prepSite = null;
    if (staged) {
      const coldHold = cold.hold_nights != null && Number.isFinite(Number(cold.hold_nights)) ? Number(cold.hold_nights) : null;
      if (j.card.prep === 'base' && j.hasPrep) {
        // The move waits until after prep, so the boxes wait at the base.
        if (tooLongAtBase) j.deliverGaps.push(['hold_too_long', 'Boxes would wait ' + nightsWord(maxWait) + ' at ' + trimText(base.label) + '.']);
        const coldWait = crewDayDiff(j.useDay, j.day) || 0;
        if (coldHold == null) j.deliverGaps.push(['hold_unknown', 'How long can boxes wait at ' + trimText(cold.label) + '?']);
        else if (coldWait > coldHold) j.deliverGaps.push(['hold_unknown', 'Boxes would wait ' + nightsWord(coldWait) + ' at ' + trimText(cold.label) + '; it holds ' + coldHold + '.']);
      } else if (coldHold == null) {
        j.deliverGaps.push(['hold_unknown', 'How long can boxes wait at ' + trimText(cold.label) + '?']);
      } else if (waits.some((w) => w > coldHold)) {
        j.deliverGaps.push(['hold_unknown', 'Boxes would wait ' + nightsWord(maxWait) + ' at ' + trimText(cold.label) + '; it holds ' + coldHold + '.']);
      }
      if (j.claimLean) {
        j.deliverGaps.push(['claim_no_drop_day', 'You ordered ' + plural(j.claimLean, 'box', 'boxes') + '; the drop day is not known, so there is no move row.']);
      }
    }
    if (j.hasPrep) {
      if (!staged) j.prepSite = base ? idOf(base.id) : null;
      else if (j.card.prep === 'staging') j.prepSite = idOf(cold.id);
      else if (j.card.prep === 'base') j.prepSite = idOf(base.id);
      else if (cold.can_prep === 'yes') j.prepSite = idOf(cold.id);
      else j.prepGaps.push(['prep_place_unknown', 'Boxes are in ' + trimText(cold.label) + '; where do we prep?']);
    }
  }

  // -- rows (R8 times, R9 address, R10 cars)
  const newRow = (o) => ({
    key: o.key, source: 'robot', kind: o.kind, order_id: o.order_id || null, supply_id: o.supply_id == null ? null : o.supply_id,
    from_site: o.from_site || null, to_site: o.to_site || null, to_address: o.to_address || null,
    boxes: o.boxes == null ? null : o.boxes, coconuts: o.coconuts == null ? null : o.coconuts, cars: 0, need: 0, people: [],
    startMin: null, endMin: null, busyFrom: null, busyTo: null, when: o.when || null, time_source: 'none',
    leaveMin: null, drive_min: null, route_at: null, gapWords: new Map(), label: null, why: o.why || null,
    _market: o.market, _day: o.day, _fam: o.fam || null, _job: o.job || null, _extra: o.extra || null,
    _arrivalMin: null, _place: o.place || null, _servedJobs: o.servedJobs || [],
  });
  const addGap = (row, code, words) => { if (!row.gapWords.has(code)) row.gapWords.set(code, words); };
  const ruleGaps = (row, keys) => {
    const m = row._market;
    const unconfirmed = [];
    for (const k of keys) {
      const r = ruleOf(m, k);
      if (!r) continue;
      if (!r.confirmed) unconfirmed.push(ruleWords(k, r.value));
    }
    if (unconfirmed.length) addGap(row, 'rule_unconfirmed', unconfirmed.join(', ') + ' (suggested from your sheet).');
  };
  const carsFor = (row, boxes) => {
    const per = ruleOf(row._market, 'boxes_per_car');
    if (!per || !(per.value > 0)) {
      addGap(row, 'rule_missing', 'No boxes per car rule; 1 car assumed.');
      return 1;
    }
    return boxes == null ? 1 : Math.max(1, Math.ceil(boxes / per.value));
  };
  const twoOver = (m) => ruleVal(m, 'two_people_over');
  const load = (m) => ruleVal(m, 'load_minutes');
  const unload = (m) => ruleVal(m, 'unload_minutes');
  const earliest = (m) => ruleVal(m, 'earliest_start_min');
  const receivePeople = (m) => { const v = ruleVal(m, 'receive_people'); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 1; };
  const timedChecks = (row) => {
    if (row.startMin == null) return;
    const e = earliest(row._market);
    if (isFiniteNum(e) && row.startMin < e) addGap(row, 'early_start', 'Starts before ' + crewClock(e, row._market) + '.');
    if ((row.kind === 'deliver' || row.kind === 'move') && row.from_site) {
      const s = sitesById.get(row.from_site);
      const opens = s ? crewHmToMin(s.opens_at) : null;
      if (opens != null && row.startMin < opens) addGap(row, 'site_closed', trimText(s.label) + ' opens at ' + crewClock(opens, row._market) + '.');
    }
  };
  const keyHeld = new Map(); // market|day -> Set of keys held by owner rows or cancelled
  for (const [k, d] of storedDays) {
    const held = new Set((d.cancelled_keys || []).map(String));
    for (const t of d.owner_tasks || []) if (t && t.key) held.add(String(t.key));
    keyHeld.set(k, held);
  }
  const pushRow = (row) => {
    const held = keyHeld.get(row._market + '|' + row._day);
    if (held && held.has(row.key)) return null;
    dayOf(row._market, row._day).rows.push(row);
    return row;
  };

  for (const j of jobs) {
    const d = dayOf(j.market, j.day);
    d.jobIds.add(j.id);
    if (j.ooa) { d.dayGaps.push(gapEntry('out_of_area', null, j.ooa.words)); continue; }
    const o = j.o;
    const tz = zoneOf(j.market);
    // prep row
    if (j.hasPrep) {
      const row = newRow({ key: 'prep:' + j.id, kind: 'prep', order_id: j.id, from_site: j.prepSite, boxes: j.boxes, coconuts: j.coconuts,
        when: 'any_time', market: j.market, day: j.useDay, fam: j.headId, job: j, why: 'Prep the day before.' });
      row.need = 1;
      if (!j.cut) addGap(row, 'cut_unknown', 'No cut type on file.');
      const br = crewBrandingOf(o, j.card);
      j.branded = br.branded;
      if (br.unknown) addGap(row, 'branding_unknown', 'Stamp not ordered and no logo on file.');
      if (j.shares.some((s) => String(s.drop.delivery_date).slice(0, 10) === j.useDay)) addGap(row, 'late_supply', 'Some boxes land that day.');
      for (const [code, words] of j.prepGaps) addGap(row, code, words);
      if (j.short) addGap(row, 'boxes_short', plural(j.short.have, 'box', 'boxes') + ' on record, ' + j.short.need + ' needed.');
      row._place = row.from_site ? siteLabel(row.from_site) : null;
      pushRow(row);
    }
    // deliver row
    const row = newRow({ key: 'deliver:' + j.id, kind: 'deliver', order_id: j.id, from_site: j.fromSite, to_address: j.toAddress,
      boxes: j.boxes, coconuts: j.coconuts, market: j.market, day: j.day, fam: j.headId, job: j });
    row._place = crewVenueLabel(j.toAddress);
    row.cars = carsFor(row, j.boxes);
    row.need = Math.max(row.cars, j.boxes != null && j.boxes > twoOver(j.market) ? 2 : 1, posInt(j.card.people_min) || 0);
    ruleGaps(row, ['boxes_per_car', 'two_people_over']);
    // R2 gaps. day_not_linked is an INVOICED day with no invoice and no
    // family link (a paid order with no invoice id is Sidd's own entry).
    if (String(o.stage || '') === 'invoiced' && !idOf(o.external_invoice_id) && !idOf(o.parent_order_id)) addGap(row, 'day_not_linked', 'Marked invoiced but has no QuickBooks invoice and is not linked to a job.');
    if (!j.coconuts) addGap(row, 'count_missing', 'Coconut count missing.');
    const codes = findingsByOrder.get(j.id) || [];
    if (codes.some((c) => c === 'count_differs' || c === 'days_differ')) addGap(row, 'count_disputed', 'App count and invoice disagree.');
    if (codes.some((c) => c !== 'count_differs' && c !== 'days_differ')) addGap(row, 'calendar_check', 'The calendar check has an open question on this job.');
    if (j.headId === j.id) {
      const card = j.card;
      const extrasOf = (kind) => (Array.isArray(card.extras) ? card.extras : []).some((e) => e && e.kind === kind);
      const onSite = Array.isArray(card.on_site) && card.on_site.length > 0;
      for (const a of addonsByHead.get(j.id) || []) {
        const line = (Array.isArray(a.line_names) ? a.line_names : []).map(trimText).find((n) =>
          (/cart/i.test(n) && !extrasOf('cart')) || (/cooler/i.test(n) && !extrasOf('cooler')) || (/staff|attendant/i.test(n) && !onSite));
        if (line && crewTextOk(line)) {
          addGap(row, 'addon_not_on_card', 'Add-on #' + (trimText(a.doc_number) || trimText(a.qbo_id)) + ' ' + line + ' is not on the job card.');
          break;
        }
      }
    }
    // R9 address conflict
    const inv = invoiceOf(o);
    if (inv && inv.read_status === 'complete' && trimText(inv.address) && j.toAddress) {
      const iz = crewZipOf(inv.address), az = crewZipOf(j.toAddress);
      if (iz && az && iz !== az) {
        addGap(row, 'address_conflict', 'Invoice says ' + (crewVenueLabel(crewCleanAddress(inv.address)) || 'another address') + ' (' + iz + '), app says '
          + (crewVenueLabel(j.toAddress) || 'this address') + ' (' + az + '); crew go to the app address.');
      }
    }
    // R8 arrival (the alarm's own parser and its earlier-time rule)
    const arr = crewArrivalOf(o, j.day, tz, proposalsByOrder.get(j.id) || null, lib);
    const needsAmpm = arr.needsAmpm;
    const arrivalMs = arr.ms, arrivalMin = arr.min;
    if (needsAmpm) addGap(row, 'needs_ampm', 'Arrival "' + (crewTextOk(arr.windowText) ? arr.windowText.slice(0, 40) : 'time') + '" has no AM or PM.');
    if (arrivalMs != null && arr.fromInvoice) addGap(row, 'time_unconfirmed', 'Time is from the invoice only; phones show no leave-by until you confirm it.');
    if (arr.proposalMs != null) addGap(row, 'time_proposal_pending', 'The coordinator asked for ' + crewClock(arr.proposalMin, j.market) + '; the plan uses the earlier time.');
    const fromInvoice = arr.fromInvoice;
    row._arrivalMin = arrivalMin;
    // drive time from the trip's start place (asked for only when it is
    // used: a known arrival or a crew start)
    const crewStart = crewHmToMin(j.card.crew_start);
    let drive = null, routeFailed = false, routeTries = 0, routeTryAt = null;
    const routable = !!j.toAddress && j.addrUsable;
    if (routable && row.from_site && (arrivalMs != null || crewStart != null)) {
      const kept = keptDrive(j.market, j.day, row.key, row.from_site, null, j.toAddress);
      if (kept && kept.approved) drive = kept.drive; // an approved day keeps its own drive time
      if (!drive && j.base && row.from_site === idOf(j.base.id)) {
        const dep = departures.find((x) => idOf(x.order_id) === j.id && trimText(x.dest_address) === j.toAddress && isFiniteNum(x.drive_seconds));
        if (dep) {
          drive = kept && Math.abs(driveMinutes(dep.drive_seconds) - kept.minutes) < CREW_DRIFT_MINUTES
            ? kept.drive : { seconds: dep.drive_seconds, ferry: dep.has_ferry === true, at: dep.computed_at || null };
        }
      }
      if (!drive) {
        const r = driveFor(row.from_site, null, j.toAddress);
        if (r && r.failed) { routeFailed = true; routeTries = r.tries; routeTryAt = r.at; }
        else if (r && !r.pending) drive = r;
        else {
          if (r && r.pending) { routeTries = r.tries; routeTryAt = r.at; }
          if (coordsOk(sitesById.get(row.from_site))) needRoute(row.from_site, null, j.toAddress, 0, j.day);
        }
      }
    }
    if (drive) { row.drive_min = driveMinutes(drive.seconds); row.route_at = drive.at || null; }
    else if (routeTryAt) row.route_at = routeTryAt; // when the last failed try was (a failed route is tried again after 24 hours)
    row._tries = drive ? 0 : routeTries;
    let leaveMs = null;
    if (arrivalMs != null && drive && lib && lib.leaveByMs) {
      leaveMs = lib.leaveByMs({ arriveAtMs: arrivalMs, driveSeconds: drive.seconds, hasFerry: drive.ferry });
      if (isFiniteNum(leaveMs)) row.leaveMin = arrivalMin - Math.round((arrivalMs - leaveMs) / 60000);
    }
    const ld = load(j.market);
    if (crewStart != null) {
      row.startMin = crewStart; row.time_source = 'crew_start';
      if (arrivalMs == null && !needsAmpm) addGap(row, 'no_arrival', 'Start set by you, no arrival time, so no leave-by alarms.');
      if (row.leaveMin != null && crewStart > row.leaveMin - ld) addGap(row, 'start_after_leave_by', 'Start ' + crewClock(crewStart, j.market) + ' is after the leave-by ' + crewClock(row.leaveMin, j.market) + '.');
      if (arrivalMs != null && routable && !drive) addGap(row, 'route_pending', 'Drive time not worked out yet.');
    } else if (row.leaveMin != null) {
      // Leave-by minus the load time, rounded DOWN to 5 minutes (never later).
      row.startMin = Math.floor((row.leaveMin - ld) / 5) * 5; row.time_source = 'arrival';
    } else if (!needsAmpm) {
      if (arrivalMs == null) addGap(row, 'no_time', 'No arrival time and no crew start on file.');
      else if (routable && routeFailed) addGap(row, 'no_time', 'No drive time from ' + (siteLabel(row.from_site) || 'the base') + ' after 3 tries.');
      else if (routable) addGap(row, 'route_pending', 'Drive time not worked out yet.');
    }
    if (!j.toAddress) {
      addGap(row, 'no_address', navMissingReason(o) === 'long'
        ? 'The delivery address for ' + j.client + ' is longer than 200 characters; shorten it in the delivery notes.'
        : 'No delivery address for ' + j.client + '.');
    } else if (!j.addrUsable) {
      addGap(row, 'no_address', 'The address for ' + j.client + ' is not complete enough for a drive time or leave-by alarms (add the street, town and state).');
    }
    if (row.startMin != null) {
      row.busyFrom = row.startMin;
      if (arrivalMin != null) row.busyTo = arrivalMin + unload(j.market);
      else if (drive) row.busyTo = row.startMin + driveMinutes(drive.seconds) + unload(j.market);
      else row.busyTo = row.startMin + 120;
    } else if (arrivalMin != null) {
      // No start yet: no busy_from (so the row never clashes), but busy_to
      // carries the arrival, so the server words still say "Arrive by".
      row.busyTo = arrivalMin + unload(j.market);
    }
    timedChecks(row);
    for (const [code, words] of j.deliverGaps) addGap(row, code, words);
    if (j.short) addGap(row, 'boxes_short', plural(j.short.have, 'box', 'boxes') + ' on record, ' + j.short.need + ' needed.');
    row.why = crewStart != null
      ? 'Job card: ' + (j.stagedCold ? 'cold storage, ' : '') + 'crew start ' + crewClock(crewStart, j.market) + '.'
      : (arrivalMin != null ? 'Arrival ' + crewClock(arrivalMin, j.market) + (fromInvoice ? ' from the invoice.' : ' confirmed.') : 'No arrival time on file.');
    if (drive && drive.ferry) row.why += ' Ferry on the route.';
    if (!drive && routeTries > 0) row.why += ' Route tries: ' + routeTries + '.';
    pushRow(row);
  }

  // extras and on-site rows come from the job card of day 1, once per job:
  // the lead is day 1 itself when it is planned, else the job's earliest
  // planned day (jobs are sorted by day).
  const familyLead = new Map();
  for (const j of jobs) {
    if (j.ooa) continue;
    const cur = familyLead.get(j.headId);
    if (!cur || (j.id === j.headId && cur.id !== cur.headId)) familyLead.set(j.headId, j);
  }
  for (const [headId, head] of familyLead) {
    const card = head.card;
    const toAddress = head.toAddress;
    const venueLabel = crewVenueLabel(toAddress);
    const m = head.market;
    const inWindow = (day) => day >= crewDayAdd(todayOf(m), -1) && day <= crewDayAdd(todayOf(m), 8);
    for (const e of Array.isArray(card.extras) ? card.extras : []) {
      if (!e || !e.key) continue;
      const label = trimText(e.label) || (e.kind === 'cooler' ? 'Cooler' : 'Cart');
      const home = e.home_site_id && sitesById.get(idOf(e.home_site_id)) ? idOf(e.home_site_id) : null;
      const homeDrive = home && toAddress ? driveFor(home, null, toAddress) : null;
      const homeKnown = !!homeDrive && isFiniteNum(homeDrive.seconds);
      if (home && toAddress && addressUsable(toAddress) && !homeKnown && !(homeDrive && homeDrive.failed) && coordsOk(sitesById.get(home))) needRoute(home, null, toAddress, 2, head.day);
      for (const part of ['drop', 'pickup']) {
        const slot = e[part] && typeof e[part] === 'object' ? e[part] : null;
        if (!slot) continue;
        const day = slot.day ? String(slot.day).slice(0, 10) : head.day;
        if (!inWindow(day)) continue;
        const isDrop = part === 'drop';
        const row = newRow({ key: (isDrop ? 'extra_drop:' : 'extra_pickup:') + headId + ':' + e.key, kind: isDrop ? 'cart_drop' : 'cart_pickup',
          order_id: headId, from_site: isDrop ? home : null, to_site: isDrop ? null : home, to_address: toAddress, boxes: 0,
          market: m, day, fam: headId, job: head, extra: e, place: venueLabel, why: 'Job card: ' + (isDrop ? 'drop' : 'pickup') + ' at the venue.' });
        // An approved day keeps its own drive time for the same ends.
        const kept = keptDrive(m, day, row.key, row.from_site, row.to_site, row.to_address);
        const rowDrive = kept && kept.approved ? kept.drive : (homeKnown ? homeDrive : null);
        const driveMin = rowDrive ? driveMinutes(rowDrive.seconds) : null;
        row.cars = 1;
        row.need = Math.max(1, Math.min(4, posInt(e.people) || 1), posInt(card.people_min) || 0);
        row.time_source = 'owner';
        row.startMin = crewHmToMin(slot.start);
        row.endMin = crewHmToMin(slot.end);
        row.drive_min = driveMin;
        if (rowDrive) row.route_at = rowDrive.at || null;
        if (row.startMin == null) addGap(row, 'equipment_no_time', capFirst(label) + ' time is missing.');
        if (!home) addGap(row, 'equipment_no_home', 'Where is the ' + lowFirst(label) + ' kept?');
        if (row.startMin != null) {
          row.busyFrom = row.startMin - (driveMin != null ? driveMin : 60);
          row.busyTo = isDrop || row.endMin == null ? row.startMin + 30 : row.endMin;
        }
        timedChecks(row);
        pushRow(row);
      }
    }
    (Array.isArray(card.on_site) ? card.on_site : []).forEach((entry, i) => {
      if (!entry) return;
      const day = entry.day ? String(entry.day).slice(0, 10) : head.day;
      if (!inWindow(day)) return;
      const row = newRow({ key: 'on_site:' + headId + ':' + (i + 1), kind: 'on_site', order_id: headId, to_address: toAddress,
        market: m, day, fam: headId, job: head, place: venueLabel, why: 'Job card: on site hours.' });
      row.need = Math.max(1, Math.min(6, posInt(entry.people) || 1));
      row.time_source = 'owner';
      row.startMin = crewHmToMin(entry.start);
      row.endMin = crewHmToMin(entry.end);
      if (row.startMin != null) { row.busyFrom = row.startMin; row.busyTo = row.endMin != null ? row.endMin : row.startMin + 60; }
      timedChecks(row);
      pushRow(row);
    });
  }

  // receive and move rows, per drop (R5, R6, R8)
  for (const m of plannedMarkets) {
    const base = baseOf(m);
    const cold = coldOf(m);
    const rp = receivePeople(m);
    const moveDrive = base && cold ? driveFor(idOf(base.id), idOf(cold.id), null) : null;
    const moveKnown = !!moveDrive && isFiniteNum(moveDrive.seconds);
    if (base && cold && !moveKnown && !(moveDrive && moveDrive.failed) && coordsOk(base) && coordsOk(cold) && trimText(cold.address)) {
      const firstMoveDay = jobs.filter((j) => j.market === m && j.stagedCold).map((j) => j.useDay).sort()[0];
      if (firstMoveDay) needRoute(idOf(base.id), idOf(cold.id), null, 1, firstMoveDay);
    }
    const moveRow = (key, day, boxes, when, win, served) => {
      const row = newRow({ key, kind: 'move', supply_id: Number(key.split(':')[1]), from_site: idOf(base.id), to_site: idOf(cold.id), boxes,
        when, market: m, day, place: trimText(base.label), servedJobs: served,
        why: when === 'any_time' ? 'Moved to cold storage after prep.' : 'Kept in cold storage until the job.' });
      // An approved day keeps its own drive time for the same ends.
      const kept = keptDrive(m, day, key, row.from_site, row.to_site, null);
      const rowDrive = kept && kept.approved ? kept.drive : (moveKnown ? moveDrive : null);
      const moveMin = rowDrive ? driveMinutes(rowDrive.seconds) : null;
      row.cars = carsFor(row, boxes);
      row.need = Math.max(row.cars, boxes > twoOver(m) ? 2 : 1, ...served.map((j) => posInt(j.card.people_min) || 0));
      ruleGaps(row, ['boxes_per_car', 'two_people_over']);
      row.drive_min = moveMin;
      if (rowDrive) row.route_at = rowDrive.at || null;
      if (win) {
        row.startMin = win.start; row.endMin = win.end; row.time_source = 'supply_window';
        row.busyFrom = win.end;
        row.busyTo = win.end + (moveMin != null ? moveMin : 60) + unload(m);
        const closes = crewHmToMin(cold.closes_at);
        if (closes != null && row.busyTo > closes) addGap(row, 'site_closed', trimText(cold.label) + ' closes at ' + crewClock(closes, m) + '; this move ends at ' + crewClock(row.busyTo, m) + '.');
      }
      timedChecks(row);
      return row;
    };
    for (const d of dropsByMarket.get(m) || []) {
      const landing = String(d.delivery_date).slice(0, 10);
      if (!(landing >= crewDayAdd(todayOf(m), -1) && landing <= crewDayAdd(todayOf(m), 8))) continue;
      const win = crewSupplyWindow(d.delivery_window);
      const landShares = jobs.filter((j) => j.market === m && j.stagedCold && !(j.card.prep === 'base' && j.hasPrep))
        .map((j) => ({ j, boxes: j.shares.filter((s) => s.drop.id === d.id).reduce((s, x) => s + x.boxes, 0) })).filter((x) => x.boxes > 0);
      const moved = landShares.reduce((s, x) => s + x.boxes, 0);
      const rest = Number(d.boxes) - moved;
      if (moved > 0 && base && cold) pushRow(moveRow('move:' + d.id, landing, moved, 'after_drop', win, landShares.map((x) => x.j)));
      if (rest > 0 && base) {
        const row = newRow({ key: 'receive:' + d.id, kind: 'receive', supply_id: Number(d.id), from_site: idOf(base.id), boxes: rest,
          market: m, day: landing, place: trimText(base.label), why: win ? 'Drop window.' : 'Drop on record, no time window.' });
        row.need = rp;
        ruleGaps(row, ['receive_people']);
        if (win) {
          row.startMin = win.start; row.endMin = win.end; row.time_source = 'supply_window';
          if (rp >= 1) { row.busyFrom = win.start; row.busyTo = win.end; }
        }
        timedChecks(row);
        pushRow(row);
      }
    }
    // after-prep moves (job card prep: base)
    for (const j of jobs.filter((x) => x.market === m && x.stagedCold && x.card.prep === 'base' && x.hasPrep && !x.ooa)) {
      const byDrop = new Map();
      for (const s of j.shares) byDrop.set(s.drop.id, (byDrop.get(s.drop.id) || 0) + s.boxes);
      for (const [dropId, boxes] of byDrop) {
        const existing = dayOf(m, j.useDay).rows.find((r) => r.key === 'move:' + dropId);
        if (existing) { existing.boxes += boxes; continue; }
        pushRow(moveRow('move:' + dropId, j.useDay, boxes, 'any_time', null, [j]));
      }
    }
  }

  // Every stored day in the window stays in the output even when the robot
  // has nothing for it now (its job was cancelled or moved): a draft then
  // loses its robot rows, an approved day gets a proposal without them.
  for (const k of storedDays.keys()) {
    const [m, day] = k.split('|');
    if (day >= crewDayAdd(todayOf(m), -1) && day <= crewDayAdd(todayOf(m), 8)) dayOf(m, day);
  }

  // no_supply_record: every job day of a planned market with nothing counting
  for (const m of plannedMarkets) {
    if (supply.some((r) => counting(r, m))) continue;
    for (const j of jobs.filter((x) => x.market === m)) {
      const d = dayOf(m, j.day);
      if (!d.dayGaps.some((g) => g.code === 'no_supply_record')) d.dayGaps.push(gapEntry('no_supply_record', null, 'No coconut drop on record for ' + (CREW_MARKET_WORDS[m] || m) + '.'));
    }
  }

  // -- 073's ranges (CREW_LIMITS): a value outside them makes the server
  // refuse the whole day, so the day would silently never draft. Never a
  // wrong number: a box or coconut count too big for one row is left off the
  // row (the crew words then say "the boxes"), and cars and people are capped,
  // each with a red gap so Sidd splits the trip by hand.
  for (const d of days.values()) {
    for (const row of d.rows) {
      const who = row.order_id ? crewClientLabel(ordersById.get(idOf(row.order_id))) : 'A box drop';
      if (row.cars > CREW_LIMITS.cars) {
        addGap(row, 'people_short', 'Needs ' + row.cars + ' cars; one row holds ' + CREW_LIMITS.cars + '. Split the trip by hand (Add row).');
        row.cars = CREW_LIMITS.cars;
      }
      if (row.need > CREW_LIMITS.need) {
        addGap(row, 'people_short', 'Needs ' + row.need + ' people; one row holds ' + CREW_LIMITS.need + '. Split the trip by hand (Add row).');
        row.need = CREW_LIMITS.need;
      }
      if (row.boxes != null && row.boxes > CREW_LIMITS.boxes) {
        addGap(row, 'count_disputed', capFirst(who) + ': ' + row.boxes + ' boxes is more than one row holds (' + CREW_LIMITS.boxes + '). Split it by hand (Add row).');
        row.boxes = null;
      }
      if (row.coconuts != null && row.coconuts > CREW_LIMITS.coconuts) {
        addGap(row, 'count_disputed', capFirst(who) + ': ' + row.coconuts + ' coconuts is more than one row holds (' + CREW_LIMITS.coconuts + '). Split it by hand (Add row).');
        row.coconuts = null;
      }
    }
  }

  // -- R11 who, R12 long day: per market, days in date order, rows in R13 order
  const r13 = (a, b) => {
    const sa = a.startMin, sb = b.startMin;
    if (sa !== sb) {
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa - sb;
    }
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  const famPeople = new Map();
  const weekCount = new Map();
  const bumpWeek = (pid, day) => { const k = pid + '|' + crewWeekStart(day); weekCount.set(k, (weekCount.get(k) || 0) + 1); };
  const addFam = (fam, pid) => {
    if (!fam || !pid) return;
    if (!famPeople.has(fam)) famPeople.set(fam, []);
    const list = famPeople.get(fam);
    if (!list.includes(pid)) list.push(pid);
  };
  const ownerStart = (t) => crewHmToMin(t.start);
  const ownerBusy = (t) => {
    const s = crewHmToMin(t.busy_from) != null ? crewHmToMin(t.busy_from) : ownerStart(t);
    if (s == null) return null;
    const e = crewHmToMin(t.busy_to) != null ? crewHmToMin(t.busy_to) : (crewHmToMin(t.end) != null ? crewHmToMin(t.end) : s + 60);
    return { from: s, to: e };
  };
  // Approved and owner rows before the planning window, in the same week,
  // count toward "fewest rows this week".
  const allKeys = [...new Set([...days.keys(), ...storedDays.keys()])];
  for (const k of allKeys) {
    const [m, day] = k.split('|');
    if (day >= crewDayAdd(todayOf(m), -1)) continue;
    const sd = storedDays.get(k);
    if (!sd) continue;
    const list = (sd.status === 'approved' || sd.status === 'changed') ? (sd.approved_tasks || []) : (sd.owner_tasks || []);
    for (const t of list) for (const p of (t && t.people) || []) if (p && p.person_id) bumpWeek(idOf(p.person_id), day);
  }
  // hc_crew_person_ok, as the put checks it: active, not locked, not in
  // never_schedule, not the App Review login, and a roster person's LIVE
  // market is the day's market (the owner's own row passes in any market).
  // A blank live market is NO market (073 reads nullif(lower(btrim(market)),
  // '')), never New York: fail closed.
  const rowEligible = (p, m) => {
    if (!p || p.active === false || p.locked === true) return false;
    if (p.worker_id && never.has(idOf(p.worker_id))) return false;
    if (trimText(p.email).toLowerCase() === CREW_APP_REVIEW_EMAIL) return false;
    if (p.kind === 'roster') return String(p.role || '') === 'owner' || crewLiveMarket(p.market) === m;
    return p.kind === 'helper' && crewLiveMarket(p.helper_market || p.market) === m;
  };
  const marketsInPlay = [...new Set([...days.values()].map((d) => d.market))].sort();
  for (const m of marketsInPlay) {
    const pool = people.filter((p) => {
      if (p.active === false || p.locked === true) return false;
      if (p.worker_id && never.has(idOf(p.worker_id))) return false;
      if (trimText(p.email).toLowerCase() === CREW_APP_REVIEW_EMAIL) return false;
      if (p.kind === 'roster') return p.auto_pick === 'yes' && crewLiveMarket(p.market) === m && p.has_login !== false && String(p.role || '') !== 'owner';
      if (p.kind === 'helper') return p.auto_pick === 'ask' && crewLiveMarket(p.helper_market || p.market) === m;
      return false;
    });
    const poolIds = new Set(pool.map((p) => idOf(p.person_id)));
    const roster = pool.filter((p) => p.kind === 'roster');
    const helpers = pool.filter((p) => p.kind === 'helper');
    const nameOf = (p) => personName(p.person_id) || '';
    const cmpId = (a, b) => (idOf(a.person_id) < idOf(b.person_id) ? -1 : idOf(a.person_id) > idOf(b.person_id) ? 1 : 0);
    const mDays = [...days.values()].filter((d) => d.market === m).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    for (const d of mDays) {
      const sd = storedDays.get(m + '|' + d.day);
      const approvedDay = !!sd && (sd.status === 'approved' || sd.status === 'changed');
      const approvedByKey = new Map();
      if (approvedDay) for (const t of sd.approved_tasks || []) if (t && t.key && t.source !== 'owner') approvedByKey.set(String(t.key), t);
      const busy = new Map(); // person -> [{from,to}]
      const addBusy = (pid, row) => { if (row.busyFrom == null || row.busyTo == null) return; if (!busy.has(pid)) busy.set(pid, []); busy.get(pid).push({ from: row.busyFrom, to: row.busyTo }); };
      const overlaps = (pid, row) => row.busyFrom != null && row.busyTo != null && (busy.get(pid) || []).some((w) => w.from < row.busyTo && row.busyFrom < w.to);
      // owner rows hold their people first
      d.ownerRows = (sd && (approvedDay ? (sd.approved_tasks || []).filter((t) => t && t.source === 'owner') : (sd.owner_tasks || []))) || [];
      for (const t of d.ownerRows) {
        const w = ownerBusy(t);
        for (const p of t.people || []) {
          const pid = idOf(p && p.person_id);
          if (!pid) continue;
          if (w) { if (!busy.has(pid)) busy.set(pid, []); busy.get(pid).push(w); }
          bumpWeek(pid, d.day);
          if (t.order_id) addFam(idOf((ordersById.get(idOf(t.order_id)) || {}).parent_order_id) || idOf(t.order_id), pid);
        }
      }
      d.rows.sort(r13);
      for (const row of d.rows) {
        const chosen = [];
        const kept = approvedByKey.get(row.key);
        if (kept) {
          // An approved day keeps its people (Sidd picks any swap). A person
          // who may no longer be on a row (locked, inactive, never_schedule,
          // App Review, moved market) drops off and the row says so.
          for (const p of kept.people || []) {
            const pid = idOf(p && p.person_id);
            if (!pid || chosen.includes(pid)) continue;
            const person = peopleById.get(pid);
            if (!rowEligible(person, m)) continue;
            chosen.push(pid);
            if (person && person.worker_id && offOn(person.worker_id, d.day, 'approved')) addGap(row, 'person_off', (personName(pid) || 'Someone') + ' has an approved day off.');
            if (overlaps(pid, row)) addGap(row, 'clash', (personName(pid) || 'Someone') + ' is in two places at ' + crewClock(row.busyFrom, m) + '.');
          }
          if (chosen.length < row.need) {
            const n = row.need - chosen.length;
            const drivers = Math.max(0, row.cars - chosen.length);
            addGap(row, 'people_short', drivers >= n ? n + ' more ' + (n === 1 ? 'driver' : 'drivers') + ' needed.' : n + ' more ' + (n === 1 ? 'person' : 'people') + ' needed.');
          }
        } else if (row.need > 0) {
          const weekKey = crewWeekStart(d.day);
          const wc = (p) => weekCount.get(idOf(p.person_id) + '|' + weekKey) || 0;
          const rosterSorted = [...roster].sort((a, b) => (Number(a.rank) - Number(b.rank)) || (wc(a) - wc(b)) || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0) || cmpId(a, b));
          const helperSorted = [...helpers].sort((a, b) => (Number(a.rank) - Number(b.rank)) || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0) || cmpId(a, b));
          const order = [];
          for (const pid of famPeople.get(row._fam) || []) if (poolIds.has(pid) && !order.includes(pid)) order.push(pid);
          for (const p of [...rosterSorted, ...helperSorted]) { const pid = idOf(p.person_id); if (!order.includes(pid)) order.push(pid); }
          const cands = order.filter((pid) => { const p = peopleById.get(pid); return !(p && p.worker_id && offOn(p.worker_id, d.day, 'approved')); });
          for (const pid of cands) { if (chosen.length >= row.need) break; if (!overlaps(pid, row)) chosen.push(pid); }
          for (const pid of cands) {
            if (chosen.length >= row.need) break;
            if (chosen.includes(pid)) continue;
            chosen.push(pid);
            addGap(row, 'clash', (personName(pid) || 'Someone') + ' is in two places at ' + crewClock(row.busyFrom, m) + '.');
          }
          if (chosen.length < row.need) {
            if (!pool.length) addGap(row, 'no_crew_in_market', 'Nobody can be planned in ' + (CREW_MARKET_WORDS[m] || m) + '.');
            else {
              const n = row.need - chosen.length;
              const drivers = Math.max(0, row.cars - chosen.length);
              addGap(row, 'people_short', drivers >= n ? n + ' more ' + (n === 1 ? 'driver' : 'drivers') + ' needed.' : n + ' more ' + (n === 1 ? 'person' : 'people') + ' needed.');
            }
          }
        }
        row.people = chosen.map((pid, i) => ({ person_id: pid, car: row.cars > 0 && i < row.cars ? i + 1 : null }));
        for (const pid of chosen) {
          const p = peopleById.get(pid);
          if (p && p.worker_id && offOn(p.worker_id, d.day, 'pending')) { addGap(row, 'pending_day_off', (personName(pid) || 'Someone') + ' asked for this day off.'); break; }
        }
        const helper = chosen.map((pid) => peopleById.get(pid)).find((p) => p && p.kind === 'helper');
        if (helper) addGap(row, 'helper_ask', 'Ask ' + (personName(helper.person_id) || 'the helper') + ' (helper, not in the app).');
        for (const pid of chosen) { addBusy(pid, row); bumpWeek(pid, d.day); addFam(row._fam, pid); }
      }
      // drop window overlap (needs everyone's rows that day)
      const rp = receivePeople(m);
      if (rp >= 1) {
        for (const row of d.rows) {
          if (!((row.kind === 'receive' || (row.kind === 'move' && row.when === 'after_drop')) && row.startMin != null && row.endMin != null)) continue;
          let found = null;
          for (const p of row.people) {
            for (const other of d.rows) {
              if (other === row || other.startMin == null || !other.people.some((x) => x.person_id === p.person_id)) continue;
              const place = other._place;
              if (!place || place === row._place) continue;
              const at = other.kind === 'deliver' && other._arrivalMin != null ? other._arrivalMin : other.startMin;
              if (other.startMin >= row.startMin - 120 && other.startMin <= row.endMin) { found = { pid: p.person_id, place, at }; break; }
            }
            if (found) break;
          }
          if (found) addGap(row, 'drop_window_overlap', (personName(found.pid) || 'Someone') + ' is at ' + found.place + ' at ' + crewClock(found.at, m)
            + '; the boxes arrive ' + crewClock(row.startMin, m) + ' to ' + crewClock(row.endMin, m) + '.');
        }
      }
      // R12 long day, measured on busy windows (owner rows count too)
      const maxSpan = ruleVal(m, 'max_span_hours');
      const spans = new Map();
      const note = (pid, from, to) => { if (from == null || to == null) return; const s = spans.get(pid) || { from, to }; s.from = Math.min(s.from, from); s.to = Math.max(s.to, to); spans.set(pid, s); };
      for (const t of d.ownerRows) { const w = ownerBusy(t); if (w) for (const p of t.people || []) note(idOf(p.person_id), w.from, w.to); }
      for (const row of d.rows) for (const p of row.people) note(p.person_id, row.busyFrom, row.busyTo);
      for (const [pid, s] of spans) {
        if (!(isFiniteNum(maxSpan) && s.to - s.from > maxSpan * 60)) continue;
        const first = d.rows.find((r) => r.people.some((p) => p.person_id === pid));
        if (first) addGap(first, 'long_day', (personName(pid) || 'Someone') + ' about ' + ((s.to - s.from) / 60).toFixed(1) + ' h.');
      }
    }
  }

  // -- R13 output and the md5 of every fact used
  const versions = {
    settings: settings.version == null ? null : settings.version,
    rules: (inp.rules || []).filter(Boolean).map((r) => [crewMarketKey(r.market), String(r.key), r.version == null ? null : r.version, Number(r.value), r.confirmed === true]).sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1)),
    sites: (inp.sites || []).filter((s) => s && s.id).map((s) => [idOf(s.id), s.version == null ? null : s.version]).sort(),
    people: people.map((p) => [idOf(p.person_id), p.version == null ? null : p.version, p.locked === true, crewLiveMarket(p.kind === 'helper' ? p.helper_market : p.market), p.active !== false]).sort(),
    jobs: [...cards.keys()].map((id) => [id, cards.get(id).version == null ? null : cards.get(id).version]).sort(),
  };
  const jobFact = (j) => {
    const o = j.o, inv = invoiceOf(o) || {}, dr = requestOf(o) || {};
    return { id: j.id, day: j.day, head: j.headId, stage: o.stage || null, coconuts: j.coconuts, to: j.toAddress, client: j.client,
      inv: [inv.read_status || null, inv.address || null, inv.delivery_window || null, inv.cracking || null], dr: [dr.status || null, dr.window || null],
      crack: o.crack_type || null, stamp: o.stamp_status || null, logo: o.logo_received === true, ext: idOf(o.external_invoice_id),
      findings: [...(findingsByOrder.get(j.id) || [])].sort(), proposal: proposalsByOrder.has(j.id) ? proposalsByOrder.get(j.id).ms : null };
  };
  const result = [];
  const taskOut = (row, ctx) => {
    const t = {
      key: row.key, source: 'robot', kind: row.kind, order_id: row.order_id, supply_id: row.supply_id, from_site: row.from_site,
      to_site: row.to_site, to_address: row.to_address, boxes: row.boxes, coconuts: row.coconuts, cars: row.cars, need: row.need,
      people: row.people.map((p) => ({ person_id: p.person_id, car: p.car })), start: crewMinToHm(row.startMin), end: crewMinToHm(row.endMin),
      busy_from: crewMinToHm(row.busyFrom), busy_to: crewMinToHm(row.busyTo), when: row.when, time_source: row.time_source,
      leave_by: crewMinToHm(row.leaveMin), drive_min: row.drive_min, route_at: row.route_at, gaps: [...row.gapWords.keys()].sort(),
      label: null, words: '', why: row.why && crewTextOk(row.why) && row.why.length <= 200 ? row.why : null,
    };
    t.words = crewWords(t, ctx);
    return t;
  };
  const rowByKey = new Map();
  for (const d of days.values()) for (const r of d.rows) rowByKey.set(d.market + '|' + d.day + '|' + r.key, r);
  const wordsCtx = (m, day) => ({
    market: m,
    siteLabel,
    personName,
    client: (id) => { const o = ordersById.get(idOf(id)); return o ? crewClientLabel(o) : 'the client'; },
    unloadMin: unload(m),
    jobDayWords: (t) => { const o = ordersById.get(idOf(t.order_id)); return o ? crewDayWords(crewOrderDay(o), thisYear) : ''; },
    prepFacts: (t) => { const row = rowByKey.get(m + '|' + day + '|' + t.key); return row && row._job ? { cut: row._job.cut, branded: !!row._job.branded } : {}; },
    extraLabel: (t) => { const row = rowByKey.get(m + '|' + day + '|' + t.key); return row && row._extra ? (trimText(row._extra.label) || 'cart') : 'cart'; },
  });
  const ordered = [...days.values()].sort((a, b) => (a.market + a.day < b.market + b.day ? -1 : a.market + a.day > b.market + b.day ? 1 : 0));
  for (const d of ordered) {
    const ctx = wordsCtx(d.market, d.day);
    d.rows.sort(r13);
    const tasks = d.rows.map((r) => taskOut(r, ctx));
    const entries = [...d.dayGaps];
    for (const r of d.rows) for (const [code, words] of r.gapWords) entries.push(gapEntry(code, r.key, words));
    const gaps = crewSortGaps(entries);
    const red = gaps.filter((g) => g.level === 'red').length;
    const amber = gaps.length - red;
    const sd = storedDays.get(d.market + '|' + d.day) || null;
    const jobSet = jobs.filter((j) => j.market === d.market && (j.day === d.day || j.day === crewDayAdd(d.day, 1)));
    const jobIdSet = new Set(jobSet.map((j) => j.id));
    const drops = (dropsByMarket.get(d.market) || []).filter((x) => String(x.delivery_date).slice(0, 10) === d.day || jobSet.some((j) => j.shares.some((s) => s.drop.id === x.id)));
    const facts = {
      v: 1, market: d.market, day: d.day, versions,
      jobs: jobSet.map(jobFact).sort((a, b) => (a.id < b.id ? -1 : 1)),
      drops: drops.map((x) => [x.id, String(x.delivery_date).slice(0, 10), x.delivery_window || null, Number(x.boxes), x.status, x.ship_to_garage === true]).sort((a, b) => a[0] - b[0]),
      claims: supply.filter((r) => r.status === 'claimed' && supplyMarket(r) === d.market && jobSet.some((j) => j.P === String(r.prep_day || '').slice(0, 10))).map((r) => [r.id, String(r.prep_day).slice(0, 10), Number(r.boxes), r.supplier]).sort((a, b) => a[0] - b[0]),
      time_off: timeOff.filter((t) => String(t.start_day).slice(0, 10) <= d.day && String(t.end_day || t.start_day).slice(0, 10) >= d.day).map((t) => [idOf(t.worker_id), t.status]).sort(),
      // Only stored facts that change the robot's output: removed keys,
      // owner rows and an approved day's people (a draft day and no day
      // at all give the same md5, so the first write is not "a change").
      stored: {
        cancelled: [...((sd && sd.cancelled_keys) || [])].map(String).sort(),
        owner: (d.ownerRows || []).map((t) => [t.key, (t.people || []).map((p) => idOf(p.person_id)), t.start || null, t.end || null, t.busy_from || null, t.busy_to || null]),
        approved: sd && (sd.status === 'approved' || sd.status === 'changed')
          ? (sd.approved_tasks || []).filter((t) => t && t.source !== 'owner').map((t) => [t.key, (t.people || []).map((p) => idOf(p.person_id))]) : null,
      },
      out: { tasks: tasks.map((t) => { const { words, why, route_at, ...rest } = t; return rest; }), gaps },
      // The failed route tries are a fact of the day (they live only in the
      // stored why line): a new try must be written, or the count never
      // reaches 3 and red no_time never comes.
      route_tries: d.rows.filter((r) => r._tries > 0).map((r) => [r.key, r._tries]),
    };
    const inputsMd5 = md5Hex(stableJson(facts));
    const today = todayOf(d.market);
    const frozen = d.day < today;
    const status = sd ? (sd.status || 'draft') : 'draft';
    let put = !frozen && !(sd && sd.inputs_md5 === inputsMd5);
    if (put && !sd && !tasks.length && !gaps.length) put = false;
    let reasons = [];
    let quiet = false;
    if (put && (status === 'approved' || status === 'changed')) {
      const approvedRobot = (sd.approved_tasks || []).filter((t) => t && t.source !== 'owner');
      if (status === 'approved' && crewSameTasks(approvedRobot, tasks)) { put = false; quiet = true; }
      else reasons = crewReasons(approvedRobot, tasks, gaps, { market: d.market, day: d.day, ordersById, personName, thisYear });
    }
    result.push({ market: d.market, day: d.day, status, version: sd ? (sd.version == null ? 0 : sd.version) : 0, tasks, gaps,
      red_count: red, amber_count: amber, inputs_md5: inputsMd5, frozen, put, quiet, reasons, jobIds: [...jobIdSet].sort() });
  }
  const needs = [...routeNeeds.values()].sort((a, b) => (a.priority - b.priority) || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (a.key < b.key ? -1 : 1));
  return { days: result, routeNeeds: needs, today: todayOf('ny') };
}

// Approved robot rows equal to the robot's new rows (words, why and the
// route time are left out: the server rebuilds words; why and route_at are
// the robot's own notes).
const COMPARE_KEYS = CREW_TASK_KEYS.filter((k) => k !== 'words' && k !== 'why' && k !== 'route_at');
export function crewSameTasks(a, b) {
  const pick = (list) => (list || []).map((t) => COMPARE_KEYS.map((k) => (t && t[k] === undefined ? null : t && t[k])));
  return stableJson(pick(a)) === stableJson(pick(b));
}
// Plain reasons for a change to an approved day (the owner's crew_change
// banner names the first one). Held facts first, then days off, then
// times, counts, people and rows.
export function crewReasons(approvedTasks, newTasks, gaps, ctx) {
  const out = [];
  const add = (s) => { if (s && crewTextOk(s) && !out.includes(s)) out.push(s); };
  const client = (id) => { const o = ctx.ordersById.get(idOf(id)); return o ? crewClientLabel(o) : 'A job'; };
  const byKey = (list) => new Map((list || []).filter((t) => t && t.key).map((t) => [String(t.key), t]));
  const before = byKey(approvedTasks), after = byKey(newTasks);
  for (const [, t] of before) {
    const why = crewHeldReason(t, ctx.day, ctx.ordersById);
    if (why === 'cancelled') add(client(t.order_id) + ' was cancelled.');
    else if (why === 'moved') { const o = ctx.ordersById.get(idOf(t.order_id)); add(client(t.order_id) + ' moved to ' + crewDayWords(crewOrderDay(o), ctx.thisYear) + '.'); }
    else if (why === 'address') add(client(t.order_id) + ' has a new address.');
  }
  for (const g of gaps || []) if (g.code === 'person_off') add(g.words);
  for (const [k, t] of after) {
    const b = before.get(k);
    if (!b) { add('New row: ' + (t.kind === 'deliver' ? 'delivery for ' + client(t.order_id) : t.kind.replace('_', ' ')) + '.'); continue; }
    if (t.kind === 'deliver' && b.start !== t.start) add('Delivery time now ' + (t.start ? crewClock(crewHmToMin(t.start), ctx.market) : 'not set') + '.');
    else if (t.kind === 'deliver' && b.leave_by !== t.leave_by) add('Leave-by now ' + (t.leave_by ? crewClock(crewHmToMin(t.leave_by), ctx.market) : 'not set') + '.');
    if (b.boxes !== t.boxes) add(client(t.order_id) + ': ' + (t.boxes == null ? 'box count unknown' : plural(t.boxes, 'box', 'boxes')) + ' now.');
    if (stableJson(b.people) !== stableJson(t.people)) add('Crew changed for ' + (t.order_id ? client(t.order_id) : 'a box drop') + '.');
    if (b.from_site !== t.from_site || b.to_address !== t.to_address) add('Place changed for ' + (t.order_id ? client(t.order_id) : 'a box drop') + '.');
    if (stableJson(b.gaps) !== stableJson(t.gaps)) add('Open questions changed.');
  }
  for (const [k, t] of before) if (!after.has(k) && !crewHeldReason(t, ctx.day, ctx.ordersById)) add('Row removed: ' + (t.kind === 'deliver' ? 'delivery for ' + client(t.order_id) : t.kind.replace('_', ' ')) + '.');
  if (!out.length) add('Plan details changed.');
  return out.slice(0, 6);
}

// ---------------------------------------------------------------- banners (pure)
// The 6 PM crew_tomorrow list for one approved market day. day: the stored
// day ({market, day, status, approved_version, approved_tasks}); people:
// robot person view; ordersById: live orders (for the held check);
// timeOff: approved and pending days off. Returns
// [{person_id, email, id, title, body, collapse_id, thread_id}] in R13
// order of each person's first row. Helpers, the owner role, locked,
// never_schedule and App Review people and anyone with an approved day off
// get nothing.
export function crewTomorrowSends(day, people, ordersById, timeOff, settings, thisYear) {
  const out = [];
  if (!day || !(day.status === 'approved' || day.status === 'changed')) return out;
  const market = crewMarketKey(day.market);
  const planDay = String(day.day).slice(0, 10);
  const never = new Set(((settings && settings.never_schedule) || []).map(idOf));
  const byId = new Map((people || []).map((p) => [idOf(p.person_id), p]));
  const tasks = (day.approved_tasks || []).filter(Boolean);
  const dayWords = crewDayWords(planDay, thisYear);
  const seen = [];
  for (const t of tasks) for (const p of t.people || []) { const pid = idOf(p && p.person_id); if (pid && !seen.includes(pid)) seen.push(pid); }
  for (const pid of seen) {
    const person = byId.get(pid);
    if (!person || person.kind !== 'roster') continue;
    if (person.active === false || person.locked === true || String(person.role || '') === 'owner') continue;
    if (person.worker_id && never.has(idOf(person.worker_id))) continue;
    const email = trimText(person.email).toLowerCase();
    if (!email || email === CREW_APP_REVIEW_EMAIL) continue;
    if (crewLiveMarket(person.market) !== market) continue; // a blank live market is no market
    if (person.worker_id && (timeOff || []).some((x) => x && x.status === 'approved' && idOf(x.worker_id) === idOf(person.worker_id)
      && String(x.start_day).slice(0, 10) <= planDay && String(x.end_day || x.start_day).slice(0, 10) >= planDay)) continue;
    const mine = tasks.filter((t) => (t.people || []).some((p) => idOf(p && p.person_id) === pid));
    const lines = mine.map((t) => (crewHeldReason(t, planDay, ordersById) ? CREW_HOLD_WORDS : String(t.words || '')));
    const allHeld = mine.length > 0 && mine.every((t) => !!crewHeldReason(t, planDay, ordersById));
    const body = allHeld ? 'Your ' + dayWords + ' plan is on hold. Sidd will confirm.' : lines.join('\n');
    if (!body || !crewTextOk(body.replace(/\n/g, ' '))) continue;
    out.push({
      person_id: pid, email, title: 'Tomorrow, ' + dayWords, body,
      id: md5Uuid('hc-crew-tomorrow-v1' + market + planDay + String(day.approved_version) + pid),
      collapse_id: 'crew-' + market + '-' + planDay + '-tomorrow', thread_id: 'day-' + market + '-' + planDay,
    });
  }
  return out;
}
// The questions on one day for the owner: red plus amber on a draft day,
// the proposal's gaps on a changed day, none on an approved day. Null when
// the day state does not say (the database did not send it whole).
export function crewDayQuestions(day) {
  if (!day) return 0;
  if (day.status === 'approved') return 0;
  if (day.status === 'changed') {
    const p = day.proposal && typeof day.proposal === 'object' ? day.proposal : null;
    return p && Array.isArray(p.gaps) ? p.gaps.length : null;
  }
  const r = Number(day.red_count), a = Number(day.amber_count);
  if (day.red_count != null && day.amber_count != null && Number.isFinite(r) && Number.isFinite(a)) return r + a;
  return Array.isArray(day.gaps) ? day.gaps.length : null;
}
// Rows on a day: the whole stored list when sent, else the approved or
// owner rows. Null for a draft day whose robot rows were not sent (the day
// exists, so it has rows or owner state).
export function crewDayRowCount(day) {
  if (!day) return 0;
  if (Array.isArray(day.tasks)) return day.tasks.length;
  if (day.status === 'approved' || day.status === 'changed') return (day.approved_tasks || []).length;
  return (day.owner_tasks || []).length || null;
}
// "Crew NY: today Ana + Cy + Ben approved. Tomorrow draft, 2 questions."
// Names in task order, helpers by name, no _ * backtick or [.
export function crewDigestLine(market, todayDay, tomorrowDay, people) {
  const byId = new Map((people || []).map((p) => [idOf(p.person_id), p]));
  const nameOf = (pid) => personFirstName(byId.get(idOf(pid)));
  const clean =(s) => String(s).replace(/[_*`\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const tag = { ny: 'NY', vegas: 'Vegas', miami: 'Miami', la: 'LA' }[crewMarketKey(market)] || crewMarketKey(market).toUpperCase();
  const q = (n) => plural(n, 'question', 'questions');
  let todayPart;
  const tRows = crewDayRowCount(todayDay);
  if (!todayDay || tRows === 0) todayPart = 'today nothing planned';
  else if (todayDay.status === 'approved' || todayDay.status === 'changed') {
    const names = [];
    for (const t of todayDay.approved_tasks || []) for (const p of (t && t.people) || []) { const n = nameOf(p.person_id); if (n && !names.includes(n)) names.push(n); }
    todayPart = 'today ' + (names.length ? names.join(' + ') + ' ' : '') + 'approved' + (todayDay.status === 'changed' ? ', new plan waiting' : '');
  } else {
    const n = crewDayQuestions(todayDay);
    todayPart = 'today draft' + (n ? ', ' + q(n) : '');
  }
  let tomorrowPart;
  const mRows = crewDayRowCount(tomorrowDay);
  if (!tomorrowDay || mRows === 0) tomorrowPart = 'Tomorrow nothing planned.';
  else if (tomorrowDay.status === 'approved') tomorrowPart = 'Tomorrow approved.';
  else if (tomorrowDay.status === 'changed') tomorrowPart = 'Tomorrow approved, new plan waiting.';
  else {
    const n = crewDayQuestions(tomorrowDay);
    tomorrowPart = 'Tomorrow draft' + (n == null ? '' : n ? ', ' + q(n) : ', no questions') + '.';
  }
  return clean('Crew ' + tag + ': ' + todayPart + '. ' + tomorrowPart);
}
