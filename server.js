// server.js — Node 18+, ESM. Square pickup orders with variation support + tolerant env/header handling.
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
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
  'Square-Version': '2024-09-19',
  'Authorization': `Bearer ${ACCESS_TOKEN}`,
};

// ---- Health ----
app.get('/healthz', (_req, res) => res.json({ ok: true, env: ENV, hasKey: !!INBOUND_KEY }));

// ---- Inbound gate (accept multiple header names; allow open in sandbox if no key set) ----
app.use((req, res, next) => {
  if (!INBOUND_KEY && ENV === 'sandbox') return next(); // sandbox convenience
  const key =
    req.get('x-api-key') ||
    req.get('X-API-Key') ||
    req.get('x-inbound-api-key') ||
    req.get('X-Inbound-Api-Key');
  if (key !== INBOUND_KEY) return res.status(401).json({ success: false, error: 'unauthorized' });
  next();
});

// ---- Basic config checks ----
const configOk = () => !!(ACCESS_TOKEN && LOCATION_ID);

// ---- Simple catalog cache ----
let cache = { at: 0, items: null };
const TTL = 60_000;

async function fetchMenuFromSquare() {
  const now = Date.now();
  if (cache.items && now - cache.at < TTL) return cache.items;

  const r = await fetch(`${BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION`, { headers: SQ_HEADERS });
  const json = await r.json();
  if (!r.ok) throw new Error(`Catalog list failed: ${r.status} ${JSON.stringify(json)}`);

  const objs = json.objects || [];
  const itemNameById = new Map();
  const variations = [];

  for (const o of objs) {
    if (o.type === 'ITEM') itemNameById.set(o.id, o.item_data?.name || '');
    else if (o.type === 'ITEM_VARIATION') variations.push(o);
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
      name: baseName,               // e.g., "Soda"
      variationId: v.id,
      priceCents: cents,
      price: (cents / 100).toFixed(2),
      label: `${baseName} - ${varName}` // e.g., "Soda - Large"
    });
  }

  items.sort((a, b) => a.label.localeCompare(b.label));
  cache = { at: now, items };
  return items;
}

// ---- GET /api/items ----
app.get('/api/items', async (_req, res) => {
  try {
    if (!configOk()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });
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
    if (!configOk()) return res.status(500).json({ success: false, error: 'Square credentials not configured' });

    let items = req.body.items_json;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, error: 'items_json must be a non-empty array' });

    const customer_name  = req.body.customer_name || 'Guest';
    const customer_phone = req.body.customer_phone || undefined;
    const customer_email = req.body.customer_email || undefined;
    const notes          = req.body.notes || undefined;
    const pickup_at      = req.body.pickup_at || undefined; // RFC3339 if scheduled

    // Map names/labels -> variationIds
    const menu = await fetchMenuFromSquare();
    const byLabel = new Map(menu.map(m => [(m.label || m.name).toLowerCase(), m.variationId]));
    const byBase  = new Map();
    for (const m of menu) if (!byBase.has(m.name.toLowerCase())) byBase.set(m.name.toLowerCase(), m.variationId);

    const line_items = [];
    for (const it of items) {
      const qty = String(it.quantity ?? 1);
      let varId = it.variationId;
      if (!varId && it.name) {
        const k = String(it.name).toLowerCase();
        varId = byLabel.get(k) || byBase.get(k);
      }
      if (varId) line_items.push({ catalog_object_id: varId, quantity: qty, note: it.note || undefined });
    }
    if (!line_items.length) return res.status(400).json({ success: false, error: 'No valid line_items matched the catalog' });

    const payload = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: LOCATION_ID,
        line_items,
        fulfillments: [{
          type: 'PICKUP',
          state: 'PROPOSED',
          pickup_details: {
            schedule_type: pickup_at ? 'SCHEDULED' : 'ASAP',
            pickup_at: pickup_at || undefined,
            recipient: { display_name: customer_name, phone_number: customer_phone, email_address: customer_email },
            note: notes,
          },
        }],
        note: notes,
        reference_id: customer_phone || undefined,
      },
    };

    const r = await fetch(`${BASE}/v2/orders`, { method: 'POST', headers: SQ_HEADERS, body: JSON.stringify(payload) });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json({ success: false, error: json });

    res.json({ success: true, orderId: json.order?.id || null });
  } catch (err) {
    console.error('[create-order] error', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT} (env=${ENV})`);
});
