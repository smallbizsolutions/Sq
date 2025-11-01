// server.js
// Minimal Square Sandbox order backend (no Square SDK).
// Requires env: SQUARE_ACCESS_TOKEN, SQUARE_ENVIRONMENT=sandbox, SQUARE_LOCATION_ID

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
const BASE =
  ENV === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
if (!process.env.SQUARE_ACCESS_TOKEN || !LOCATION_ID) {
  console.warn('[WARN] Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID');
}

const authHeaders = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

// ---------- Helpers ----------
async function fetchCatalogItems() {
  // Returns [{name, priceCents, variationId}] for ACTIVE items with one default variation
  const url = `${BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION`;
  const out = [];
  const byId = new Map();

  let cursor = null;
  do {
    const r = await axios.get(url + (cursor ? `&cursor=${cursor}` : ''), {
      headers: authHeaders,
    });
    const objs = r.data.objects || [];
    for (const obj of objs) byId.set(obj.id, obj);

    cursor = r.data.cursor || null;
  } while (cursor);

  // Build item->variation mapping, pull price
  for (const obj of byId.values()) {
    if (obj.type !== 'ITEM') continue;
    const itemData = obj.item_data;
    if (!itemData || itemData.is_archived) continue;

    // Use first variation that is available
    const varIds = (itemData.variations || []).map((v) => v.id);
    if (!varIds.length) continue;

    for (const vid of varIds) {
      const v = byId.get(vid);
      if (!v || v.type !== 'ITEM_VARIATION') continue;
      const vd = v.item_variation_data;
      if (!vd || vd.item_id !== obj.id) continue;

      const priceCents = vd.price_money?.amount;
      if (typeof priceCents !== 'number') continue;

      out.push({
        name: itemData.name, // visible name we’ll match on
        priceCents,
        variationId: v.id, // not used for price calc, but kept for reference
      });
      break; // one variation is enough for our simple menu
    }
  }
  return out;
}

function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}

// ---------- Routes ----------
app.get('/health', (_req, res) => {
  res.json({ ok: true, env: ENV, locationId: LOCATION_ID });
});

// Expose simplified menu for the agent/tool
app.get('/api/items', async (_req, res) => {
  try {
    const items = await fetchCatalogItems();
    // Return clean list with integer cents and float price for readability
    res.json({
      success: true,
      items: items.map((i) => ({
        name: i.name,
        priceCents: i.priceCents,
        price: (i.priceCents / 100).toFixed(2),
        variationId: i.variationId,
      })),
    });
  } catch (e) {
    console.error('items error:', e?.response?.data || e.message);
    res.status(500).json({ success: false, error: 'Failed to fetch items' });
  }
});

// Create an Order (no payment)
app.post('/api/create-order', async (req, res) => {
  try {
    const { items_json, notes, customer_name, customer_phone, customer_email } =
      req.body || {};

    if (!items_json) {
      return res
        .status(400)
        .json({ success: false, error: 'items_json is required' });
    }

    let requested;
    try {
      requested = JSON.parse(items_json);
    } catch {
      return res
        .status(400)
        .json({ success: false, error: 'items_json must be valid JSON' });
    }

    if (!Array.isArray(requested) || requested.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'No line items provided' });
    }

    // Load current menu from Square
    const menu = await fetchCatalogItems();
    const byName = new Map(menu.map((m) => [normalizeName(m.name), m]));

    // Build order line_items with catalog prices (no SDK)
    const line_items = [];
    for (const r of requested) {
      const name = normalizeName(r?.name);
      const qty = Number(r?.quantity || 1);
      if (!name || !Number.isFinite(qty) || qty < 1) continue;

      const match = byName.get(name);
      if (!match) {
        // strict: do not create orders with unknown items
        const allowed = menu.map((m) => m.name).join(', ');
        return res.status(400).json({
          success: false,
          error: `Unknown item "${r?.name}". Allowed: ${allowed}`,
        });
      }

      line_items.push({
        name: match.name,
        quantity: String(qty),
        base_price_money: {
          amount: match.priceCents,
          currency: 'USD',
        },
      });
    }

    if (line_items.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'No valid line items after matching' });
    }

    const idempotency_key = crypto.randomUUID();
    const reference_id = `web-${Date.now()}`;

    const body = {
      idempotency_key,
      order: {
        location_id: LOCATION_ID,
        reference_id,
        line_items,
        fulfillments: [], // none (pickup/delivery optional later)
        metadata: {
          customer_name: customer_name || '',
          customer_phone: customer_phone || '',
          customer_email: customer_email || '',
        },
        // human-facing note
        note: notes || '',
      },
    };

    const url = `${BASE}/v2/orders`;
    const r = await axios.post(url, body, { headers: authHeaders });
    const orderId = r.data?.order?.id;

    console.log('✅ Order created:', orderId);
    return res.json({
      success: true,
      orderId,
      message: 'Order created in Square (unpaid).',
    });
  } catch (e) {
    console.error('create-order error:', e?.response?.data || e.message);
    res
      .status(500)
      .json({ success: false, error: 'Failed to create order in Square' });
  }
});

// Fetch a single order by id (handy for verifying from the browser)
app.get('/api/order/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const url = `${BASE}/v2/orders/${id}`;
    const r = await axios.get(url, { headers: authHeaders });
    res.json({ success: true, order: r.data.order });
  } catch (e) {
    console.error('get-order error:', e?.response?.data || e.message);
    res.status(500).json({ success: false, error: 'Failed to fetch order' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT} [${ENV}]`);
});
