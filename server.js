const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ---- ENV ----
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;     // EAAA... (sandbox)
const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

if (!ACCESS_TOKEN || !LOCATION_ID) {
  console.warn('Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID env vars.');
}

const BASE = ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const authHeaders = {
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

// ---- HELPERS ----
async function fetchCatalogItems() {
  // Pull only ITEM objects; variations (with prices) are nested under each item
  const url = `${BASE}/v2/catalog/list`;
  const res = await axios.get(url, {
    headers: authHeaders,
    params: { types: 'ITEM' }
  });

  const objects = res.data.objects || [];
  const out = [];

  for (const obj of objects) {
    const itemId = obj.id;
    const itemData = obj.item_data || {};
    const name = itemData.name;

    const variations = itemData.variations || [];
    if (!variations.length) continue;

    // Prefer the first variation for price
    for (const v of variations) {
      const varId = v.id;
      const varData = v.item_variation_data || {};
      const priceMoney = varData.price_money || {};
      const priceCents = Number(priceMoney.amount || 0);

      out.push({
        itemId,
        name,
        variationId: varId,
        priceCents,
        price: (priceCents / 100).toFixed(2)
      });
      // if you only want one entry per name, break after first variation
      break;
    }
  }

  // De-dupe by name (keep first)
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    deduped.push(it);
  }
  return deduped;
}

// ---- ROUTES ----

app.get('/health', (_req, res) => {
  res.json({ ok: true, env: ENV });
});

app.get('/api/items', async (_req, res) => {
  try {
    const items = await fetchCatalogItems();
    res.json({ success: true, items });
  } catch (err) {
    console.error('items error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch items' });
  }
});

app.post('/api/create-order', async (req, res) => {
  try {
    const {
      items_json = '[]',
      notes = '',
      customer_name = '',
      customer_phone = '',
      customer_email = ''
    } = req.body || {};

    let cart = [];
    try {
      cart = JSON.parse(items_json); // [{name, quantity}]
    } catch {
      return res.status(400).json({ success: false, error: 'items_json must be a JSON string' });
    }

    if (!Array.isArray(cart) || cart.length === 0) {
      // Allow empty: we’ll fall back to first catalog item so your Vapi test still works
      const items = await fetchCatalogItems();
      if (!items.length) return res.status(400).json({ success: false, error: 'No catalog items available' });
      cart = [{ name: items[0].name, quantity: 1 }];
    }

    // Build price map from catalog (name -> priceCents)
    const catalog = await fetchCatalogItems();
    const priceMap = new Map(catalog.map(i => [i.name.toLowerCase(), i.priceCents]));

    // Build Square line items
    const lineItems = cart.map(row => {
      const qty = String(row.quantity || 1);
      const key = String(row.name || '').toLowerCase();
      const priceCents = priceMap.get(key) || 0;

      return {
        name: row.name,
        quantity: qty,
        base_price_money: { amount: priceCents, currency: 'USD' }
      };
    });

    const orderBody = {
      idempotency_key: randomUUID(),
      order: {
        location_id: LOCATION_ID,
        line_items: lineItems,
        reference_id: customer_phone || undefined,
        customer_id: undefined,
        fulfillments: undefined,
        ticket_name: customer_name || undefined,
        note: notes || undefined
      }
    };

    const createUrl = `${BASE}/v2/orders`;
    const resp = await axios.post(createUrl, orderBody, { headers: authHeaders });

    const orderId = resp?.data?.order?.id || null;
    return res.json({
      success: true,
      orderId,
      message: orderId ? 'Order created' : 'Order created (no id returned)'
    });
  } catch (err) {
    console.error('create-order error:', err?.response?.data || err.message);
    const msg = err?.response?.data?.errors?.[0]?.detail || 'Order creation failed';
    res.status(500).json({ success: false, error: msg });
  }
});

// ---- START ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} (${ENV})`);
});
