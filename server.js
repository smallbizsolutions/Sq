// server.js — Node 18+, ESM. Pickup orders with variation + modifier support, synonyms, and flexible X-API-Key gate.
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// -------- Env & Square base (supports SQUARE_ENV or SQUARE_ENVIRONMENT) --------
const ENV = (process.env.SQUARE_ENV || process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
const BASE = ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_TOKEN || '';
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID  || process.env.LOCATION_ID  || '';
const INBOUND_KEY  = process.env.INBOUND_API_KEY || '';

const SQ_HEADERS = {
  'Content-Type': 'application/json',
  'Square-Version': '2024-09-19',
  'Authorization': `Bearer ${ACCESS_TOKEN}`,
};

// -------- Health --------
app.get('/healthz', (_req, res) => res.json({ ok: true, env: ENV }));

// -------- Inbound gate: accept multiple header names --------
app.use((req, res, next) => {
  // Allow no key in sandbox for easier testing; require in prod if set.
  if (!INBOUND_KEY && ENV === 'sandbox') return next();
  const h = (name) => req.get(name);
  const presented =
    h('x-inbound-api-key') || h('X-Inbound-Api-Key') ||
    h('x-api-key')        || h('X-API-Key')        ||
    h('x_api_key');
  if (presented !== INBOUND_KEY) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
});

// -------- Helpers --------
const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Simple item name synonyms (expand as needed)
const ITEM_SYNONYMS = new Map([
  ['cheeseburger', { base: 'Burger', add: ['cheese'] }],
  ['hamburger',    { base: 'Burger', add: [] }],
  ['pop',          { base: 'Soda',   add: [] }],
  ['coke',         { base: 'Soda',   hint: 'coke' }],   // will try to match a Soda variation containing 'coke'
  ['sprite',       { base: 'Soda',   hint: 'sprite' }],
]);

// Modifier synonyms → normalized keys (we’ll try to map to real Square modifiers by name; else go to notes)
const MOD_SYNONYMS = new Map([
  ['cheese',        ['add cheese','with cheese','cheddar','american cheese']],
  ['well done',     ['well-done','welldone']],
  ['no tomato',     ['hold tomato','without tomato','no tomatoes']],
  ['no lettuce',    ['hold lettuce','without lettuce']],
  ['no pickles',    ['hold pickles','without pickles','no pickle']],
  ['extra pickles', ['more pickles','lots of pickles']],
  ['ketchup',       ['catsup']],
  ['mustard',       []],
  ['mayo',          ['mayonnaise']],
  ['extra ketchup', ['more ketchup','lots of ketchup']],
]);

// Build a reverse lookup map from synonyms
function expandModKeyMap() {
  const map = new Map();
  for (const [key, arr] of MOD_SYNONYMS.entries()) {
    map.set(norm(key), key);
    for (const a of arr) map.set(norm(a), key);
  }
  return map;
}
const MOD_LOOKUP = expandModKeyMap();

function configOk() {
  return !!(ACCESS_TOKEN && LOCATION_ID);
}

// -------- Catalog cache (items + modifiers) --------
let cache = { at: 0, items: null, modifiersByName: null };
const TTL = 60_000; // 60s

async function fetchCatalog() {
  const now = Date.now();
  if (cache.items && cache.modifiersByName && now - cache.at < TTL) {
    return { items: cache.items, modifiersByName: cache.modifiersByName };
  }

  const r = await fetch(`${BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION,MODIFIER_LIST,MODIFIER`, { headers: SQ_HEADERS });
  const json = await r.json();
  if (!r.ok) throw new Error(`catalog list ${r.status}: ${JSON.stringify(json)}`);

  const objs = json.objects || [];

  const itemNameById = new Map();
  const variations = [];
  const modifiersByName = new Map(); // normalized name -> modifier object id

  for (const o of objs) {
    if (o.type === 'ITEM') {
      itemNameById.set(o.id, o.item_data?.name || '');
    } else if (o.type === 'ITEM_VARIATION') {
      variations.push(o);
    } else if (o.type === 'MODIFIER') {
      const name = norm(o.modifier_data?.name || '');
      if (name) modifiersByName.set(name, o.id);
    }
  }

  const items = [];
  for (const v of variations) {
    const vd = v.item_variation_data || {};
    const itemId = vd.item_id;
    const baseName = itemNameById.get(itemId);
    const varName  = vd.name || 'Regular';
    const cents    = vd.price_money?.amount;
    if (!baseName || cents == null) continue;
    items.push({
      itemId,
      name: baseName,                 // "Soda"
      variationId: v.id,
      priceCents: cents,
      price: (cents / 100).toFixed(2),
      label: `${baseName} - ${varName}` // "Soda - Large" or "Burger - Regular"
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));

  cache = { at: now, items, modifiersByName };
  return { items, modifiersByName };
}

// -------- GET /api/items --------
app.get('/api/items', async (_req, res) => {
  try {
    if (!configOk()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });
    const { items } = await fetchCatalog();
    res.json({ success: true, items });
  } catch (e) {
    console.error('[items]', e);
    res.status(500).json({ success: false, error: String(e) });
  }
});

// Try to find a variationId by a provided name/label/keyword
function resolveVariationId(nameOrLabel, menu, hint) {
  const q = norm(nameOrLabel);

  // 1) exact label match
  let hit = menu.find(m => norm(m.label) === q);
  if (hit) return hit.variationId;

  // 2) exact base-name match (take first variation)
  hit = menu.find(m => norm(m.name) === q);
  if (hit) return hit.variationId;

  // 3) contains search on label if we have a hint (e.g., 'coke')
  if (hint) {
    const h = norm(hint);
    hit = menu.find(m => norm(m.label).includes(h) || norm(m.name).includes(h));
    if (hit) return hit.variationId;
  }

  // 4) fallback contains search on label
  hit = menu.find(m => norm(m.label) === `${q} - regular` || norm(m.label).includes(q));
  return hit?.variationId;
}

// -------- POST /api/create-order --------
app.post('/api/create-order', async (req, res) => {
  try {
    if (!configOk()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });

    // Parse items
    let items = req.body.items_json;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items_json must be a non-empty array' });
    }

    const customer_name  = req.body.customer_name || 'Guest';
    const customer_phone = req.body.customer_phone || undefined;
    const customer_email = req.body.customer_email || undefined;
    const order_notes    = req.body.notes || undefined;
    const pickup_at      = req.body.pickup_at || undefined;

    // Catalog
    const { items: menu, modifiersByName } = await fetchCatalog();

    const line_items = [];
    for (const it of items) {
      let incomingName = String(it.name || it.label || '').trim();
      let mods = Array.isArray(it.mods) ? it.mods.map(norm) : [];
      let perItemNote = it.note ? String(it.note) : '';

      // Apply item synonyms & implied mods
      const syn = ITEM_SYNONYMS.get(norm(incomingName));
      let hint = undefined;
      if (syn) {
        incomingName = syn.base;
        if (Array.isArray(syn.add)) mods = mods.concat(syn.add.map(norm));
        if (syn.hint) hint = syn.hint;
      }

      // Resolve variation id
      let variationId = it.variationId;
      if (!variationId) {
        variationId = resolveVariationId(incomingName, menu, hint);
      }
      if (!variationId) continue; // skip unmapped item

      // Build Square modifiers (if we can map names) and collect leftovers into note
      const lineMods = [];
      for (const raw of mods) {
        const normalized = MOD_LOOKUP.get(norm(raw)) || norm(raw);
        const modId = modifiersByName.get(norm(normalized));
        if (modId) {
          lineMods.push({ catalog_object_id: modId, quantity: '1' });
        } else {
          // Not a real Square modifier -> push into note
          perItemNote = perItemNote
            ? `${perItemNote}; ${raw}`
            : raw;
        }
      }

      const li = {
        catalog_object_id: variationId,
        quantity: String(it.quantity ?? 1),
        note: perItemNote || undefined,
        modifiers: lineMods.length ? lineMods : undefined,
      };
      line_items.push(li);
    }

    if (!line_items.length) {
      return res.status(400).json({ success: false, error: 'No valid line_items (check item names/labels or synonyms)' });
    }

    // Fulfillment (pickup)
    const fulfillment = {
      type: 'PICKUP',
      state: 'PROPOSED',
      pickup_details: {
        schedule_type: pickup_at ? 'SCHEDULED' : 'ASAP',
        pickup_at: pickup_at || undefined,
        recipient: {
          display_name: customer_name,
          phone_number: customer_phone,
          email_address: customer_email,
        },
        note: order_notes,
      },
    };

    const payload = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: LOCATION_ID,
        line_items,
        fulfillments: [fulfillment],
        note: order_notes,
        reference_id: customer_phone || undefined,
      },
    };

    const r = await fetch(`${BASE}/v2/orders`, {
      method: 'POST',
      headers: SQ_HEADERS,
      body: JSON.stringify(payload),
    });
    const json = await r.json();
    if (!r.ok) {
      console.error('[create-order] failed', r.status, json);
      return res.status(r.status).json({ success: false, error: json });
    }

    res.json({ success: true, orderId: json.order?.id || null });
  } catch (e) {
    console.error('[create-order] error', e);
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT} (env=${ENV})`);
});
