// Hamptons Coconuts — Telegram Dashboard Bot ("Claudia")
// Cloudflare Worker that receives Telegram messages, uses Claude to parse intent,
// and reads/writes events in Supabase orders (migrated from JSONBin 2026-05-13).

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const TG_API = 'https://api.telegram.org/bot';

// ── SYSTEM PROMPT FOR CLAUDE ──
// Uses the dashboard's UI vocabulary; the storage layer translates to Supabase values.
const SYSTEM_PROMPT = `You are Claudia, the Hamptons Coconuts dashboard assistant on Telegram. You manage events for a coconut catering business.

You will receive the user's message and a JSON list of current events. Respond with ONLY valid JSON (no markdown, no backticks):

{
  "action": "one of the actions below",
  "eventId": "event ID if applicable, or null",
  "params": { object of fields to update/create, or null },
  "reply": "friendly reply message to send back to the user (use Telegram markdown: *bold*, _italic_)"
}

ACTIONS:
- "none" — just reply (greetings, questions you can answer from context)
- "update" — update fields on an existing event. params = {field: value, ...}
- "create" — create a new event. params = full event object with at minimum {name, type:"event"}
- "delete" — delete an event. Always ask for confirmation first (action:"none" with a question). Only use action:"delete" if user already confirmed.
- "list" — just reply with a formatted list (no DB changes needed)

VALID STAGES: lead, deposit_paid, in_kind, stamp_ordered, payment_full, completed, passed
VALID STAMP_STATUS: "Not ordered", "Ordered — pending", "Received"
VALID MARKETS: ny, miami, other
EVENT FIELDS: name, venue, contact, email, phone, market, event_date (YYYY-MM-DD), event_end_date, coconuts, total_amount, deposit_amount, balance_amount, stamp_design, stamp_status, stage, delivery_date, delivery_time, delivery_notes, event_type, source, notes, pay_notes, coi_requested, logo_received

RULES:
- When user says "mark as paid" or "fully paid" → update stage to "payment_full"
- When user says "deposit paid" or "got the deposit" → update stage to "deposit_paid"
- When user says "stamp ordered" → update stamp_status to "Ordered — pending"
- When user says "stamp received" or "got the stamp" → update stamp_status to "Received"
- When searching for events, match flexibly on name, venue, or contact
- For dates, today is provided in the context. Use relative dates (this week = next 7 days)
- Keep replies concise and use emojis
- For money amounts, strip $ and commas before setting fields
- When creating events, always set type:"event", stage:"lead", stamp_status:"Not ordered"
- Use Telegram markdown in replies: *bold* for names, _italic_ for dates`;

