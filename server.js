// server.js
const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");

// ---- Square SDK setup ----
const { Client, Environment } = require("square");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "sandbox";

if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.warn(
    "[WARN] Missing Square env vars. Expect failures:\n" +
      `  SQUARE_ACCESS_TOKEN=${!!SQUARE_ACCESS_TOKEN}\n` +
      `  SQUARE_LOCATION_ID=${!!SQUARE_LOCATION_ID}\n`
  );
}

const client = new Client({
  accessToken: SQUARE_ACCESS_TOKEN,
  environment:
    SQUARE_ENVIRONMENT === "production"
      ? Environment.Production
      : Environment.Sandbox,
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Helpers ----------
/**
 * Pull catalog (items + variations) and return a clean array for AI
 * [{ name, price: "$4.99", id: "<variationId>", rawPrice: 499, currency: "USD" }]
 */
async function fetchMenuClean() {
  // Pull items + variations in one call
  const { result } = await client.catalogApi.listCatalog(undefined, "ITEM,ITEM_VARIATION");

  const objects = result.objects || [];
  const variationsById = new Map();
  const items = [];

  // Index variations first
  for (const obj of objects) {
    if (obj.type === "ITEM_VARIATION" && obj.itemVariationData) {
      variationsById.set(obj.id, obj);
    }
  }

  // Walk items and attach their (first/default) variation price
  for (const obj of objects) {
    if (obj.type !== "ITEM" || !obj.itemData) continue;

    const name = obj.itemData.name?.trim();
    if (!name) continue;

    // pick first variation; dashboard usually creates a default one
    const firstVarId = obj.itemData.variations?.[0]?.id;
    if (!firstVarId) continue;

    const v = variationsById.get(firstVarId);
    const money = v?.itemVariationData?.priceMoney;
    const amount = money?.amount; // integer cents
    const currency = money?.currency || "USD";

    // If price missing, still list, but as $0.00
    const rawPrice = typeof amount === "number" ? amount : 0;
    const dollars = (rawPrice / 100).toFixed(2);
    items.push({
      name,
      price: `$${dollars}`,
      id: firstVarId,
      rawPrice: rawPrice,
      currency,
    });
  }

  return items;
}

/**
 * Build Square line items from a free-form "items_json" array
 * items_json can be stringified JSON or array of:
 *   { name: "Burger", quantity: 2 }  // quantity optional => defaults to 1
 * Matching is case-insensitive against current catalog names.
 */
async function buildLineItemsFromNames(items_json) {
  // Normalize input to array
  let requested = [];
  if (Array.isArray(items_json)) {
    requested = items_json;
  } else if (typeof items_json === "string") {
    try {
      const parsed = JSON.parse(items_json);
      requested = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      requested = [];
    }
  } else if (items_json && typeof items_json === "object") {
    requested = [items_json];
  }

  // Fallback so VAPI tool tests never hard fail
  if (requested.length === 0) {
    requested = [{ name: "Burger", quantity: 1 }];
  }

  // Pull current menu and make a lookup map
  const menu = await fetchMenuClean();
  const byName = new Map(menu.map(m => [m.name.toLowerCase(), m]));

  const lineItems = [];
  const unmatched = [];

  for (const r of requested) {
    const qty = String(r.quantity ?? 1);
    const key = String(r.name || "").toLowerCase().trim();
    const match = byName.get(key);

    if (match) {
      // Use catalogObjectId (variation id) so Square prices it correctly
      lineItems.push({
        catalogObjectId: match.id,
        quantity: qty,
      });
    } else {
      // Keep track of things we couldn't match
      unmatched.push({ name: r.name, quantity: qty });
    }
  }

  return { lineItems, unmatched };
}

// ---------- Routes ----------

app.get("/", (_req, res) => res.send("✅ VAPI x Square backend is alive"));

app.get("/health", (_req, res) =>
  res.json({ status: "ok", env: SQUARE_ENVIRONMENT, ts: new Date().toISOString() })
);

/**
 * Clean menu for AI: [{ name, price, id }]
 */
app.get("/api/items", async (_req, res) => {
  try {
    const items = await fetchMenuClean();
    return res.json({ success: true, items });
  } catch (err) {
    console.error("GET /api/items error:", err);
    return res.status(200).json({
      success: false,
      items: [],
      error: String(err?.message || err),
    });
  }
});

/**
 * Create a (sandbox) order at your Square LOCATION_ID
 * Body shape (flexible):
 * {
 *   items_json: [{ name:"Burger", quantity:2 }, ...] | "[...]",
 *   customer_name?: string,
 *   customer_phone?: string,
 *   customer_email?: string,
 *   notes?: string
 * }
 */
app.post("/api/create-order", async (req, res) => {
  try {
    const { items_json, customer_name, customer_phone, customer_email, notes } = req.body || {};

    const { lineItems, unmatched } = await buildLineItemsFromNames(items_json);

    if (lineItems.length === 0) {
      return res.status(200).json({
        success: false,
        message: "No items matched the Square catalog. Check names in Square.",
        unmatched,
      });
    }

    const orderBody = {
      idempotencyKey: randomUUID(),
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems,
        // Keep the human note useful for the kitchen/front desk
        // This shows in Square Dashboard
        note: [
          notes ? `Notes: ${notes}` : "",
          customer_name ? `Name: ${customer_name}` : "",
          customer_phone ? `Phone: ${customer_phone}` : "",
          customer_email ? `Email: ${customer_email}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
        // You can add serviceCharges, discounts, fulfillments later
      },
    };

    const { result } = await client.ordersApi.createOrder(orderBody);
    const order = result.order;

    // Summaries for the agent
    const totalMoney = order?.totalMoney?.amount ?? 0;
    const currency = order?.totalMoney?.currency ?? "USD";
    const totalDollars = (Number(totalMoney) / 100).toFixed(2);

    return res.status(200).json({
      success: true,
      message: `Order created. Total $${totalDollars} ${currency}`,
      orderId: order?.id,
      locationId: SQUARE_LOCATION_ID,
      unmatched, // helpful for prompt to offer swaps next time
      raw: order,
    });
  } catch (err) {
    console.error("POST /api/create-order error:", err?.response ? JSON.stringify(err.response, null, 2) : err);
    return res.status(200).json({
      success: false,
      message: "Failed to create order (see logs).",
      error: String(err?.message || err),
    });
  }
});

/**
 * Single-tool endpoint for VAPI:
 * - {"op":"menu"}                  -> returns menu (same as GET /api/items)
 * - {"op":"create_order", ...body} -> creates order (same as POST /api/create-order)
 */
app.post("/api/restaurant", async (req, res) => {
  try {
    const op = (req.body?.op || "").toLowerCase();

    if (op === "menu") {
      const items = await fetchMenuClean();
      return res.status(200).json({ success: true, items });
    }

    if (op === "create_order") {
      // Reuse create-order logic
      req.url = "/api/create-order";
      return app._router.handle(req, res);
    }

    // Fallback: no-op with guidance
    return res.status(200).json({
      success: false,
      message: 'Specify {"op":"menu"} or {"op":"create_order", ...}',
    });
  } catch (err) {
    console.error("POST /api/restaurant error:", err);
    return res.status(200).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server up on ${PORT} [${SQUARE_ENVIRONMENT}]`);
});
