// server.js
// Minimal Express API for Square Sandbox/Prod without SDK.
// Env needed: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT (sandbox|production), PORT(optional)

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- Square helpers ----------
const SQ_ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
const BASE = SQ_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const AUTH_HEADER = {
  'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

function reqOk() {
  if (!process.env.SQUARE_ACCESS_TOKEN) throw new Error('Missing SQUARE_ACCESS_TOKEN');
  if (!process.env.SQUARE_LOCATION_ID) throw new Error('Missing SQUARE_LOCATION_ID');
}

// Normalize names so "Fries"/"fries." match
const norm = s => (s || '').toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

// Build a simple in-memory menu map from Square Catalog (ITEM + default variation)
async function fetchMenuMap() {
  reqOk();

  // Pull items; embed variations from the ITEM object
  const url = `${BASE}/v2/catalog/list?types=ITEM`;
  const res = await fetch(url, { headers: AUTH_HEADER });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Catalog list failed: ${res.status} ${txt}`);
  }
  const data = await res.json();

  const mapByName = new Map(); // name -> { itemId, variationId, name, priceCents }
  const items = [];

  for (const obj of (data.objects || [])) {
    if (obj.type !== 'ITEM' || !obj.itemData) continue;
    const name = obj.itemData.name || 'Unnamed';
    const variations = obj.itemData.variations || [];
    if (!variations.length) continue;

    // choose the first variation as default (common in sandbox)
    const v = variations[0];
    const variationId = v.id;
    const priceCents = v.itemVariationData?.priceMoney?.amount ?? null;

    const entry = {
      itemId: obj.id,
      variationId,
      name,
      priceCents,
      price: priceCents != null ? (priceCents / 100) : null
    };

    mapByName.set(norm(name), entry);
    items.push(entry);
  }

  return { mapByName, items };
}

// ---------- Routes ----------

app.get('/health', (req, res) => {
  res.json({ ok: true, env: SQ_ENV });
});

// Returns a lightweight menu array the agent can read aloud
app.get('/api/menu', async (req, res) => {
  try {
    const { items } = await fetchMenuMap();
    res.json({
      success: true,
      items: items.map(i => ({
        itemId: i.itemId,
        variationId: i.variationId,
        name: i.name,
        priceCents: i.priceCents,
        price: i.price
      }))
    });
  } catch (err) {
    console.error('GET /api/menu error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch menu' });
  }
});

// Create a PICKUP order (pay at counter)
app.post('/api/create-order', async (req, res) => {
  try {
    reqOk();

    // Accept either items_json (string) or items (array)
    let requested = req.body.items || [];
    if (!requested.length && typeof req.body.items_json === 'string') {
      try { requested = JSON.parse(req.body.items_json); } catch { /* ignore */ }
    }

    if (!Array.isArray(requested) || !requested.length) {
      return res.status(400).json({ success: false, error: 'No line items provided' });
    }

    // Map to variation IDs if only names were provided
    const { mapByName } = await fetchMenuMap();

    // requested items can be:
    //   {variationId, quantity}  OR  {name, quantity}
    const lineItems = [];
    for (const r of requested) {
      const qtyNum = Number(r.quantity ?? 1);
      const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? String(qtyNum) : '1';

      let variationId = r.variationId;
      let displayName = r.name;

      if (!variationId) {
        const found = mapByName.get(norm(r.name));
        if (!found) {
          // Strict: reject unknown to avoid the "random first item" bug
          return res.status(400).json({ success: false, error: `Unknown menu item: ${r.name}` });
        }
        variationId = found.variationId;
        displayName = found.name;
      }

      lineItems.push({
        quantity: qty,
        catalogObjectId: variationId,
        // Optional: add note to line item for the kitchen
        // note: r.note || undefined
      });
    }

    // Build PICKUP fulfillment so it shows up in Orders/KDS
    const fulfillment = {
      type: 'PICKUP',
      state: 'PROPOSED',
      pickupDetails: {
        scheduleType: req.body?.pickup_at ? 'SCHEDULED' : 'ASAP',
        pickupAt: req.body?.pickup_at || undefined, // RFC3339 if provided
        recipient: {
          displayName: req.body?.customer_name || 'Guest',
          phoneNumber: req.body?.customer_phone || undefined
        },
        note: req.body?.notes || undefined
      }
    };

    const payload = {
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems,
        fulfillments: [fulfillment],
        ticketName: req.body?.customer_name || undefined,
        referenceId: req.body?.customer_phone || undefined,
        note: req.body?.notes || undefined
      }
    };

    const resp = await fetch(`${BASE}/v2/orders`, {
      method: 'POST',
      headers: AUTH_HEADER,
      body: JSON.stringify(payload)
    });

    const body = await resp.json();
    if (!resp.ok) {
      console.error('Square create order failed:', resp.status, body);
      return res.status(502).json({ success: false, error: 'Square order creation failed', details: body });
    }

    const orderId = body.order?.id || null;
    return res.json({
      success: true,
      orderId,
      message: 'Order created as PICKUP. Pay at counter.'
    });

  } catch (err) {
    console.error('POST /api/create-order error:', err);
    res.status(500).json({ success: false, error: 'Server error creating order' });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API on :${PORT} (${SQ_ENV})`);
});