// CORS headers for dashboard proxy calls
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── VOCAB MAPS (mirror of dashboard's maps; keep in sync) ──
const SB_STAGE_TO_UI = {'inquiry':'lead','quoted':'lead','invoiced':'deposit_paid','deposit_paid':'deposit_paid','paid_full':'payment_full','fulfilled':'completed','complete':'completed','cancelled':'passed'};
const UI_STAGE_TO_SB = {'lead':'inquiry','deposit_paid':'deposit_paid','stamp_ordered':'invoiced','in_kind':'complete','payment_full':'paid_full','completed':'complete','passed':'complete'};
const SB_ETYPE_TO_UI = {'wedding':'Wedding','corporate':'Corporate Event','trade_show':'Networking Event','hospitality':'Other','cruise':'Other','wellness':'Wellness Event','other':'Other'};
const UI_ETYPE_TO_SB = {'Wedding':'wedding','Corporate Event':'corporate','Wellness Event':'wellness','Birthday Party':'other','Holiday Party':'other','Networking Event':'trade_show','Product Launch':'corporate','Charity Event':'other','Bachelor/Bachelorette':'other','Other':'other'};
const SB_STAMP_TO_UI = {'not_ordered':'Not ordered','ordered':'Ordered — pending','received':'Received','not_needed':'Not ordered'};
const UI_STAMP_TO_SB = {'Not ordered':'not_ordered','Ordered — pending':'ordered','Received':'received'};
const SB_FREQ_TO_UI = {'weekly':'Weekly','biweekly':'Bi-weekly','monthly':'Monthly','quarterly':'Seasonal'};
const UI_FREQ_TO_SB = {'Weekly':'weekly','Bi-weekly':'biweekly','Monthly':'monthly','Seasonal':'quarterly'};
const SB_SOURCE_TO_UI = {'website':'Google Search','referral':'WeddingPro / The Knot','sales_engine':'Cold Email Outreach','direct':'Word of Mouth','recurring':'Other','other':'Other'};
const UI_SOURCE_TO_SB = {'Google Search':'website','Cold Email Outreach':'sales_engine','Referral — Event':'referral','Referral — Venue':'referral','WeddingPro / The Knot':'referral','Instagram / Social':'website','Word of Mouth':'direct','Telegram bot':'other','Other':'other'};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  // ── SCHEDULED (Cloudflare Cron Triggers) ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Hamptons Coconuts Telegram Bot is running 🥥', { status: 200 });
    }

    // Dashboard proxy endpoints
    if (url.pathname === '/parse-batch') return handleParseBatch(request, env);
    if (url.pathname === '/parse-file') return handleParseFile(request, env);

    // Inbound webhooks (lead sources, phone events, etc.)
    if (url.pathname === '/webhooks/formspree') return handleFormspreeWebhook(request, env);
    if (url.pathname === '/webhooks/quo') return handleQuoWebhook(request, env);
    if (url.pathname === '/webhooks/ms-graph') return handleMsGraphWebhook(request, env, url);

    try {
      const update = await request.json();
      const message = update.message;
      if (!message || !message.text) return ok();

      const chatId = String(message.chat.id);
      const allowed = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim());
      if (!allowed.includes(chatId)) {
        await sendTelegram(env.TG_BOT_TOKEN, chatId, '⛔ Access denied. Your chat ID: `' + chatId + '`');
        return ok();
      }

      const userText = message.text.trim();

      if (userText === '/start') {
        await sendTelegram(env.TG_BOT_TOKEN, chatId,
          '🥥 *Hey! I\'m Claudia, your Hamptons Coconuts assistant.*\n\n' +
          'I can help you manage your dashboard. Try:\n' +
          '• "What events are coming up?"\n' +
          '• "Mark Steven Filippi as fully paid"\n' +
          '• "Add new event: John Smith, wedding, June 15, 100 coconuts"\n' +
          '• "Who needs stamps ordered?"\n' +
          '• "Give me a summary"\n\n' +
          'Just tell me what you need! 💬'
        );
        return ok();
      }

      // Read current events from Supabase
      const events = await readEvents(env);
      if (!events) {
        await sendTelegram(env.TG_BOT_TOKEN, chatId, '❌ Could not connect to Supabase. Try again.');
        return ok();
      }

      // Build compressed events context for Claude (UI vocabulary)
      const today = new Date().toISOString().split('T')[0];
      const evContext = events.map(e => ({
        id: e.id,
        name: e.name || '',
        type: e.type || 'event',
        stage: e.stage || 'lead',
        market: e.market || '',
        event_date: e.event_date || '',
        event_end_date: e.event_end_date || '',
        coconuts: e.coconuts || '',
        total_amount: e.total_amount || '',
        deposit_amount: e.deposit_amount || '',
        balance_amount: e.balance_amount || '',
        stamp_status: e.stamp_status || '',
        stamp_design: e.stamp_design || '',
        venue: e.venue || '',
        contact: e.contact || '',
        delivery_date: e.delivery_date || '',
        notes: (e.notes || '').slice(0, 80),
        source: e.source || '',
      }));

      // Call Claude
      const claudeResp = await callClaude(env.ANTHROPIC_API_KEY, userText, evContext, today);
      if (!claudeResp || claudeResp.error) {
        const errMsg = claudeResp?.error || 'Unknown error';
        await sendTelegram(env.TG_BOT_TOKEN, chatId, '❌ AI error: ' + errMsg);
        return ok();
      }

      // Execute action
      if (claudeResp.action === 'update' && claudeResp.eventId && claudeResp.params) {
        const idx = events.findIndex(e => e.id === claudeResp.eventId);
        if (idx >= 0) {
          Object.entries(claudeResp.params).forEach(([k, v]) => { events[idx][k] = v; });
          await updateEvent(env, events[idx]);
        }
      } else if (claudeResp.action === 'create' && claudeResp.params) {
        const newEvent = {
          id: crypto.randomUUID(),
          type: 'event',
          stage: 'lead',
          stamp_status: 'Not ordered',
          source: 'Telegram bot',
          followup_added: today,
          logo_received: '', logo_data_url: '', coi_requested: false,
          crack_straw: '', crack_circle: '', crack_whole: '',
          pre_tax_amount: '', tax_amount: '',
          pay_notes: '', invoice_name: '', invoice_url: '',
          debrief_issues: '', debrief_next: '', debrief_rating: '',
          cost_per_box: '', cost_labor: '', cost_other: '',
          frequency: '', next_order_date: '', order_time: '', venue_type: '',
          name: '', venue: '', contact: '', email: '', phone: '',
          market: '', event_date: '', event_end_date: '',
          coconuts: '', total_amount: '', deposit_amount: '', balance_amount: '',
          stamp_design: '', delivery_date: '', delivery_time: '', delivery_notes: '',
          event_type: '', notes: '',
          ...claudeResp.params,
        };
        await insertEvent(env, newEvent);
      } else if (claudeResp.action === 'delete' && claudeResp.eventId) {
        await deleteEvent(env, claudeResp.eventId);
      }

      await sendTelegram(env.TG_BOT_TOKEN, chatId, claudeResp.reply || '✅ Done');
      return ok();

    } catch (err) {
      console.error('Worker error:', err);
      return ok();
    }
  }
};

