// server.js — Square sandbox order API for Vapi (name or variationId)
const express = require('express');
const cors = require('cors');
const { Client, Environment } = require('square');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- ENV ----
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID;
const ENVIRONMENT  = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();

const client = new Client({
  accessToken: ACCESS_TOKEN,
  environment: ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
});

// ---- HELPERS ----
const parseIncomingItems = (body) => {
  // Accept many shapes: items_json (string/array), items, line_items
  let src = body.items ?? body.line_items ?? body.items_json;
  if (typeof src === 'string') { try { src = JSON.parse(src); } catch { /* ignore */ } }
  if (!Array.isArray(src)) return [];
  return src.map(i => ({
    // allow variationId OR name
    variationId: i.variationId || i.catalogObjectId || i.id || null,
    name: i.name || i.itemName || null,
    quantity: String(i.quantity ?? 1),
  }));
};

const resolveNamesToVariations = async (items) => {
  // For any item with a name but no variationId, search catalog by text and pick first variation
  const needLookup = items.filter(i => !i.variationId && i.name);
  for (const it of needLookup) {
    try {
      const { result } = await client.catalogApi.searchCatalogObjects({
        objectTypes: ['ITEM'],
        query: { textFilter: it.name }
      });
      const found = (result?.objects || []).find(o =>
        o.itemData?.name?.toLowerCase() === it.name.toLowerCase()
      ) || (result?.objects || [])[0];

      const v = found?.itemData?.variations?.[0];
      if (v?.id) it.variationId = v.id;
    } catch { /* keep going */ }
  }
  return items.filter(i => i.variationId); // drop anything unresolved
};

const pickFirstCatalogVariation = async () => {
  const { result } = await client.catalogApi.listCatalog(undefined, 'ITEM');
  const items = (result.objects || [])
    .filter(o => o.type === 'ITEM' && o.itemData?.variations?.length);
  if (!items.length) return null;
  return { variationId: items[0].itemData.variations[0].id, quantity: '1' };
};

// ---- ROUTES ----
app.get('/', (req, res) => res.json({ ok: true, env: ENVIRONMENT }));

app.get('/api/items', async (req, res) => {
  try {
    const { result } = await client.catalogApi.listCatalog(undefined, 'ITEM');
    const out = [];
    for (const obj of result.objects || []) {
      const item = obj.itemData;
      if (!item?.variations?.length) continue;
      const v = item.variations[0];
      const priceCents = v.itemVariationData?.priceMoney?.amount ?? null;
      out.push({
        itemId: obj.id,
        name: item.name,
        variationId: v.id,
        priceCents,
        price: priceCents != null ? (priceCents / 100).toFixed(2) : null,
      });
    }
    res.json({ success: true, items: out });
  } catch (err) {
    console.error('items error:', err);
    res.status(200).json({ success: false, error: 'Failed to fetch items' });
  }
});

app.post('/api/create-order', async (req, res) => {
  try {
    let items = parseIncomingItems(req.body);
    if (items.length) items = await resolveNamesToVariations(items);

    let usedFallback = false;
    if (!items.length) {
      const fb = await pickFirstCatalogVariation();
      if (!fb) return res.status(200).json({ success: false, error: 'No line items provided' });
      items = [fb];
      usedFallback = true;
    }

    const lineItems = items.map(i => ({
      quantity: i.quantity || '1',
      catalogObjectId: i.variationId,
    }));

    const { result } = await client.ordersApi.createOrder({
      order: {
        locationId: LOCATION_ID,
        lineItems,
        note: req.body?.notes || (usedFallback ? 'Auto-filled first catalog item' : undefined),
      },
    });

    const orderId = result?.order?.id;
    if (!orderId) return res.status(200).json({ success: false, error: 'Order creation failed' });

    res.status(200).json({
      success: true,
      orderId,
      message: usedFallback ? 'No items passed; used first catalog item.' : 'Order created.'
    });
  } catch (err) {
    console.error('create-order error:', err);
    const msg = err?.errors?.[0]?.detail || err.message || 'Unknown error';
    res.status(200).json({ success: false, error: msg });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));
