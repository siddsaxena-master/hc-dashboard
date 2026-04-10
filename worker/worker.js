// Hamptons Coconuts — Telegram Dashboard Bot
// Cloudflare Worker that receives Telegram messages, uses Claude to parse intent,
// and reads/writes events in JSONBin (same data store as the web dashboard).

const JSONBIN_API = 'https://api.jsonbin.io/v3/b';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const TG_API = 'https://api.telegram.org/bot';

// ── SYSTEM PROMPT FOR CLAUDE ──
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

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Hamptons Coconuts Telegram Bot is running 🥥', { status: 200 });
    }

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

      // Handle /start command
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

      // Read current events from JSONBin
      const events = await readEvents(env);
      if (!events) {
        await sendTelegram(env.TG_BOT_TOKEN, chatId, '❌ Could not connect to dashboard data. Try again.');
        return ok();
      }

      // Build compressed events context for Claude
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
          Object.entries(claudeResp.params).forEach(([k, v]) => {
            events[idx][k] = v;
          });
          await writeEvents(env, events);
        }
      } else if (claudeResp.action === 'create' && claudeResp.params) {
        const newEvent = {
          id: 'ev_' + Date.now() + '_tg',
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
        events.push(newEvent);
        await writeEvents(env, events);
      } else if (claudeResp.action === 'delete' && claudeResp.eventId) {
        const filtered = events.filter(e => e.id !== claudeResp.eventId);
        if (filtered.length < events.length) {
          await writeEvents(env, filtered);
        }
      }

      // Send reply
      await sendTelegram(env.TG_BOT_TOKEN, chatId, claudeResp.reply || '✅ Done');
      return ok();

    } catch (err) {
      console.error('Worker error:', err);
      return ok(); // Always return 200 to Telegram
    }
  }
};

// ── HELPERS ──

function ok() {
  return new Response('ok', { status: 200 });
}

async function readEvents(env) {
  try {
    const resp = await fetch(`${JSONBIN_API}/${env.JSONBIN_BIN_ID}/latest`, {
      headers: { 'X-Master-Key': env.JSONBIN_MASTER_KEY }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.record?.events || [];
  } catch (e) {
    console.error('JSONBin read error:', e);
    return null;
  }
}

async function writeEvents(env, events) {
  try {
    const resp = await fetch(`${JSONBIN_API}/${env.JSONBIN_BIN_ID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': env.JSONBIN_MASTER_KEY,
      },
      body: JSON.stringify({ events }),
    });
    return resp.ok;
  } catch (e) {
    console.error('JSONBin write error:', e);
    return false;
  }
}

async function sendTelegram(token, chatId, text) {
  try {
    await fetch(`${TG_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
      }),
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
    // Extract JSON even if Claude wrapped it in text
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