// ── SUPABASE STORAGE LAYER ──

function sbHeaders(env, extras = {}) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
    ...extras,
  };
}

function supabaseRowToEvent(o) {
  const dateOnly = (ts) => ts ? ts.split('T')[0] : '';
  const dollars = (cents) => (cents !== null && cents !== undefined) ? (cents / 100).toString() : '';
  const qty = o.coconuts_qty ? o.coconuts_qty.toString() : '';
  return {
    id: o.id,
    type: o.is_recurring ? 'recurring' : 'event',
    name: o.client_name || '',
    venue: o.venue || '',
    contact: o.client_name || '',
    email: o.client_email || '',
    phone: o.client_phone || '',
    market: o.market || '',
    coi_requested: !!o.coi_required,
    source: SB_SOURCE_TO_UI[o.source] || '',
    venue_type: o.venue_type || '',
    event_type: SB_ETYPE_TO_UI[o.event_type] || '',
    event_date: dateOnly(o.event_start_at),
    event_end_date: dateOnly(o.event_end_at),
    next_order_date: o.next_order_date || '',
    frequency: SB_FREQ_TO_UI[o.frequency] || '',
    coconuts: qty,
    crack_straw: o.crack_type === 'straw' ? qty : '',
    crack_circle: o.crack_type === 'circle' ? qty : '',
    crack_whole: o.crack_type === 'whole' ? qty : '',
    stamp_design: o.stamp_design || '',
    stamp_status: SB_STAMP_TO_UI[o.stamp_status] || '',
    logo_received: o.logo_received ? 'Yes' : '',
    stage: SB_STAGE_TO_UI[o.stage] || 'lead',
    pre_tax_amount: dollars(o.pre_tax_cents),
    tax_amount: dollars(o.tax_cents),
    total_amount: dollars(o.total_cents),
    deposit_amount: dollars(o.deposit_cents),
    balance_amount: dollars(o.balance_cents),
    pay_notes: o.pay_notes || '',
    delivery_date: dateOnly(o.delivery_at_utc),
    delivery_notes: o.delivery_notes || '',
    invoice_url: o.external_invoice_url || '',
    notes: o.notes || '',
  };
}

function eventToSupabaseRow(e) {
  const ts = (d) => d ? d + 'T12:00:00Z' : null;
  const cents = (s) => { const n = parseFloat(s); return isNaN(n) ? null : Math.round(n * 100); };
  const row = {
    client_name: e.name || 'Unnamed',
    client_email: e.email || null,
    client_phone: e.phone || null,
    venue: e.venue || null,
    venue_type: e.venue_type || null,
    event_type: e.event_type ? (UI_ETYPE_TO_SB[e.event_type] || 'other') : null,
    event_start_at: ts(e.event_date),
    event_end_at: ts(e.event_end_date),
    event_tz: 'America/New_York',
    coconuts_qty: parseInt(e.coconuts) || null,
    crack_type: e.crack_whole ? 'whole' : (e.crack_circle ? 'circle' : (e.crack_straw ? 'straw' : null)),
    stamp_design: e.stamp_design || null,
    stamp_status: UI_STAMP_TO_SB[e.stamp_status] || 'not_ordered',
    logo_received: e.logo_received === 'Yes',
    pre_tax_cents: cents(e.pre_tax_amount),
    tax_cents: cents(e.tax_amount),
    total_cents: cents(e.total_amount),
    deposit_cents: cents(e.deposit_amount) ?? 0,
    balance_cents: cents(e.balance_amount),
    pay_notes: e.pay_notes || null,
    external_invoice_url: e.invoice_url || null,
    stage: UI_STAGE_TO_SB[e.stage] || 'inquiry',
    market: e.market || null,
    source: e.source ? (UI_SOURCE_TO_SB[e.source] || 'other') : null,
    delivery_at_utc: ts(e.delivery_date),
    delivery_notes: e.delivery_notes || null,
    coi_required: !!e.coi_requested,
    is_recurring: e.type === 'recurring',
    frequency: e.frequency ? (UI_FREQ_TO_SB[e.frequency] || null) : null,
    next_order_date: e.next_order_date || null,
    notes: e.notes || null,
  };
  if (UUID_RE.test(e.id || '')) row.id = e.id;
  return row;
}

