// server.js — Node 18+, ESM. Square pickup orders with variations + modifiers + synonyms.
import express from 'express';
import crypto from 'crypto';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// ---- Env & Square base (supports SQUARE_ENV or SQUARE_ENVIRONMENT) ----
const ENV = (process.env.SQUARE_ENV || process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
const BASE = ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID  || '';
const INBOUND_KEY  = process.env.INBOUND_API_KEY || process.env.VAPI_INBOUND_KEY || '';

const SQ_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Square-Version': '2024-09-19',
  'Authorization': `Bearer ${ACCESS_TOKEN}`,
};

function configOk() { return !!(ACCESS_TOKEN && LOCATION_ID); }
const norm = (s='') => String(s).toLowerCase().trim();
const baseWord = (s='') => norm(s).replace(/^(extra|add|light|no|without|with)\s+/, '');

// ---- Health ----
app.get('/healthz', (_req, res) => res.json({
  ok: true,
  env: ENV,
  hasAccessToken: !!ACCESS_TOKEN,
  hasLocation: !!(LOCATION_ID && LOCATION_ID.length > 0),
}));

// Self-check that calls Square and confirms location exists
app.get('/selfcheck', async (_req, res) => {
  try {
    if (!configOk()) return res.status(500).json({ ok: false, error: 'Square credentials not configured' });
    const r = await fetch(`${BASE}/v2/locations`, { headers: SQ_HEADERS });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: j });
    const loc = (j.locations || []).find(l => l.id === LOCATION_ID);
    res.json({ ok: !!loc, locationName: loc?.name || null, env: ENV });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Inbound gate: require Authorization: Bearer <INBOUND_API_KEY> ----
app.use((req, res, next) => {
  const auth = req.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  const key = bearer || req.get('x-inbound-api-key') || req.get('x-api-key');
  if (!INBOUND_KEY || key !== INBOUND_KEY) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
});

// ---- Synonyms (expand per client if needed) ----
const SYNONYMS = [
  { test: /^cheeseburger$/i, base: 'Burger', addMods: ['add cheese'] },
  { test: /^hamburger$/i,    base: 'Burger', addMods: [] },
  { test: /^pop$/i,          base: 'Soda',   addMods: [] },
  { test: /^coke$/i,         base: 'Soda',   addMods: [], hint: 'coke' },
  { test: /^sprite$/i,       base: 'Soda',   addMods: [], hint: 'sprite' },
];
function applySynonym(name) {
  const n = String(name || '').trim();
  for (const s of SYNONYMS) if (s.test.test(n)) return s;
  return null;
}

// ---- Catalog cache (ITEM, VARIATION, MODIFIER_LIST, MODIFIER) with pagination ----
const TTL = 300_000; // 5 minutes
let cache = { at: 0, items: null, itemAllowedMods: null, refreshing: null };

async function fetchCatalog() {
  const now = Date.now();
  if (cache.items && cache.itemAllowedMods && now - cache.at < TTL) return cache;
  if (cache.refreshing) return cache.refreshing;

  cache.refreshing = (async () => {
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
    const modifierLists = new Map();     // listId -> { name, modifiers: [{id,name}] }
    const modifiersByList = new Map();   // listId -> [{id,name}]

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
        const arr = modifiersByList.get(listId) || [];
        arr.push({ id: o.id, name: o.modifier_data?.name || '' });
        modifiersByList.set(listId, arr);
      }
    }
    for (const [listId, mods] of modifiersByList) {
      if (modifierLists.has(listId)) modifierLists.get(listId).modifiers = mods;
    }

    // Build items for menu and allowed modifier map per item
    const itemsOut = [];
    const itemAllowedMods = new Map(); // itemId -> Map(nameLower or baseWord -> modId)

    for (const v of variations) {
      const vd = v.item_variation_data || {};
      const itemId = vd.item_id;
      const baseName = itemNameById.get(itemId);
      const varName  = vd.name || 'Regular';
      const cents    = vd.price_money?.amount;
      if (!baseName || cents == null) continue;

      itemsOut.push({
        itemId,
        name: baseName,                 // e.g., "Soda"
        variationId: v.id,
        priceCents: cents,
        price: (cents / 100).toFixed(2),
        label: `${baseName} - ${varName}` // e.g., "Soda - Large"
      });

      // Allowed modifiers for this item
      const item = itemsById.get(itemId);
      const listInfo = item?.item_data?.modifier_list_info || [];
      const modMap = itemAllowedMods.get(itemId) || new Map();
      for (const li of listInfo) {
        const listId = li.modifier_list_id;
        const list = modifierLists.get(listId);
        if (!list) continue;
        for (const m of list.modifiers) {
          const n = norm(m.name);
          modMap.set(n, m.id);
          modMap.set(baseWord(n), m.id); // also match base word (“cheese” matches “extra cheese”)
        }
      }
      if (modMap.size) itemAllowedMods.set(itemId, modMap);
    }

    itemsOut.sort((a, b) => a.label.localeCompare(b.label));
    cache = { at: Date.now(), items: itemsOut, itemAllowedMods, refreshing: null };
    return cache;
  })();

  return cache.refreshing;
}

