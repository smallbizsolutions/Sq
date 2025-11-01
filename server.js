// server.js — STRICT Square ordering (no unknown items allowed)
const express = require('express');
const cors = require('cors');
const { Client, Environment } = require('square');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- ENV ---
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID;
const ENVIRONMENT  = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();

const client = new Client({
  accessToken: ACCESS_TOKEN,
  environment: ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
});

// ---------- helpers ----------
const safeParse = (v) => {
  if (!v) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') try { return JSON.parse(v); } catch { return null; }
  return null;
};

const loadCatalogIndex = async () => {
  const { result } = await client.catalogApi.listCatalog(undefined, 'ITEM');
  const nameToVariation = new Map();
  const itemsOut = [];

  for (const obj of result.objects || []) {
    const item = obj.itemData;
    if (!item?.variations?.length) continue;
    const v = item.variations[0];
    const priceCents = v.itemVariationData?.priceMoney?.amount ?? null;

    nameToVariation.set(item.name.toLowerCase(), {
      variationId: v.id,
      priceCents
    });

    itemsOut.push({
      itemId: obj.id,
      name: item.name,
      variationId: v.id,
      priceCents,
      price: priceCents != null ? (priceCents / 100).toFixed(2) : null
    });
  }

  const allowedNames = itemsOut.map(i => i.name).sort((a,b)=>a.localeCompare(b));
  return { nameToVariation, itemsOut, allowedNames };
};

const toQty = (q) => {
  const n = Number(q ?? 1);
  return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : '1';
};

// ---------- routes ----------
app.get('/', (req, res) => res.json({ ok: true, env: ENVIRONMENT }));

// keep your simple viewer
app.get('/api/items', async (_req, res) => {
  try {
    const { itemsOut } = await loadCatalogIndex();
    res.json({ success: true, items: itemsOut });
  } catch (e) {
    console.error('items error:', e);
    res.status(200).json({ success: false, error: 'Failed to fetch items' });
  }
});

// single endpoint with two actions to minimize tools in Vapi
app.post('/api/order', async (req, res) => {
  try {
    const action = (req.body?.action || '').toLowerCase();

    // ---- MENU MODE ----
    if (action === 'menu') {
      const { itemsOut, allowedNames } = await loadCatalogIndex();
      return res.status(200).json({ success: true, menu: itemsOut, allowedNames });
    }

    // ---- CREATE MODE ----
    if (action !== 'create') {
      return res.status(400).json({ success: false, error: 'Missing or invalid action. Use "menu" or "create".' });
    }

    // read items
    let items = safeParse(req.body.items_json) || safeParse(req.body.items) || safeParse(req.body.line_items);
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).json({ success: false, error: 'No line items provided' });
    }

    // build catalog index
    const { nameToVariation, allowedNames } = await loadCatalogIndex();

    // validate & map
    const unknown = [];
    const lineItems = [];
    for (const i of items) {
      const name = (i.name || '').trim();
      const qty  = toQty(i.quantity);
      if (!name) { unknown.push('(blank)'); continue; }

      const hit = nameToVariation.get(name.toLowerCase());
      if (!hit) { unknown.push(name); continue; }

      lineItems.push({
        quantity: qty,
        catalogObjectId: hit.variationId
      });
    }

    if (unknown.length) {
      return res.status(200).json({
        success: false,
        error: `Unknown items: ${unknown.join(', ')}`,
        allowedNames
      });
    }

    const { result } = await client.ordersApi.createOrder({
      order: {
        locationId: LOCATION_ID,
        lineItems,
        note: req.body?.notes || undefined
      }
    });

    const orderId = result?.order?.id;
    if (!orderId) {
      return res.status(200).json({ success: false, error: 'Order creation failed' });
    }

    return res.status(200).json({
      success: true,
      orderId,
      message: 'Order created'
    });

  } catch (err) {
    console.error('order error:', err);
    const msg = err?.errors?.[0]?.detail || err.message || 'Unknown error';
    return res.status(200).json({ success: false, error: msg });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));