async function readEvents(env) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/orders?select=*', {
      headers: sbHeaders(env),
    });
    if (!resp.ok) {
      console.error('Supabase read error:', resp.status, await resp.text());
      return null;
    }
    const rows = await resp.json();
    return Array.isArray(rows) ? rows.map(supabaseRowToEvent) : [];
  } catch (e) {
    console.error('Supabase read exception:', e);
    return null;
  }
}

async function insertEvent(env, event) {
  try {
    const row = eventToSupabaseRow(event);
    // Ensure new event has a UUID
    if (!row.id) row.id = crypto.randomUUID();
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/orders', {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(row),
    });
    if (!resp.ok) {
      console.error('Supabase insert error:', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Supabase insert exception:', e);
    return false;
  }
}

async function updateEvent(env, event) {
  if (!UUID_RE.test(event.id || '')) {
    console.error('updateEvent: invalid UUID', event.id);
    return false;
  }
  try {
    const row = eventToSupabaseRow(event);
    delete row.id; // Don't send id in body for PATCH; it's in the URL
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/orders?id=eq.' + event.id, {
      method: 'PATCH',
      headers: sbHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(row),
    });
    if (!resp.ok) {
      console.error('Supabase update error:', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Supabase update exception:', e);
    return false;
  }
}

async function deleteEvent(env, eventId) {
  if (!UUID_RE.test(eventId || '')) {
    console.error('deleteEvent: invalid UUID', eventId);
    return false;
  }
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/orders?id=eq.' + eventId, {
      method: 'DELETE',
      headers: sbHeaders(env),
    });
    if (!resp.ok) {
      console.error('Supabase delete error:', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Supabase delete exception:', e);
    return false;
  }
}

// ── TELEGRAM + CLAUDE HELPERS ──

function ok() {
  return new Response('ok', { status: 200 });
}

async function sendTelegram(token, chatId, text) {
  try {
    await fetch(`${TG_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' }),
    });
  } catch (e) {
    console.error('Telegram send error:', e);
  }
}

async function callClaude(apiKey, userMessage, eventsContext, today) {
  try {
    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Today: ${today}\n\nCurrent events (${eventsContext.length} total):\n${JSON.stringify(eventsContext)}\n\nUser message: ${userMessage}`
        }],
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      console.error('Claude API error:', resp.status, raw);
      return { error: `HTTP ${resp.status}: ${raw.slice(0, 200)}` };
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (e) { return { error: 'Invalid API response: ' + raw.slice(0, 150) }; }
    const txt = data.content?.find(c => c.type === 'text')?.text || '';
    if (!txt) return { error: 'Empty response from Claude' };
    const cleaned = txt.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: 'No JSON found: ' + cleaned.slice(0, 150) };
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      return { error: 'JSON parse failed: ' + cleaned.slice(0, 150) };
    }
  } catch (e) {
    console.error('Claude call error:', e);
    return { error: 'Network/fetch error: ' + e.message };
  }
}

// ── DASHBOARD PROXY HANDLERS (unchanged) ──

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleParseBatch(request, env) {
  try {
    const body = await request.json();
    const { systemPrompt, messages, maxTokens } = body;
    if (!messages || !Array.isArray(messages)) {
      return jsonResponse({ error: 'Missing messages array' }, 400);
    }
    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens || 1200,
        system: systemPrompt || '',
        messages,
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      return jsonResponse({ error: `Claude HTTP ${resp.status}: ${raw.slice(0, 200)}` }, 500);
    }
    const data = JSON.parse(raw);
    const txt = data.content?.find(c => c.type === 'text')?.text || '';
    return jsonResponse({ text: txt });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ── SCHEDULED JOBS ──

// Cron schedule (in wrangler.toml [triggers]):
//   "0 12 * * *"  — daily 8am ET (12 UTC) — Weee box math digest
//   "0 * * * *"   — hourly — reconfirmation scan + post-event debrief scan
async function runScheduled(event, env, alsoNotify = true) {
  const cron = event.cron;
  try {
    if (cron === '0 12 * * *') {
      await runDailyDigest(env);
    } else if (cron === '0 * * * *') {
      await runReconfirmationScan(env);
      await runDebriefScan(env);
    }
  } catch (e) {
    console.error('runScheduled error:', e);
    if (alsoNotify) {
      const chatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const cid of chatIds) {
        await sendTelegram(env.TG_BOT_TOKEN, cid, '⚠️ Scheduled job failed (' + cron + '): ' + e.message);
      }
    }
  }
}

