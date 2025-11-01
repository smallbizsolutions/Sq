// server.js — Node 18+, ESM. Square pickup orders with variation support and X-API-Key gate.
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// ---- Env & Square base ----
const ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const BASE =
  ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID  || '';
const INBOUND_KEY  = process.env.INBOUND_API_KEY || '';

const SQ_HEADERS = {
  'Content-Type': 'application/json',
  'Square-Version': '2024-09-19',
  'Authorization': `Bearer ${ACCESS_TOKEN}`,
};

// ---- Health ----
app.get('/healthz', (_req, res) => res.json({ ok: true, env: ENV }));

// ---- Inbound gate: only allow requests that present the shared key ----
app.use((req, res, next) => {
  // If you forgot to set the key, allow sandbox; require key in production.
  if (!INBOUND_KEY && ENV === 'sandbox') return next();
  const ok = req.get('X-API-Key') === INBOUND_KEY;
  if (!ok) return res.status(401).json({ success: false, error: 'unauthorized' });
  next();
});

// ---- Basic config checks (don’t crash; return 500s) ----
function configOk() {
  return !!(ACCESS_TOKEN && LOCATION_ID);
}

// ---- Catalog cache (reduces latency + API calls) ----
let cache = { at: 0, items: null };
const TTL = 60_000; // 60s

async function fetchMenuFromSquare() {
  const now = Date.now();
  if (cache.items && now - cache.at < TTL) return cache.items;

  const r = await fetch(`${BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION`, { headers: SQ_HEADERS });
  const json = await r.json();
  if (!r.ok) {
    throw new Error(`Catalog list failed: ${r.status} ${JSON.stringify(json)}`);
  }

  const objs = json.objects || [];
  const itemNameById = new Map();
  const variations = [];

  for (const o of objs) {
    if (o.type === 'ITEM') {
      itemNameById.set(o.id, o.item_data?.name || '');
    } else if (o.type === 'ITEM_VARIATION') {
      variations.push(o);
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
      name: baseName,                  // e.g., "Soda"
      variationId: v.id,
      priceCents: cents,
      price: (cents / 100).toFixed(2),
      label: `${baseName} - ${varName}` // e.g., "Soda - Large"
    });
  }

  // alphabetical for sanity
  items.sort((a, b) => a.label.localeCompare(b.label));

  cache = { at: now, items };
  return items;
}

// ---- GET /api/items (list menu) ----
app.get('/api/items', async (_req, res) => {
  try {
    if (!configOk()) {
      return res.status(500).json({ success: false, error: 'Square credentials not configured' });
    }
    const items = await fetchMenuFromSquare();
    res.json({ success: true, items });
  } catch (err) {
    console.error('[items] error', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ---- POST /api/create-order (pickup, unpaid) ----
app.post('/api/create-order', async (req, res) => {
  try {
    if (!configOk()) {
      return res.status(500).json({ success: false, error: 'Square credentials not configured' });
    }

    // Accept array or stringified array
    let items = req.body.items_json;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items_json must be a non-empty array' });
    }

    const customer_name  = req.body.customer_name || 'Guest';
    const customer_phone = req.body.customer_phone || undefined;
    const customer_email = req.body.customer_email || undefined;
    const notes          = req.body.notes || undefined;
    const pickup_at      = req.body.pickup_at || undefined; // optional ISO if scheduled

    // Map names/labels -> variationIds
    const menu = await fetchMenuFromSquare();
    const byLabel = new Map(menu.map(m => [ (m.label || m.name).toLowerCase(), m.variationId ]));
    const byBase  = new Map(); // first variation per base as fallback
    for (const m of menu) {
      const k = m.name.toLowerCase();
      if (!byBase.has(k)) byBase.set(k, m.variationId);
    }

    const line_items = [];
    for (const it of items) {
      const qty = String(it.quantity ?? 1);
      let varId = it.variationId;

      if (!varId && it.name) {
        const key = String(it.name).toLowerCase(); // prefer "Item - Size" label
        varId = byLabel.get(key) || byBase.get(key);
      }
      if (varId) {
        line_items.push({
          catalog_object_id: varId,
          quantity: qty,
          note: it.note || undefined
        });
      }
    }

    if (!line_items.length) {
      return res.status(400).json({ success: false, error: 'No valid line_items matched the catalog (check item names/labels)' });
    }

    // Build pickup fulfillment so tickets show up in POS/KDS
    const fulfillment = {
      type: 'PICKUP',
      state: 'PROPOSED',
      pickup_details: {
        schedule_type: pickup_at ? 'SCHEDULED' : 'ASAP',
        pickup_at: pickup_at || undefined, // RFC3339 for scheduled
        recipient: {
          display_name: customer_name,
          phone_number: customer_phone,
          email_address: customer_email
        },
        note: notes
      }
    };

    const payload = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: LOCATION_ID,
        line_items,
        fulfillments: [fulfillment],
        note: notes,
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
      console.error('[create-order] failed', r.status, json);
      return res.status(r.status).json({ success: false, error: json });
    }

    res.json({ success: true, orderId: json.order?.id || null });
  } catch (err) {
    console.error('[create-order] error', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT} (env=${ENV})`);
});
