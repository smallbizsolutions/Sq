import express from "express";
import cors from "cors";

const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_LOCATION_ID,
  SQUARE_ENVIRONMENT = "sandbox"
} = process.env;

if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.error("❌ Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID");
}

const BASE =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const app = express();
app.use(cors());
app.use(express.json());

async function sq(path, init = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.errors?.map(e => e.detail).join("; ") || res.statusText;
    throw new Error(`Square ${res.status} ${path} – ${msg}`);
  }
  return data;
}

app.get("/", (_, r) =>
  r.json({ ok: true, env: SQUARE_ENVIRONMENT, location: SQUARE_LOCATION_ID })
);

// --- MENU: return items with first-priced variation ---
app.get("/api/items", async (req, res) => {
  try {
    const out = [];
    let cursor;
    do {
      const q = new URLSearchParams({ types: "ITEM", ...(cursor && { cursor }) });
      const data = await sq(`/v2/catalog/list?${q.toString()}`);
      cursor = data.cursor;
      (data.objects || []).forEach(obj => {
        const item = obj.item_data;
        if (!item) return;
        const priced = (item.variations || [])
          .map(v => ({
            variationId: v.id,
            priceCents: v.item_variation_data?.price_money?.amount ?? null
          }))
          .filter(v => v.priceCents !== null);
        if (!priced.length) return;
        const v0 = priced[0];
        out.push({
          itemId: obj.id,
          name: item.name,
          variationId: v0.variationId,
          priceCents: v0.priceCents,
          price: (v0.priceCents / 100).toFixed(2)
        });
      });
    } while (cursor);
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, items: out });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// --- CREATE ORDER ---
app.post("/api/create-order", async (req, res) => {
  const t0 = Date.now();
  try {
    let { items_json, customer_name, customer_email, customer_phone, notes } = req.body || {};
    if (!items_json) return res.status(400).json({ success: false, error: "items_json required" });

    let items = items_json;
    if (typeof items_json === "string") items = JSON.parse(items_json);
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, error: "No line items provided" });

    // Map names -> variationId if needed
    const needLookup = items.some(i => !i.variationId);
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
        console.log("❌ Unknown item in request:", it);
        return res.status(400).json({ success: false, error: `Unknown item: ${it.name || "(no name)"}` });
      }
      line_items.push({ quantity: qty, catalog_object_id: variationId });
    }

    const idempotency_key = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const payload = {
      idempotency_key,
      order: {
        location_id: SQUARE_LOCATION_ID,
        line_items,
        ...(notes ? { note: notes } : {})
      }
    };

    console.log("➡️  POST /v2/orders", JSON.stringify(payload));
    const created = await sq(`/v2/orders`, { method: "POST", body: JSON.stringify(payload) });
    const orderId = created?.order?.id || null;
    console.log("✅ Square order created:", orderId, "in", Date.now() - t0, "ms");

    res.json({ success: true, orderId, message: "Order created." });
  } catch (e) {
    console.log("❌ Create-order failed:", e?.message || e);
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// --- RECENT ORDERS VIEW ---
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
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// --- ONE-CLICK SANDBOX TEST (creates 1 order using first menu item) ---
app.post("/api/debug/sample-order", async (req, res) => {
  try {
    const menu = await (await fetch(`${req.protocol}://${req.get("host")}/api/items`)).json();
    const first = (menu.items || [])[0];
    if (!first) return res.status(400).json({ success: false, error: "No priced items in catalog" });

    const body = {
      items_json: JSON.stringify([{ variationId: first.variationId, quantity: 1 }]),
      customer_name: "Sandbox Tester",
      customer_phone: "000-000-0000",
      notes: "debug sample"
    };
    const r = await fetch(`${req.protocol}://${req.get("host")}/api/create-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    res.status(r.status).json({ fromDebug: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
