// server.js — Node 18+, ESM. Phone pickup orders that SHOW in Square by recording an EXTERNAL payment.

import express from 'express';
import crypto from 'crypto';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// ---- Env & Square base ----
const ENV = (process.env.SQUARE_ENV || process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
const BASE = ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID  || '';
const INBOUND_KEY  = process.env.INBOUND_API_KEY || process.env.VAPI_INBOUND_KEY || '';
const MARK_PAID    = String(process.env.MARK_PAID || '1') === '1';  // set 0 to skip payment in dev

const SQ_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Square-Version': '2024-09-19',
  'Authorization': `Bearer ${ACCESS_TOKEN}`,
};

const okCfg = () => !!(ACCESS_TOKEN && LOCATION_ID);
const norm = (s='') => String(s).toLowerCase().trim();
const baseWord = (s='') => norm(s).replace(/^(extra|add|light|no|without|with)\s+/, '');

// ---- Health ----
app.get('/healthz', (_req, res) => res.json({
  ok: true, env: ENV,
  hasAccessToken: !!ACCESS_TOKEN,
  hasLocation: !!LOCATION_ID
}));

// Self-check that calls Square and confirms location exists
app.get('/selfcheck', async (_req, res) => {
  try {
    if (!okCfg()) return res.status(500).json({ ok: false, error: 'Square credentials not configured' });
    const r = await fetch(`${BASE}/v2/locations`, { headers: SQ_HEADERS });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: j });
    const loc = (j.locations || []).find(l => l.id === LOCATION_ID);
    res.json({ ok: !!loc, locationName: loc?.name || null, env: ENV });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Inbound gate (shared secret from VAPI) ----
app.use((req, res, next) => {
  const auth = req.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  const key = bearer || req.get('x-inbound-api-key') || req.get('x-api-key');
  if (!INBOUND_KEY || key !== INBOUND_KEY) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
});

// ---- Synonyms (kept tight) ----
const SYNONYMS = [
  { test: /^cheeseburger$/i, base: 'Burger', addMods: ['add cheese'] },
  { test: /^hamburger$/i,    base: 'Burger', addMods: [] },
  { test: /^pop$/i,          base: 'Soda',   addMods: [] },
  { test: /^coke$/i,         base: 'Soda',   addMods: [], hint: 'coke' },
  { test: /^sprite$/i,       base: 'Soda',   addMods: [], hint: 'sprite' },
];
const applySynonym = (name) => {
  const n = String(name || '').trim();
  for (const s of SYNONYMS) if (s.test.test(n)) return s;
  return null;
};

// ---- Catalog cache (ITEM, VARIATION, MODIFIER_LIST, MODIFIER) ----
const TTL = 300_000; // 5 minutes
let cache = { at: 0, items: null, itemAllowedMods: null, refreshing: null };

async function fetchCatalog() {
  const now = Date.now();
  if (cache.items && cache.itemAllowedMods && now - cache.at < TTL) return cache;

  const objs = [];
  let cursor = null;
  do {
    const url = `${BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION,MODIFIER_LIST,MODIFIER` +
                (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await fetch(url, { headers: SQ_HEADERS });
    const json = await r.json();
    if (!r.ok) throw new Error(`catalog list ${r.status}: ${JSON.stringify(json)}`);
    if (json.objects?.length) objs.push(...json.objects);
    cursor = json.cursor || null;
  } while (cursor);

  const itemsById = new Map();
  const itemNameById = new Map();
  const variations = [];
  const modifierLists = new Map();
  const modifiersByList = new Map();

  for (const o of objs) {
    if (o.type === 'ITEM') {
      itemsById.set(o.id, o);
      itemNameById.set(o.id, o.item_data?.name || '');
    } else if (o.type === 'ITEM_VARIATION') {
      variations.push(o);
    } else if (o.type === 'MODIFIER_LIST') {
      modifierLists.set(o.id, { name: o.modifier_list_data?.name || '', modifiers: [] });
    }
  }
  for (const o of objs) {
    if (o.type === 'MODIFIER') {
      const listId = o.modifier_data?.modifier_list_id;
      if (!listId) continue;
      const m = { id: o.id, name: o.modifier_data?.name || '' };
      const arr = modifiersByList.get(listId) || [];
      arr.push(m);
      modifiersByList.set(listId, arr);
    }
  }
  for (const [listId, mods] of modifiersByList) {
    if (modifierLists.has(listId)) modifierLists.get(listId).modifiers = mods;
  }

  const itemsOut = [];
  const itemAllowedMods = new Map(); // itemId -> Map(keyword -> {id,name})

  for (const v of variations) {
    const vd = v.item_variation_data || {};
    const itemId = vd.item_id;
    const baseName = itemNameById.get(itemId);
    const varName  = vd.name || 'Regular';
    const cents    = vd.price_money?.amount;
    if (!baseName || cents == null) continue;

    itemsOut.push({
      itemId,
      name: baseName,
      variationId: v.id,
      priceCents: cents,
      price: (cents / 100).toFixed(2),
      label: `${baseName} - ${varName}`
    });

    const item = itemsById.get(itemId);
    const listInfo = item?.item_data?.modifier_list_info || [];
    const modMap = itemAllowedMods.get(itemId) || new Map();
    for (const li of listInfo) {
      const listId = li.modifier_list_id;
      const list = modifierLists.get(listId);
      if (!list) continue;
      for (const m of list.modifiers) {
        const n = norm(m.name);
        const val = { id: m.id, name: m.name };
        modMap.set(n, val);
        modMap.set(baseWord(n), val);
      }
    }
    if (modMap.size) itemAllowedMods.set(itemId, modMap);
  }

  itemsOut.sort((a, b) => a.label.localeCompare(b.label));
  cache = { at: Date.now(), items: itemsOut, itemAllowedMods, refreshing: null };
  return cache;
}

// ---- Helpers for human summary ----
const NUM_WORD = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
const toWord = (n) => (n>=0 && n<=10) ? NUM_WORD[n] : String(n);

function varToFront(label) {
  const [base, v] = String(label).split(' - ');
  if (!v) return base;
  return `${norm(v).replace(/\bregular\b/,'regular')} ${norm(base)}`.replace(/\s+/g,' ').trim();
}
function joinList(arr) {
  if (!arr.length) return '';
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0,-1).join(', ')} and ${arr[arr.length-1]}`;
}

// ---- GET /api/items ----
async function getMenuHandler(_req, res) {
  try {
    if (!okCfg()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });
    const { items } = await fetchCatalog();
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
}
app.get('/api/items', getMenuHandler);

// ---- POST /api/create-order ----
async function createOrderHandler(req, res) {
  try {
    if (!okCfg()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });

    let items = req.body.items_json;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, error: 'items_json must be a non-empty array' });

    const customer_name  = req.body.customer_name || 'Guest';
    const customer_phone = req.body.customer_phone || undefined;
    const order_notes    = req.body.notes || undefined;
    const pickup_at      = req.body.pickup_at || undefined;

    const { items: menu, itemAllowedMods } = await fetchCatalog();
    const byId   = new Map(menu.map(m => [m.variationId, m]));

    const line_items = [];
    const speak_chunks = [];

    for (const it of items) {
      const qty = Number(it.quantity ?? 1);
      let reqName = it.name || it.label || '';
      let extraMods = [];
      let hint = undefined;
      const syn = applySynonym(reqName);
      if (syn) { reqName = syn.base; extraMods = syn.addMods || []; hint = syn.hint; }

      // Resolve variation
      let chosen = null;
      if (it.variationId) {
        chosen = byId.get(it.variationId) || null;
      } else {
        const q = norm(reqName);
        if (it.variation) {
          const tryLabel = `${reqName} - ${it.variation}`;
          chosen = menu.find(m => norm(m.label) === norm(tryLabel)) || null;
        }
        chosen = chosen || menu.find(m => norm(m.name) === q) || menu.find(m => norm(m.label).startsWith(`${q} -`)) || null;
        if (!chosen && hint) chosen = menu.find(m => norm(m.label).includes(norm(hint))) || null;
      }
      if (!chosen) continue;

      const allowed = itemAllowedMods.get(chosen.itemId) || new Map();
      const modsIn = [
        ...(Array.isArray(it.modifiers) ? it.modifiers : []),
        ...extraMods
      ];
      const modsOut = [];
      const modNames = [];
      const noNames = [];
      let note = it.note ? String(it.note) : '';

      for (const raw of modsIn) {
        const s = norm(String(raw));
        if (/^(no|without)\s+/.test(s)) {
          noNames.push(s.replace(/^(no|without)\s+/, '').trim());
          note = note ? `${note}; ${raw}` : String(raw);
          continue;
        }
        const key = baseWord(s);
        const found = allowed.get(s) || allowed.get(key);
        if (found) {
          modsOut.push({ catalog_object_id: found.id, quantity: '1' });
          modNames.push(found.name.toLowerCase());
        } else {
          note = note ? `${note}; ${raw}` : String(raw);
        }
      }

      const li = { catalog_object_id: chosen.variationId, quantity: String(qty) };
      if (modsOut.length) li.modifiers = modsOut;
      if (note) li.note = note;
      line_items.push(li);

      const itemText = varToFront(chosen.label);
      const qtyText = toWord(qty);
      const withText = modNames.length ? ` with ${joinList(modNames)}` : '';
      const noText   = noNames.length  ? (withText ? `, no ${joinList(noNames)}` : ` with no ${joinList(noNames)}`) : '';
      speak_chunks.push(`${qtyText} ${itemText}${withText}${noText}`.replace(/\s+/g,' ').trim());
    }

    if (!line_items.length)
      return res.status(400).json({ success: false, error: 'No valid line_items matched the catalog' });

    const fulfillment = {
      type: 'PICKUP',
      state: 'PROPOSED',
      pickup_details: {
        schedule_type: pickup_at ? 'SCHEDULED' : 'ASAP',
        pickup_at: pickup_at || undefined,
        recipient: { display_name: customer_name, phone_number: customer_phone },
        note: order_notes
      }
    };

    const payload = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: LOCATION_ID,
        line_items,
        fulfillments: [fulfillment],
        note: order_notes,
        reference_id: customer_phone || undefined,
        source: { name: 'Phone Assistant' }
      }
    };

    // --- Create the order ---
    const r = await fetch(`${BASE}/v2/orders`, {
      method: 'POST',
      headers: SQ_HEADERS,
      body: JSON.stringify(payload)
    });
    const created = await r.json();
    if (!r.ok) {
      console.error('[create-order] failed', r.status, created?.errors || created);
      return res.status(r.status).json({ success: false, error: created });
    }

    const orderId = created.order?.id || null;
    const amount  = created.order?.total_money?.amount ?? 0;
    const currency = created.order?.total_money?.currency ?? 'USD';

    // --- Record an EXTERNAL payment so the order shows up in Dashboard/POS ---
    let paymentId = null;
    if (MARK_PAID && orderId && amount > 0) {
      const payPayload = {
        idempotency_key: crypto.randomUUID(),
        location_id: LOCATION_ID,
        order_id: orderId,
        amount_money: { amount, currency },
        source_id: 'EXTERNAL',
        autocomplete: true,
        external_details: {
          type: 'OTHER',                 // we’re not charging a card here
          source: 'Phone order via AVA'  // shows in UI
        }
      };
      const pr = await fetch(`${BASE}/v2/payments`, {
        method: 'POST',
        headers: SQ_HEADERS,
        body: JSON.stringify(payPayload)
      });
      const pj = await pr.json();
      if (!pr.ok) {
        console.error('[record-external-payment] failed', pr.status, pj?.errors || pj);
      } else {
        paymentId = pj.payment?.id || null;
      }
    }

    // Natural-language confirmation for the voice agent to read verbatim, then hang up.
    const spoken = `You’re all set, ${customer_name}. ${joinList(speak_chunks)}. Thanks—see you soon.`;

    res.json({
      success: true,
      orderId,
      paymentId,
      summary_tts: spoken
    });
  } catch (e) {
    console.error('[create-order] error', e);
    res.status(500).json({ success: false, error: String(e) });
  }
}
app.post('/api/create-order', createOrderHandler);

// ---- Aliases ----
app.get('/square/getMenu', (req, res) => getMenuHandler(req, res));
app.post('/square/createOrder', (req, res) => createOrderHandler(req, res));

// ---- Warm the catalog ----
const WARM_INTERVAL_MS = 4 * 60 * 1000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT} (env=${ENV})`);
  setTimeout(() => { fetchCatalog().catch(()=>{}); }, 0);
  setInterval(() => { fetchCatalog().catch(()=>{}); }, WARM_INTERVAL_MS);
});
app.post('/warmup', (_req, res) => {
  fetchCatalog().then(() => res.json({ok:true})).catch(e => res.status(500).json({ok:false, error:String(e)}));
});
