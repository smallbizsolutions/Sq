const express = require("express");
const cors = require("cors");
const { SquareClient } = require("square");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Square client setup
const client = new SquareClient({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT || "sandbox",
});

const catalogApi = client.catalogApi;
const ordersApi = client.ordersApi;

// Health checks
app.get("/", (_req, res) => res.send("✅ API is running"));
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() })
);

// =========================
// 1) GET MENU ITEMS
// =========================
app.get("/api/items", async (_req, res) => {
  try {
    const response = await catalogApi.listCatalog(undefined, "ITEM");
    const items = (response.result.objects || []).map((obj) => ({
      id: obj.id,
      name: obj.itemData?.name,
      price:
        obj.itemData?.variations?.[0]?.itemVariationData?.priceMoney?.amount /
          100 || 0,
    }));

    return res.status(200).json({ success: true, items });
  } catch (err) {
    console.error("🔥 Error fetching items:", err);
    return res.status(200).json({
      success: false,
      items: [],
      error: String(err?.message || err),
    });
  }
});

// =========================
// 2) CREATE ORDER
// =========================
app.post("/api/create-order", async (req, res) => {
  try {
    const { items_json, customer_name, notes } = req.body || {};
    let items = [];

    try {
      items = Array.isArray(items_json)
        ? items_json
        : JSON.parse(items_json || "[]");
    } catch {
      items = [];
    }

    if (!items.length) {
      return res.status(200).json({
        success: false,
        message: "No valid items passed",
      });
    }

    const lineItems = items.map((i) => ({
      quantity: String(i.quantity || 1),
      catalogObjectId: i.id,
    }));

    const orderBody = {
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems,
        note: notes || undefined,
      },
    };

    const orderResponse = await ordersApi.createOrder({ order: orderBody.order });

    return res.status(200).json({
      success: true,
      message: "✅ Order created!",
      squareOrderId: orderResponse.result.order?.id,
      debug: orderResponse.result,
    });
  } catch (err) {
    console.error("🔥 Error creating order:", err);
    return res.status(200).json({
      success: false,
      message: "Order failed, check logs",
      error: String(err?.message || err),
    });
  }
});

// Railway / Local server start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