// Daily 8am ET — compute Weee coconut orders for the next 5 days
async function runDailyDigest(env) {
  const today = new Date();
  const horizon = new Date(today.getTime() + 5 * 86400000);
  const todayStr = today.toISOString().slice(0, 10);
  const horizonStr = horizon.toISOString().slice(0, 10);

  const resp = await fetch(
    env.SUPABASE_URL +
      '/rest/v1/orders?select=client_name,event_start_at,coconuts_qty,market,delivery_at_utc' +
      '&event_start_at=gte.' + todayStr +
      '&event_start_at=lte.' + horizonStr +
      '&stage=in.(deposit_paid,invoiced,paid_full)' +
      '&order=event_start_at.asc',
    { headers: sbHeaders(env) }
  );
  if (!resp.ok) throw new Error('Daily digest fetch failed: ' + resp.status);
  const rows = await resp.json();

  // Group by date and market
  const byDay = {};
  rows.forEach(r => {
    const d = (r.event_start_at || '').slice(0, 10);
    if (!d) return;
    const m = r.market || 'ny';
    const key = d + '|' + m;
    byDay[key] = byDay[key] || { date: d, market: m, events: [], coconuts: 0 };
    byDay[key].events.push(r);
    byDay[key].coconuts += (r.coconuts_qty || 0);
  });

  const lines = ['🥥 *Daily Weee Order Digest*', '_Events in the next 5 days_', ''];
  if (rows.length === 0) {
    lines.push('No upcoming committed events in the next 5 days.');
  } else {
    Object.values(byDay)
      .sort((a, b) => (a.date + a.market).localeCompare(b.date + b.market))
      .forEach(g => {
        const boxes = Math.ceil(g.coconuts / 9);  // Weee sells 9-coconut boxes
        lines.push('*' + g.date + '* — ' + g.market.toUpperCase() + ' — ' + g.coconuts + ' coconuts (≈ ' + boxes + ' boxes)');
        g.events.forEach(e => {
          lines.push('  • ' + (e.client_name || 'Unnamed') + ' — ' + (e.coconuts_qty || 0));
        });
        lines.push('');
      });
    lines.push('Weee caps per account — split across accounts and confirm fresh stock before ordering.');
  }

  const chatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const cid of chatIds) {
    await sendTelegram(env.TG_BOT_TOKEN, cid, lines.join('\n'));
  }
}

// Hourly — find events ~1 week out and draft a reconfirmation
async function runReconfirmationScan(env) {
  const target = new Date(Date.now() + 7 * 86400000);
  const dayStr = target.toISOString().slice(0, 10);

  const resp = await fetch(
    env.SUPABASE_URL +
      '/rest/v1/orders?select=id,client_name,client_email,event_start_at,venue,coconuts_qty,total_cents,stage' +
      '&event_start_at=gte.' + dayStr + 'T00:00:00Z' +
      '&event_start_at=lt.' + dayStr + 'T23:59:59Z' +
      '&stage=in.(deposit_paid,invoiced,paid_full)',
    { headers: sbHeaders(env) }
  );
  if (!resp.ok) return;
  const rows = await resp.json();
  if (!rows.length) return;

  const chatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const r of rows) {
    const lines = [
      '📩 *Reconfirmation Draft* (event in 7 days)',
      '',
      '*' + (r.client_name || 'Unnamed') + '*',
      '_' + (r.event_start_at || '').slice(0, 10) + '_',
      r.venue ? '📍 ' + r.venue : '',
      r.coconuts_qty ? '🥥 ' + r.coconuts_qty + ' coconuts' : '',
      '',
      'Draft email:',
      '> Hi ' + (r.client_name || '').split(' ')[0] + ', wanted to confirm everything for next week\'s event. Final headcount, delivery window, and stamp design all locked in?',
      '',
      'Reply *send* in Telegram to send (manual for now).',
    ].filter(Boolean);
    for (const cid of chatIds) {
      await sendTelegram(env.TG_BOT_TOKEN, cid, lines.join('\n'));
    }
  }
}

