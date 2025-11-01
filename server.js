// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const {
  Client,
  Environment,
} = require('@square/square');

const app = express();
app.use(cors());
app.use(express.json());

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase() === 'production'
  ? Environment.Production
  : Environment.Sandbox;

if (!ACCESS_TOKEN || !LOCATION_ID) {
  console.error('Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID');
}

const sq = new Client({
  accessToken: ACCESS_TOKEN,
  environment: ENV,
});

const catalogApi = sq.catalogApi;
const ordersApi  = sq.ordersApi;

// in-memory cache of menu [{name, variationId, priceCents}]
let MENU = [];

// pull items once on boot, and on demand
async function loadMenu() {
  const { result } = await catalogApi.listCatalog(undefined, 'ITEM');
  const items = (result.objects || [])
    .filter(o => o.type === 'ITEM')
    .map(o => {
      const item = o.itemData;
      const v = (item?.variations || [])[0];
      const price = v?.itemVariationData?.priceMoney?.amount ?? 0;
      return {
        itemId: o.id,
        name: item?.name?.trim() || 'Unnamed',
        variationId: v?.id,
        priceCents: Number(price),
        price: (Number(price) / 100).toFixed(2),
      };
    })
    .filter(x => x.variationId);
  MENU = items;
  return MENU;
}

// health
app.get('/health', (_, res) => res.json({ ok: true }));

// get menu (and auto-refresh cache if empty)
app.get('/api/items', async (_, res) => {
  try {
    if (!MENU.length) await loadMenu();
    res.json({ success: true, items: MENU });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'Failed to fetch items' });
  }
});

// simple formatted menu for Vapi "getMenu" tool (reads cleanly)
app.get('/api/menu', async (_, res) => {
  try {
    if (!MENU.length) await loadMenu();
    const list = MENU.map(i => `${i.name} $${i.price}`).join(', ');
    res.json({ success: true, text: `Our menu: ${list}.` });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Menu unavailable' });
  }
});

// create order
// body: { items_json: stringified [{name,quantity}], customer_name?, customer_phone?, notes? }
app.post('/api/create-order', async (req, res) => {
  try {
    const { items_json, customer_name, customer_phone, notes } = req.body || {};
    if (!items_json) return res.status(400).json({ success: false, error: 'items_json required' });

    if (!MENU.length) await loadMenu();

    let requested;
    try { requested = JSON.parse(items_json); }
    catch { return res.status(400).json({ success: false, error: 'items_json must be valid JSON' }); }

    if (!Array.isArray(requested) || !requested.length) {
      return res.status(400).json({ success: false, error: 'No line items provided' });
    }

    // map names to catalog variations (case-insensitive exact match)
    const nameMap = new Map(MENU.map(m => [m.name.toLowerCase(), m]));
    const lineItems = [];

    for (const r of requested) {
      const q = Number(r.quantity ?? 1);
      const key = String(r.name || '').trim().toLowerCase();
      const found = nameMap.get(key);
      if (!found) {
        return res.status(400).json({ success: false, error: `Unknown item: ${r.name}` });
      }
      lineItems.push({
        catalogObjectId: found.variationId,
        quantity: String(q > 0 ? q : 1),
      });
    }

    const order = {
      locationId: LOCATION_ID,
      lineItems,
      fulfillments: [], // no fulfillment or payment in this demo
      // drop customer info into order `note` so we can see it in logs
      note: [
        notes ? `Notes: ${notes}` : null,
        customer_name ? `Name: ${customer_name}` : null,
        customer_phone ? `Phone: ${customer_phone}` : null,
      ].filter(Boolean).join(' | ')
    };

    const { result } = await ordersApi.createOrder({ order });
    const orderId = result.order?.id;

    return res.json({
      success: true,
      orderId,
      message: orderId ? 'Order created (no payment attached in sandbox demo)' : 'Created, but no ID returned',
    });
  } catch (e) {
    console.error('create-order error:', e);
    const msg = e?.result?.errors?.[0]?.detail || e.message || 'Create order failed';
    res.status(500).json({ success: false, error: msg });
  }
});

// retrieve order for verification in browser
app.get('/api/order/:id', async (req, res) => {
  try {
    const { result } = await ordersApi.retrieveOrder(req.params.id);
    res.json({ success: true, order: result.order });
  } catch (e) {
    const msg = e?.result?.errors?.[0]?.detail || e.message || 'Retrieve failed';
    res.status(500).json({ success: false, error: msg });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API running on :${PORT}`));
