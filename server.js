import express from "express";
import cors from "cors";

/** --------- ENV --------- */
const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_LOCATION_ID,
  SQUARE_ENVIRONMENT = "sandbox"
} = process.env;

if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.error("Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID env vars.");
}

const BASE =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

/** --------- APP --------- */
const app = express();
app.use(cors());
app.use(express.json());

/** Small helper to call Square REST */
async function sq(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.errors?.map(e => e.detail).join("; ") || res.statusText;
    throw new Error(`Square ${res.status} ${path} – ${msg}`);
  }
  return data;
}

/** Health */
app.get("/", (_, r) =>
  r.json({ ok: true, env: SQUARE_ENVIRONMENT, location: SQUARE_LOCATION_ID })
);

/** Get menu (ITEMs with first variation + price) */
app.get("/api/items", async (req, res) => {
  try {
    const out = [];
    let cursor = undefined;

    do {
      const q = new URLSearchParams({ types: "ITEM", ...(cursor && { cursor }) });
      const data = await sq(`/v2/catalog/list?${q.toString()}`);
      cursor = data.cursor;

      (data.objects || []).forEach(obj => {
        const item = obj.item_data;
        if (!item) return;

        // Find first sellable variation with a price
        const variations = (item.variations || [])
          .map(v => ({
            variationId: v.id,
            priceCents: v.item_variation_data?.price_money?.amount ?? null
          }))
          .filter(v => v.priceCents !== null);

        if (variations.length === 0) return;

        const first = variations[0];
        out.push({
          itemId: obj.id,
          name: item.name,
          variationId: first.variationId,
          priceCents: first.priceCents,
          price: (first.priceCents / 100).toFixed(2)
        });
      });
    } while (cursor);

    // Optional: keep it predictable
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, items: out });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

/** Create order
 * Body:
 * {
 *   items_json: stringified array of { name?: string, variationId?: string, quantity: number }
 *   customer_name?: string
 *   customer_email?: string
 *   customer_phone?: string
 *   notes?: string
 * }
 */
app.post("/api/create-order", async (req, res) => {
  try {
    let { items_json, customer_name, customer_email, customer_phone, notes } = req.body || {};
    if (!items_json) {
      return res.status(400).json({ success: false, error: "items_json required" });
    }

    // Parse incoming items
    let items = items_json;
    if (typeof items_json === "string") items = JSON.parse(items_json);

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "No line items provided" });
    }

    // Make sure we have variationIds. If only names were provided, map them.
    const needLookup = items.some(it => !it.variationId);
    let menuByName = {};
    if (needLookup) {
      const menuResp = await (await fetch(`${req.protocol}://${req.get("host")}/api/items`)).json();
      (menuResp.items || []).forEach(i => (menuByName[i.name.toLowerCase()] = i));
    }

    const line_items = [];
    for (const it of items) {
      const qty = String(Math.max(1, parseInt(it.quantity || 1, 10)));
      let variationId = it.variationId;

      if (!variationId && it.name) {
        const hit = menuByName[it.name.toLowerCase()];
        if (hit) variationId = hit.variationId;
      }
      if (!variationId) {
        return res.status(400).json({
          success: false,
          error: `Unknown item: ${it.name || "(no name)"}`
        });
      }
      line_items.push({ quantity: qty, catalog_object_id: variationId });
    }

    const idempotency_key = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const body = {
      idempotency_key,
      order: {
        location_id: SQUARE_LOCATION_ID,
        line_items,
        ...(notes ? { note: notes } : {})
      }
    };

    const created = await sq(`/v2/orders`, {
      method: "POST",
      body: JSON.stringify(body)
    });

    const orderId = created?.order?.id || null;
    res.json({
      success: true,
      orderId,
      message: orderId ? "Order created." : "Order created (no id returned)."
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

/** Quick viewer for recent orders (helps you verify without hunting around UI) */
app.get("/api/orders", async (req, res) => {
  try {
    const data = await sq(`/v2/orders/search`, {
      method: "POST",
      body: JSON.stringify({
        location_ids: [SQUARE_LOCATION_ID],
        query: { sort: { sort_field: "CREATED_AT", sort_order: "DESC" } },
        limit: 20
      })
    });
    res.json({ success: true, orders: data?.orders || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