// Hourly — find events whose delivery was 4-5 hours ago and prompt for debrief
async function runDebriefScan(env) {
  const fourHoursAgo = new Date(Date.now() - 4 * 3600000);
  const fiveHoursAgo = new Date(Date.now() - 5 * 3600000);

  const resp = await fetch(
    env.SUPABASE_URL +
      '/rest/v1/orders?select=id,client_name,venue,coconuts_qty,delivery_at_utc' +
      '&delivery_at_utc=gte.' + fiveHoursAgo.toISOString() +
      '&delivery_at_utc=lt.' + fourHoursAgo.toISOString(),
    { headers: sbHeaders(env) }
  );
  if (!resp.ok) return;
  const rows = await resp.json();
  if (!rows.length) return;

  const issues = [
    'Stamp size incorrect', 'Stamp arrived late', 'Logo PNG not received in time',
    'No customer phone number', 'No walk-in cooler at venue',
    'Delivery window miscommunication', 'Wrong coconut quantity',
    'Cracking breakdown error', 'Late delivery', 'Venue access issues',
    'Payment collected late', 'Customer hard to reach',
    'Coconuts not fresh enough', 'Packaging issue',
  ];

  const chatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const r of rows) {
    const lines = [
      '📝 *Post-event debrief* (delivery ~4h ago)',
      '',
      '*' + (r.client_name || 'Unnamed') + '*',
      r.venue ? '📍 ' + r.venue : '',
      r.coconuts_qty ? '🥥 ' + r.coconuts_qty + ' coconuts' : '',
      '',
      'Any issues? Reply with numbers (e.g., "1, 7"):',
      ...issues.map((iss, i) => `${i + 1}. ${iss}`),
      '',
      'Rating: 1=Flawless 2=Good 3=OK 4=Rough 5=Major',
    ].filter(Boolean);
    for (const cid of chatIds) {
      await sendTelegram(env.TG_BOT_TOKEN, cid, lines.join('\n'));
    }
  }
}

// ── INBOUND WEBHOOK HANDLERS ──

const FORMSPREE_EXTRACTION_PROMPT = `You receive a JSON object from a Formspree contact form for Hamptons Coconuts (a premium coconut catering business).

Extract structured booking info. Respond with ONLY valid JSON, no markdown:
{
  "client_name": "best guess at customer's name",
  "client_email": "email or null",
  "client_phone": "phone in original format or null",
  "company": "company name if mentioned, else null",
  "event_type": "wedding | corporate | wellness | other",
  "event_date": "YYYY-MM-DD if mentioned, else null",
  "headcount": "number if mentioned, else null",
  "venue": "venue name if mentioned, else null",
  "market": "ny | miami | other",
  "notes": "any other useful context the operator should see",
  "summary": "one-sentence summary for Telegram alert"
}`;

async function handleFormspreeWebhook(request, env) {
  try {
    const body = await request.json();

    // Step 1: ask Claude to extract structured fields
    const extractResp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: FORMSPREE_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: 'Form submission:\n' + JSON.stringify(body, null, 2) }],
      }),
    });
    if (!extractResp.ok) {
      console.error('Claude extract failed:', extractResp.status);
      return jsonResponse({ ok: false, error: 'extraction failed' }, 200);
    }
    const extractData = await extractResp.json();
    const txt = extractData.content?.find(c => c.type === 'text')?.text || '{}';
    const cleaned = txt.replace(/```json|```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    let extracted = {};
    try { extracted = m ? JSON.parse(m[0]) : {}; } catch (e) { extracted = {}; }

    // Step 2: insert into orders as a new lead
    const newId = crypto.randomUUID();
    const orderRow = {
      id: newId,
      client_name: extracted.client_name || body.name || 'Unknown',
      client_email: extracted.client_email || body.email || null,
      client_phone: extracted.client_phone || body.phone || null,
      company: extracted.company || null,
      event_type: ['wedding','corporate','trade_show','hospitality','cruise','wellness','other'].includes(extracted.event_type) ? extracted.event_type : 'other',
      event_start_at: extracted.event_date ? extracted.event_date + 'T12:00:00Z' : null,
      event_tz: 'America/New_York',
      headcount: parseInt(extracted.headcount) || null,
      venue: extracted.venue || null,
      market: ['ny','miami','other'].includes(extracted.market) ? extracted.market : 'ny',
      stage: 'inquiry',
      source: 'website',
      notes: extracted.notes || JSON.stringify(body).slice(0, 500),
      stamp_status: 'not_ordered',
      logo_received: false,
      deposit_cents: 0,
      coi_required: false,
      coi_submitted: false,
      is_recurring: false,
    };
    const insertResp = await fetch(env.SUPABASE_URL + '/rest/v1/orders', {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(orderRow),
    });
    if (!insertResp.ok) {
      console.error('Formspree insert failed:', insertResp.status, await insertResp.text());
    }

    // Step 3: Telegram alert
    const chatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const alertText = '🌐 *New website lead* (Formspree)\n\n' +
      '*' + (orderRow.client_name) + '*' +
      (orderRow.client_email ? '\n📧 ' + orderRow.client_email : '') +
      (orderRow.client_phone ? '\n📞 ' + orderRow.client_phone : '') +
      (orderRow.event_start_at ? '\n📅 _' + orderRow.event_start_at.split('T')[0] + '_' : '') +
      (orderRow.headcount ? '\n👥 ' + orderRow.headcount + ' guests' : '') +
      (orderRow.venue ? '\n📍 ' + orderRow.venue : '') +
      '\n\n' + (extracted.summary || 'Open dashboard to review.');
    for (const cid of chatIds) {
      await sendTelegram(env.TG_BOT_TOKEN, cid, alertText);
    }

    return jsonResponse({ ok: true, order_id: newId });
  } catch (e) {
    console.error('Formspree webhook error:', e);
    return jsonResponse({ ok: false, error: e.message }, 200);
  }
}

