// Robust Square sandbox order API for Vapi
const express = require('express');
const cors = require('cors');
const { Client, Environment } = require('square');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- ENV ----
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;    // EAAA...
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID;     // L8CJJ792FCGGT
const ENVIRONMENT  = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();

if (!ACCESS_TOKEN || !LOCATION_ID) {
  console.warn('⚠️ Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID env var.');
}

const client = new Client({
  accessToken: ACCESS_TOKEN,
  environment: ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
});

// ---- HELPERS ----
const parseItemsFromBody = (body) => {
  // Accept items in many shapes:
  //  - body.items_json (string or array)
  //  - body.items (array)
  //  - body.line_items (array)
  //  Each element: { variationId: string, quantity: number }
  let src =
    body.items ??
    body.line_items ??
    body.items_json;

  // If it's a string, try to JSON.parse
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { src = null; }
  }

  // Normalize and validate
  if (!Array.isArray(src)) return [];
  const normalized = src
    .map(it => ({
      variationId: it.variationId || it.catalogObjectId || it.id,
      quantity: String(it.quantity ?? 1),
    }))
    .filter(it => typeof it.variationId === 'string' && it.variationId.length > 0);

  return normalized;
};

const pickFirstCatalogVariation = async () => {
  // Fallback: grab first ITEM + first VARIATION for demo reliability
  const { result } = await client.catalogApi.listCatalog(undefined, 'ITEM');
  const items = (result.objects || [])
    .filter(o => o.type === 'ITEM' && o.itemData && (o.itemData.variations || []).length);
  if (!items.length) return null;

  const firstVar = items[0].itemData.variations[0];
  return {
    variationId: firstVar.id,
    quantity: '1',
    name: items[0].itemData.name,
  };
};

// ---- ROUTES ----

// Health
app.get('/', (req, res) => res.json({ ok: true, env: ENVIRONMENT }));

// List simple menu for the agent (id + name + first variation + price)
app.get('/api/items', async (req, res) => {
  try {
    const { result } = await client.catalogApi.listCatalog(undefined, 'ITEM');
    const out = [];

    for (const obj of result.objects || []) {
      const item = obj.itemData;
      if (!item || !item.variations || !item.variations.length) continue;

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

// Create order
app.post('/api/create-order', async (req, res) => {
  try {
    let lineReq = parseItemsFromBody(req.body);

    // If caller sends nothing valid, auto-fill first catalog item (sandbox demo)
    let fallbackUsed = false;
    if (!lineReq.length) {
      const fallback = await pickFirstCatalogVariation();
      if (!fallback) {
        return res.status(200).json({ success: false, error: 'No line items provided' });
      }
      lineReq = [{ variationId: fallback.variationId, quantity: '1' }];
      fallbackUsed = true;
    }

    // Square line items
    const lineItems = lineReq.map(it => ({
      quantity: String(it.quantity || '1'),
      catalogObjectId: it.variationId,
    }));

    const { result } = await client.ordersApi.createOrder({
      order: {
        locationId: LOCATION_ID,
        lineItems,
        // Optional: attach a note for quick tracing during demos
        note: req.body?.notes || (fallbackUsed ? 'Auto-filled first catalog item' : undefined),
      },
    });

    const orderId = result?.order?.id || null;
    if (!orderId) {
      console.error('createOrder missing orderId:', result);
      return res.status(200).json({ success: false, error: 'Order creation failed' });
    }

    return res.status(200).json({
      success: true,
      orderId,
      message: fallbackUsed ? 'No items passed; used first catalog item.' : 'Order created.',
    });
  } catch (err) {
    console.error('create-order error:', err);
    const msg = err?.errors?.[0]?.detail || err.message || 'Unknown error';
    return res.status(200).json({ success: false, error: msg });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server listening on :${PORT}`));