// Resolve a variation by exact label, base name, or hint
function resolveVariation(nameOrLabel, menu, hint) {
  const q = norm(nameOrLabel);

  // exact label
  let hit = menu.find(m => norm(m.label) === q);
  if (hit) return hit;

  // exact base name (first variation)
  hit = menu.find(m => norm(m.name) === q);
  if (hit) return hit;

  // hint-based contains (for “coke”, “sprite”, etc.)
  if (hint) {
    const h = norm(hint);
    hit = menu.find(m => norm(m.label).includes(h) || norm(m.name).includes(h));
    if (hit) return hit;
  }

  // fallback contains on label (prefers “Regular” if present)
  hit = menu.find(m => norm(m.label) === `${q} - regular`) ||
        menu.find(m => norm(m.label).startsWith(`${q} -`)) ||
        menu.find(m => norm(m.label).includes(q));
  return hit || null;
}

// ---- GET /api/items (list menu variants) ----
async function getMenuHandler(_req, res) {
  try {
    if (!configOk()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });
    const { items } = await fetchCatalog();
    res.json({ success: true, items });
  } catch (e) {
    console.error('[items]', e);
    res.status(500).json({ success: false, error: String(e) });
  }
}
app.get('/api/items', getMenuHandler);

// ---- POST /api/create-order (pickup, unpaid) ----
async function createOrderHandler(req, res) {
  try {
    if (!configOk()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });

    // Parse items_json as array
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
    const byBase = new Map();
    for (const m of menu) if (!byBase.has(norm(m.name))) byBase.set(norm(m.name), m);

    const line_items = [];
    for (const it of items) {
      const qty = String(it.quantity ?? 1);

      // Apply synonyms (e.g., cheeseburger -> Burger + add cheese)
      let reqName = it.name || it.label || '';
      let extraMods = [];
      let hint = undefined;
      const syn = applySynonym(reqName);
      if (syn) { reqName = syn.base; extraMods = syn.addMods || []; hint = syn.hint; }

      // Choose variation
      let chosen = null;
      if (it.variationId) {
        chosen = byId.get(it.variationId) || null;
      } else if (reqName) {
        // If caller provided explicit variation text (e.g., "Large"), try exact "Name - Variation"
        if (it.variation) {
          const tryLabel = `${reqName} - ${it.variation}`;
          chosen = menu.find(m => norm(m.label) === norm(tryLabel)) || null;
        }
        chosen = chosen || resolveVariation(reqName, menu, hint);
        if (!chosen) { // try base fallback
          const b = byBase.get(norm(reqName));
          if (b) chosen = b;
        }
      }
      if (!chosen) continue; // skip unknown item

      // Modifiers
      const allowed = itemAllowedMods.get(chosen.itemId) || new Map();
      const modsIn = [
        ...(Array.isArray(it.modifiers) ? it.modifiers : []),
        ...extraMods
      ];
      const modsOut = [];
      let note = it.note ? String(it.note) : '';

      for (const raw of modsIn) {
        const s = norm(String(raw));
        // “no/without X”
        if (/^(no|without)\s+/.test(s)) {
          const base = baseWord(s);
          const id = allowed.get(s) || allowed.get(base);
          if (id) modsOut.push({ catalog_object_id: id, quantity: '1' });
          else note = note ? `${note}; ${raw}` : String(raw);
          continue;
        }
        // “extra/add/light X”
        const base = baseWord(s);
        const id = allowed.get(s) || allowed.get(base);
        if (id) modsOut.push({ catalog_object_id: id, quantity: '1' });
        else note = note ? `${note}; ${raw}` : String(raw);
      }

      const li = {
        catalog_object_id: chosen.variationId,
        quantity: qty,
      };
      if (modsOut.length) li.modifiers = modsOut;
      if (note) li.note = note;

      line_items.push(li);
    }

    if (!line_items.length)
      return res.status(400).json({ success: false, error: 'No valid line_items matched the catalog' });

    // Pickup fulfillment so POS/KDS sees it
    const fulfillment = {
      type: 'PICKUP',
      state: 'PROPOSED',
      pickup_details: {
        schedule_type: pickup_at ? 'SCHEDULED' : 'ASAP',
        pickup_at: pickup_at || undefined,
        recipient: {
          display_name: customer_name,
          phone_number: customer_phone
        },
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
        reference_id: customer_phone || undefined
      }
    };

    const r = await fetch(`${BASE}/v2/orders`, {
      method: 'POST',
      headers: SQ_HEADERS,
      body: JSON.stringify(payload)
    });
    const json = await r.json();
    if (!r.ok) {
      console.error('[create-order] failed', r.status, json?.errors || json);
      return res.status(r.status).json({ success: false, error: json });
    }

    res.json({ success: true, orderId: json.order?.id || null });
  } catch (e) {
    console.error('[create-order] error', e);
    res.status(500).json({ success: false, error: String(e) });
  }
}
app.post('/api/create-order', createOrderHandler);

// ---- Route aliases to match your VAPI tool names (use either path) ----
app.get('/square/getMenu', (req, res) => getMenuHandler(req, res));
app.post('/square/createOrder', (req, res) => createOrderHandler(req, res));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT} (env=${ENV})`);
});