const QUO_EXTRACTION_PROMPT = `You receive a webhook payload from Quo (phone system: SMS, voicemail, call events).

Classify the inbound event for Hamptons Coconuts (premium coconut catering). Respond with ONLY valid JSON:
{
  "kind": "inbound_sms | inbound_call | inbound_voicemail | outbound_log | other",
  "from_number": "caller phone number or null",
  "body_text": "message text or voicemail transcript or null",
  "is_lead": true/false,
  "lead_name": "name if discernible, else null",
  "lead_intent": "short summary of what they want, or null",
  "summary": "one-sentence summary for Telegram alert"
}`;

async function handleQuoWebhook(request, env) {
  try {
    const body = await request.json();

    // Step 1: classify with Claude
    const cResp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: QUO_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: 'Quo webhook payload:\n' + JSON.stringify(body, null, 2) }],
      }),
    });
    let extracted = {};
    if (cResp.ok) {
      const d = await cResp.json();
      const txt = d.content?.find(c => c.type === 'text')?.text || '{}';
      const cleaned = txt.replace(/```json|```/g, '').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      try { extracted = m ? JSON.parse(m[0]) : {}; } catch (e) {}
    }

    // Step 2: if lead, insert order row
    if (extracted.is_lead && extracted.lead_name) {
      const orderRow = {
        id: crypto.randomUUID(),
        client_name: extracted.lead_name,
        client_phone: extracted.from_number || null,
        stage: 'inquiry',
        source: 'direct',  // phone inquiry
        market: 'ny',
        notes: (extracted.lead_intent || '') + '\n\n' + (extracted.body_text || ''),
        stamp_status: 'not_ordered',
        logo_received: false,
        deposit_cents: 0,
        coi_required: false,
        coi_submitted: false,
        is_recurring: false,
      };
      await fetch(env.SUPABASE_URL + '/rest/v1/orders', {
        method: 'POST',
        headers: sbHeaders(env, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(orderRow),
      });
    }

    // Step 3: Telegram alert (always notify Sidd of inbound activity)
    const chatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const kindEmoji = {
      inbound_sms: '💬',
      inbound_call: '📞',
      inbound_voicemail: '🎙️',
      outbound_log: '➡️',
      other: '📡',
    }[extracted.kind] || '📡';
    const alertText = kindEmoji + ' *Quo: ' + (extracted.kind || 'unknown') + '*\n\n' +
      (extracted.from_number ? '*From:* ' + extracted.from_number + '\n' : '') +
      (extracted.body_text ? '\n' + extracted.body_text.slice(0, 400) + '\n' : '') +
      '\n' + (extracted.summary || '');
    for (const cid of chatIds) {
      await sendTelegram(env.TG_BOT_TOKEN, cid, alertText);
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    console.error('Quo webhook error:', e);
    return jsonResponse({ ok: false, error: e.message }, 200);
  }
}

