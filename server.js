import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const ENV = (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase();

// Square base URL
const BASE =
  ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

// Common headers for Square
const SQ_HEADERS = {
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  Accept: "application/json",
  "Content-Type": "application/json",
  // Any recent Square version string is fine; keep it stable
  "Square-Version": "2024-08-21",
};

// Simple health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, env: ENV, time: new Date().toISOString() });
});

// --- MENU ---------------------------------------------------------------

let cachedMenu = null;
let cachedAt = 0;

async function fetchMenu() {
  const now = Date.now();
  if (cachedMenu && now - cachedAt < 60_000) return cachedMenu;

  const url = `${BASE}/v2/catalog/list?types=ITEM,ITEM_VARIATION`;
  const r = await fetch(url, { headers: SQ_HEADERS });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`catalog list failed: ${r.status} ${txt}`);
  }
  const data = await r.json();
  const objs = data.objects || [];

  // Build item name -> variation mapping
  const itemNameById = new Map();
  for (const o of objs) {
    if (o.type === "ITEM") {
      const name = o.item_data?.name;
      if (name) itemNameById.set(o.id, name);
    }
  }

  const items = [];
  for (const o of objs) {
    if (o.type === "ITEM_VARIATION") {
      const itemId = o.item_variation_data?.item_id;
      const name = itemNameById.get(itemId);
      if (!name) continue;

      const variationId = o.id;
      const priceCents = o.item_variation_data?.price_money?.amount ?? null;

      items.push({
        itemId,
        name,
        variationId,
        priceCents,
        price: priceCents != null ? (priceCents / 100).toFixed(2) : null,
      });
    }
  }

  cachedMenu = items;
  cachedAt = now;
  return items;
}

app.get("/api/menu", async (_req, res) => {
  try {
    const items = await fetchMenu();
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// --- ORDER (pickup only) -----------------------------------------------

app.post("/api/create-order", async (req, res) => {
  try {
    const {
      items,           // preferred: [{name, quantity}]
      items_json,      // fallback: stringified JSON
      customer_name,
      customer_phone,
      customer_email,
      notes,
    } = req.body || {};

    // Normalize incoming items
    let parsed = [];
    if (Array.isArray(items)) parsed = items;
    else if (typeof items_json === "string") {
      try { parsed = JSON.parse(items_json); } catch { parsed = []; }
    }

    const menu = await fetchMenu();
    const byName = new Map(menu.map(m => [m.name.trim().toLowerCase(), m]));

    const line_items = [];
    for (const it of parsed) {
      const rawName = it?.name ?? it?.item ?? it?.product;
      if (!rawName) continue;
      const found = byName.get(String(rawName).trim().toLowerCase());
      if (!found) continue; // ignore off-menu
      const qty = String(it?.quantity ?? it?.qty ?? 1);
      line_items.push({
        catalog_object_id: found.variationId,
        quantity: qty,
      });
    }

    if (line_items.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No valid line items provided" });
    }

    const idempotency_key = crypto.randomUUID();

    const body = {
      idempotency_key,
      order: {
        location_id: LOCATION_ID,
        line_items,
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              recipient: {
                display_name: customer_name || "Guest",
                phone_number: customer_phone || undefined,
                email_address: customer_email || undefined,
              },
              note: notes || undefined,
            },
          },
        ],
      },
    };

    const r = await fetch(`${BASE}/v2/orders`, {
      method: "POST",
      headers: SQ_HEADERS,
      body: JSON.stringify(body),
    });

    const json = await r.json();

    if (!r.ok) {
      return res
        .status(r.status)
        .json({ success: false, error: json?.errors || json });
    }

    const orderId = json?.order?.id || null;
    return res.json({
      success: true,
      orderId,
      message: "Order created (pickup).",
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server up on :${PORT}`);
});
