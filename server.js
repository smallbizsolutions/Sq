// server.js
// Minimal Square REST bridge for VAPI. No SDK. Works in Sandbox.
// Env required on Railway:
//   SQUARE_ACCESS_TOKEN = EAAA...  (Sandbox test account token)
//   SQUARE_LOCATION_ID  = L8CJJ792FCGGT (your sandbox location id)
//   SQUARE_ENVIRONMENT  = sandbox
// Optional:
//   SQUARE_VERSION      = 2024-08-21

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Square REST client (axios) --------------------------------------------
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID  || "";
const ENV          = (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase();
const SQUARE_VERSION = process.env.SQUARE_VERSION || "2024-08-21";

const BASE_URL =
  ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

const sq = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  },
  // Square can be a bit slow in Sandbox—don’t fail too fast
  timeout: 15000,
});

// Quick sanity to avoid silent confusion
function assertEnv() {
  const missing = [];
  if (!ACCESS_TOKEN) missing.push("SQUARE_ACCESS_TOKEN");
  if (!LOCATION_ID) missing.push("SQUARE_LOCATION_ID");
  if (!ENV) missing.push("SQUARE_ENVIRONMENT");
  if (missing.length) {
    throw new Error(
      `Missing env: ${missing.join(
        ", "
      )}. Set them in Railway -> Variables and redeploy.`
    );
  }
}
assertEnv();

// ---- Health ----------------------------------------------------------------
app.get("/", (_req, res) => res.send("✅ API is running"));
app.get("/health", (_req, res) =>
  res.json({ status: "ok", env: ENV, ts: new Date().toISOString() })
);

// ---- Menu cache (in-memory) ------------------------------------------------
let MENU_CACHE = { items: [], builtAt: 0 };
const MENU_TTL_MS = 60_000; // 60s

async function fetchMenu() {
  const now = Date.now();
  if (MENU_CACHE.items.length && now - MENU_CACHE.builtAt < MENU_TTL_MS) {
    return MENU_CACHE.items;
  }

  // Pull ITEMS + VARIATIONS so we can get prices from variations
  const resp = await sq.get("/v2/catalog/list", {
    params: { types: "ITEM,ITEM_VARIATION" },
  });

  const objects = resp.data.objects || [];
  const itemsById = new Map();
  const firstVariationByItemId = new Map();

  for (const obj of objects) {
    if (obj.type === "ITEM" && obj.item_data) {
      itemsById.set(obj.id, {
        id: obj.id,
        name: obj.item_data.name,
      });
    }
  }
  for (const obj of objects) {
    if (obj.type === "ITEM_VARIATION" && obj.item_variation_data) {
      const v = obj.item_variation_data;
      const price = v.price_money?.amount ?? null; // cents
      const itemId = v.item_id;
      if (!firstVariationByItemId.has(itemId) && price != null) {
        firstVariationByItemId.set(itemId, { variationId: obj.id, priceCents: price });
      }
    }
  }

  const menu = [];
  for (const [itemId, item] of itemsById.entries()) {
    const v = firstVariationByItemId.get(itemId);
    // Only include items we can price (keeps the demo simple)
    if (v) {
      menu.push({
        itemId,
        name: item.name,
        variationId: v.variationId,
        priceCents: v.priceCents,
        price: (v.priceCents / 100).toFixed(2),
      });
    }
  }

  MENU_CACHE = { items: menu, builtAt: now };
  return menu;
}

// GET /api/items — what the agent can sell
app.get("/api/items", async (_req, res) => {
  try {
    const items = await fetchMenu();
    return res.json({ success: true, items });
  } catch (err) {
    console.error("Failed to fetch items:", err?.response?.data || err.message);
    return res.status(200).json({ success: false, error: "Failed to fetch items" });
  }
});

// POST /api/create-order — create a Square Order (no payment)
// Body accepted from VAPI tool:
//   { items_json: '[{"name":"Burger","quantity":2}]', customer_name, customer_phone, notes }
app.post("/api/create-order", async (req, res) => {
  try {
    const {
      items_json,
      customer_name,
      customer_email,
      customer_phone,
      notes,
    } = req.body || {};

    // Parse items robustly (VAPI sometimes sends strings/arrays)
    let items = [];
    try {
      if (Array.isArray(items_json)) {
        items = items_json;
      } else if (typeof items_json === "string") {
        const parsed = JSON.parse(items_json);
        items = Array.isArray(parsed) ? parsed : [parsed];
      } else if (typeof items_json === "object" && items_json) {
        items = [items_json];
      }
    } catch (_e) {
      // ignore
    }
    if (!items.length) {
      return res.status(200).json({
        success: false,
        error: "No line items provided",
      });
    }

    // Build a name->price map from menu
    const menu = await fetchMenu();
    const priceMap = new Map(menu.map((m) => [m.name.toLowerCase(), m.priceCents]));

    // Build Square line_items. We’ll use ad-hoc pricing for simplicity
    // so we don’t need catalog IDs. Sandbox allows this.
    const line_items = items.map((it) => {
      const name = String(it.name || "").trim();
      const qty = String(it.quantity || 1);
      const lookup = priceMap.get(name.toLowerCase());
      const cents =
        lookup != null
          ? lookup
          : Math.round(Number(it.price ?? 0) * 100);

      return {
        name: name || "Item",
        quantity: /^\d+(\.\d+)?$/.test(qty) ? qty : "1",
        base_price_money: { amount: Number.isFinite(cents) ? cents : 0, currency: "USD" },
      };
    });

    const idempotency_key = uuidv4();
    const body = {
      idempotency_key,
      order: {
        location_id: LOCATION_ID,
        line_items,
        reference_id: "phone-agent",
        note: notes || undefined,
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED"
          }
        ],
      },
    };

    const resp = await sq.post("/v2/orders", body);
    const order = resp.data.order;

    return res.status(200).json({
      success: true,
      order_id: order?.id,
      state: order?.state,
      total_money: order?.total_money,
      line_items: order?.line_items,
      debug: { idempotency_key },
    });
  } catch (err) {
    // Never 400 to VAPI—always 200 with details
    const data = err?.response?.data;
    console.error("Create order failed:", data || err.message);
    return res.status(200).json({
      success: false,
      error: "Create order failed",
      square_error: data || String(err.message || err),
    });
  }
});

// ---- Start -----------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT} (${ENV})`);
});