const MS_GRAPH_CLASSIFIER_PROMPT = `You receive an email payload fetched from Microsoft Graph (Outlook / Microsoft 365). The mailbox is operated by Hamptons Coconuts, a premium coconut catering business.

Classify the email. Respond with ONLY valid JSON:
{
  "category": "lead_inquiry | customer_reply | vendor | noise",
  "from_email": "sender email or null",
  "from_name": "sender name or null",
  "subject": "subject line",
  "summary": "1-sentence summary for Telegram alert",
  "should_alert": true/false,
  "extracted_lead": null OR {
    "client_name": "...",
    "client_email": "...",
    "client_phone": "... or null",
    "event_type": "wedding|corporate|wellness|other",
    "event_date": "YYYY-MM-DD or null",
    "headcount": number or null,
    "venue": "venue or null",
    "market": "ny|miami|other",
    "notes": "context"
  }
}

Rules:
- "noise" = marketing emails, newsletters, automated noise (e.g. Weee promotional). should_alert = false.
- "vendor" = supplier comms (Weee, stamp vendor, etc.). should_alert = true (Sidd wants to know).
- "customer_reply" = email from someone already in the system. should_alert = true. extracted_lead = null.
- "lead_inquiry" = NEW inquiry asking about pricing, availability, booking. should_alert = true. fill extracted_lead.`;

async function handleMsGraphWebhook(request, env, url) {
  // Microsoft Graph subscriptions send a validationToken on creation; echo it back.
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  try {
    const body = await request.json();
    // Graph batches notifications under body.value
    const notifications = body.value || [body];

    for (const n of notifications) {
      // Each notification has a resource URL (the email). For now we expect the
      // caller (or a future step) to also POST the full email payload under
      // n.resourceData or we'd fetch it via Graph here. Stub: classify the
      // notification payload directly.
      const cResp = await fetch(CLAUDE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          system: MS_GRAPH_CLASSIFIER_PROMPT,
          messages: [{ role: 'user', content: 'Graph notification:\n' + JSON.stringify(n, null, 2) }],
        }),
      });
      if (!cResp.ok) continue;
      const d = await cResp.json();
      const txt = d.content?.find(c => c.type === 'text')?.text || '{}';
      const cleaned = txt.replace(/```json|```/g, '').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      let cls = {};
      try { cls = m ? JSON.parse(m[0]) : {}; } catch (e) {}

      // If classified as lead_inquiry, insert orders row
      if (cls.category === 'lead_inquiry' && cls.extracted_lead) {
        const e = cls.extracted_lead;
        const orderRow = {
          id: crypto.randomUUID(),
          client_name: e.client_name || 'Unknown',
          client_email: e.client_email || cls.from_email || null,
          client_phone: e.client_phone || null,
          event_type: ['wedding','corporate','trade_show','hospitality','cruise','wellness','other'].includes(e.event_type) ? e.event_type : 'other',
          event_start_at: e.event_date ? e.event_date + 'T12:00:00Z' : null,
          event_tz: 'America/New_York',
          headcount: parseInt(e.headcount) || null,
          venue: e.venue || null,
          market: ['ny','miami','other'].includes(e.market) ? e.market : 'ny',
          stage: 'inquiry',
          source: 'website',
          notes: 'Email lead via MS Graph: ' + (cls.subject || '') + '\n\n' + (e.notes || ''),
          stamp_status: 'not_ordered',
          logo_received: false,
          deposit_cents: 0,
          coi_required: false,
          coi_submitted: false,
          is_recurring: false,
        };
        await fetch(env.SUPABASE_URL + '/rest/v1/orders', {
          method: 'POST',
          headers: sbHeaders(env, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(orderRow),
        });
      }

      // Telegram alert if should_alert
      if (cls.should_alert) {
        const emoji = { lead_inquiry: '🌱', customer_reply: '💬', vendor: '📦', noise: '🗑️' }[cls.category] || '📧';
        const text = emoji + ' *Email: ' + (cls.category || 'unknown') + '*\n' +
          '*From:* ' + (cls.from_name || cls.from_email || 'unknown') + '\n' +
          '*Subject:* ' + (cls.subject || '') + '\n\n' +
          (cls.summary || '');
        const chatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const cid of chatIds) {
          await sendTelegram(env.TG_BOT_TOKEN, cid, text);
        }
      }
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    console.error('MS Graph webhook error:', e);
    return jsonResponse({ ok: false, error: e.message }, 200);
  }
}

async function handleParseFile(request, env) {
  try {
    const body = await request.json();
    const { systemPrompt, contentBlocks, maxTokens } = body;
    if (!contentBlocks || !Array.isArray(contentBlocks)) {
      return jsonResponse({ error: 'Missing contentBlocks' }, 400);
    }
    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens || 1000,
        system: systemPrompt || '',
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      return jsonResponse({ error: `Claude HTTP ${resp.status}: ${raw.slice(0, 200)}` }, 500);
    }
    const data = JSON.parse(raw);
    const txt = data.content?.find(c => c.type === 'text')?.text || '';
    return jsonResponse({ text: txt });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
