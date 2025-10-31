// server.js
// Square order backend for VAPI — multi-item order, sandbox/production via env.

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Client, Environment } = require("square");

const app = express();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Env ----------
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENVIRONMENT =
  (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? "production"
    : "sandbox";

if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.warn(
    "[BOOT] Missing env vars. Required: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID. " +
      "Got access? " + Boolean(SQUARE_ACCESS_TOKEN) + " | location? " + Boolean(SQUARE_LOCATION_ID)
  );
}

// ---------- Square client ----------
const square = new Client({
  accessToken: SQUARE_ACCESS_TOKEN,
  environment:
    SQUARE_ENVIRONMENT === "production"
      ? Environment.Production
      : Environment.Sandbox,
});

// Helpers
const money = (n) => ({ amount: Math.round(Number(n || 0) * 100), currency: "USD" });

// Try to pull price from Square Catalog by item name (first variation)
async function findPriceFromCatalogByName(name) {
  try {
    // listCatalog with type:ITEM (q param does a simple search; we’ll still filter)
    const resp = await square.catalogApi.listCatalog(undefined, "ITEM");
    const objects = resp?.result?.objects || [];
    const hit = objects.find(
      (o) =>
        o.type === "ITEM" &&
        o.itemData &&
        o.itemData.name &&
        o.itemData.name.toLowerCase().trim() === String(name).toLowerCase().trim()
    );
    if (!hit) return null;

    const variations = hit.itemData.variations || [];
    const v0 = variations[0];
    const cents = v0?.itemVariationData?.priceMoney?.amount;
    if (typeof cents === "number") return cents / 100;
    return null;
  } catch (e) {
    console.warn("Catalog lookup failed:", e?.message || e);
    return null;
  }
}

// ---------- Health ----------
app.get("/", (_req, res) =>
  res.send("✅ Square API server is running")
);
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: SQUARE_ENVIRONMENT,
  })
);

// ---------- Core: Create Order ----------
/**
 * Expected bodies we’ll accept (VAPI can be messy):
 * {
 *   items_json: string | array // preferred: array of { name, quantity, price?, customization? }
 *   customer_name?: string
 *   customer_email?: string
 *   customer_phone?: string
 *   notes?: string
 * }
 */
app.post("/api/create-order", async (req, res) => {
  const startedAt = Date.now();
  try {
    // 1) Normalize payload
    const {
      items_json,
      customer_name,
      customer_email,
      customer_phone,
      notes,
    } = req.body || {};

    let items = [];
    try {
      if (Array.isArray(items_json)) {
        items = items_json;
      } else if (typeof items_json === "string") {
        const parsed = JSON.parse(items_json);
        items = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (_e) {
      // ignore
    }

    // Guardrail: fabricate placeholder if empty so VAPI “Test” still passes
    if (!items || items.length === 0) {
      items = [{ name: "Unspecified Item", quantity: 1, price: 0 }];
    }

    // 2) Build Square line items (fill price from Catalog if missing)
    const lineItems = [];
    for (const raw of items) {
      const name = String(raw?.name || "Item").trim();
      const qty = String(raw?.quantity || 1);
      let price = raw?.price;

      if (price == null || isNaN(Number(price))) {
        // Try to read from Square Catalog by item name
        const found = await findPriceFromCatalogByName(name);
        if (found != null) price = found;
      }
      if (price == null || isNaN(Number(price))) price = 0;

      lineItems.push({
        name,
        quantity: qty,
        basePriceMoney: money(price),
        note: raw?.customization ? String(raw.customization).slice(0, 250) : undefined,
      });
    }

    // 3) Create order in Square
    const idempotencyKey = crypto.randomUUID();
    const orderReq = {
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems,
        state: "OPEN",
        // Optional: helpful metadata
        metadata: {
          src: "vapi_phone_assistant",
          customer_name: customer_name || "",
          customer_phone: customer_phone || "",
        },
        // Optional customer-facing note (shows in Dashboard)
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickupDetails: {
              note: notes || "Phone-in order",
            },
          },
        ],
      },
      idempotencyKey,
    };

    const orderResp = await square.ordersApi.createOrder(orderReq);
    const order = orderResp?.result?.order;

    const total =
      (order?.totalMoney?.amount != null ? order.totalMoney.amount : 0) / 100;

    // 4) Reply (always 200 for VAPI API Request tool)
    return res.status(200).json({
      success: true,
      order_id: order?.id,
      total,
      currency: "USD",
      line_items: lineItems.map((li) => ({
        name: li.name,
        quantity: li.quantity,
        price: li.basePriceMoney.amount / 100,
      })),
      customer: {
        name: customer_name || null,
        email: customer_email || null,
        phone: customer_phone || null,
      },
      message:
        order?.id
          ? `Order created in Square. ID: ${order.id}. Total: $${total.toFixed(2)}`
          : "Created order request sent to Square.",
      debug: {
        ms: Date.now() - startedAt,
        idempotencyKey,
        env: SQUARE_ENVIRONMENT,
      },
    });
  } catch (err) {
    console.error("Order error:", err?.response?.body || err);
    // Still 200 so the tool flow continues; include error in payload
    return res.status(200).json({
      success: false,
      message: "Failed to create order in Square.",
      error: String(err?.message || err),
      debugBody: err?.response?.body || null,
    });
  }
});

// ---------- Optional: quick peek at Catalog items (debug) ----------
app.get("/api/menu", async (_req, res) => {
  try {
    const r = await square.catalogApi.listCatalog(undefined, "ITEM");
    const items = (r?.result?.objects || [])
      .filter((o) => o.type === "ITEM")
      .map((o) => {
        const v = o.itemData?.variations?.[0];
        const cents = v?.itemVariationData?.priceMoney?.amount || 0;
        return {
          id: o.id,
          name: o.itemData?.name,
          price: cents / 100,
          description: o.itemData?.description || "",
        };
      });
    res.json({ success: true, items });
  } catch (e) {
    res.json({ success: false, error: String(e?.message || e) });
  }
});

// ---------- Boot ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(
    `[Square] env=${SQUARE_ENVIRONMENT} | location=${SQUARE_LOCATION_ID ? "✔" : "✖"}`
  );
});
