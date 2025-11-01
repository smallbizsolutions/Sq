const express = require("express");
const cors = require("cors");
const { Client } = require("square"); // ✅ new SDK import (no Environment)

// --- Square Client ---
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT, // "sandbox" or "production"
});

const catalogApi = client.catalogApi;
const ordersApi = client.ordersApi;

const app = express();
app.use(cors());
app.use(express.json());

// --- HEALTH CHECKS ---
app.get("/", (_req, res) => res.send("✅ API is running"));
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() })
);

// --- GET MENU ITEMS ---
app.get("/api/items", async (req, res) => {
  try {
    const result = await catalogApi.listCatalog(undefined, "ITEM");
    const objects = result?.result?.objects || [];
    const items = objects.map((obj) => ({
      id: obj.id,
      name: obj.itemData?.name,
      price: obj.itemData?.variations?.[0]?.itemVariationData?.priceMoney?.amount || 0,
      currency: obj.itemData?.variations?.[0]?.itemVariationData?.priceMoney?.currency || "USD",
    }));

    return res.json({ success: true, items });
  } catch (err) {
    console.error("🔥 Error fetching items:", err);
    return res.status(200).json({ success: false, error: String(err) });
  }
});

// --- CREATE ORDER (VAPI TOOL ENDPOINT) ---
app.post("/api/create-order", async (req, res) => {
  try {
    console.log("📝 Received VAPI order payload:", req.body);

    const { items_json, customer_name, customer_phone } = req.body;
    let items = [];

    try {
      items = Array.isArray(items_json)
        ? items_json
        : JSON.parse(items_json || "[]");
    } catch (_e) {
      items = [];
    }

    if (items.length === 0) {
      return res.status(200).json({
        success: false,
        message: "No items provided.",
      });
    }

    const lineItems = items.map((i) => ({
      quantity: i.quantity?.toString() || "1",
      catalogObjectId: i.id,
    }));

    const orderReq = {
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems,
      },
    };

    const orderResult = await ordersApi.createOrder(orderReq);

    return res.json({
      success: true,
      square_response: orderResult.result,
    });
  } catch (err) {
    console.error("🔥 Order creation error:", err);
    return res.status(200).json({
      success: false,
      error: String(err),
    });
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
