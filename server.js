// server.js  (ESM)
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- Square config ----
const SQUARE_BASE =
  (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN; // e.g. EAAA...
const SQUARE_LOCATION_ID  = process.env.SQUARE_LOCATION_ID;  // your sandbox location

const SQ_HEADERS = {
  'Content-Type': 'application/json',
  'Square-Version': '2024-09-19',
  'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
};

// ---- health ----
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- GET /api/items : list simplified menu ----
app.get('/api/items', async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN) return res.status(500).json({ success: false, error: 'Missing SQUARE_ACCESS_TOKEN' });

    const r = await fetch(`${SQUARE_BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION`, { headers: SQ_HEADERS });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ success: false, error: data });

    const objs = data.objects || [];
    const itemsById = new Map();
    const variations = [];
    for (const o of objs) {
      if (o.type === 'ITEM') itemsById.set(o.id, o);
      if (o.type === 'ITEM_VARIATION') variations.push(o);
    }

    const out = [];
    for (const v of variations) {
      const vd = v.item_variation_data || {};
      const itemId = vd.item_id;
      const name = itemsById.get(itemId)?.item_data?.name;
      const cents = vd.price_money?.amount;
      if (!name || cents == null) continue;
      out.push({
        itemId,
        name,
        variationId: v.id,
        priceCents: cents,
        price: (cents / 100).toFixed(2),
      });
    }

    res.json({ success: true, items: out });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ---- POST /api/create-order : create Square order ----
app.post('/api/create-order', async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN) return res.status(500).json({ success: false, error: 'Missing SQUARE_ACCESS_TOKEN' });
    if (!SQUARE_LOCATION_ID)  return res.status(500).json({ success: false, error: 'Missing SQUARE_LOCATION_ID' });

    // items_json can be a stringified array or an array
    let items = req.body.items_json;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { /* ignore */ }
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items_json must be an array' });
    }

    // Map item names -> variationIds from catalog
    const catResp = await fetch(`${SQUARE_BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION`, { headers: SQ_HEADERS });
    const cat = await catResp.json();
    const objs = cat.objects || [];
    const itemNameById = new Map();
    for (const o of objs) if (o.type === 'ITEM') itemNameById.set(o.id, o.item_data?.name || '');
    const varByName = new Map();
    for (const o of objs) {
      if (o.type !== 'ITEM_VARIATION') continue;
      const name = (itemNameById.get(o.item_variation_data?.item_id) || '').toLowerCase();
      if (name) varByName.set(name, o.id);
    }

    const line_items = [];
    for (const it of items) {
      let variationId = it.variationId;
      if (!variationId && it.name) variationId = varByName.get(String(it.name).toLowerCase());
      const qty = String(it.quantity ?? 1);
      if (variationId) line_items.push({ catalog_object_id: variationId, quantity: qty });
    }

    if (!line_items.length) {
      return res.status(400).json({ success: false, error: 'No valid line_items' });
    }

    const body = { order: { location_id: SQUARE_LOCATION_ID, line_items } };
    const ordResp = await fetch(`${SQUARE_BASE}/v2/orders`, { method: 'POST', headers: SQ_HEADERS, body: JSON.stringify(body) });
    const ord = await ordResp.json();
    if (!ordResp.ok) return res.status(ordResp.status).json({ success: false, error: ord });

    res.json({ success: true, orderId: ord.order?.id ?? null });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
});
