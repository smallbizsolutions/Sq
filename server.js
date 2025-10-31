const express = require("express");
const cors = require("cors");
const { Client } = require("square");

// ─────────────────────────────────────────────
//  SQUARE CLIENT
// ─────────────────────────────────────────────
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT || "sandbox",
});

const catalogApi = squareClient.catalogApi;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/", (_req, res) => res.send("✅ API is running"));
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() })
);

// ─────────────────────────────────────────────
//  GET MENU ITEMS FROM SQUARE
// ─────────────────────────────────────────────
app.get("/items", async (_req, res) => {
  try {
    const response = await catalogApi.listCatalog(undefined, "ITEM");

    const objects = response?.result?.objects || [];

    // Convert Square item format into something useful
    const items = objects
      .filter((obj) => obj.type === "ITEM")
      .map((item) => {
        const variation = item.itemData?.variations?.[0];
        const priceMoney = variation?.itemVariationData?.priceMoney;

        return {
          id: item.id,
          name: item.itemData?.name || "Unnamed Item",
          price: priceMoney ? priceMoney.amount / 100 : 0,
        };
      });

    return res.json({ success: true, items });
  } catch (err) {
    console.error("🔥 Square menu fetch error:", err);
    return res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

// ─────────────────────────────────────────────
//  CREATE ORDER (placeholder - will wire to Square next)
// ─────────────────────────────────────────────
app.post("/api/create-order", async (req, res) => {
  try {
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
    } catch (_e) {}

    if (!items || items.length === 0) {
      items = [{ name: "Unspecified Item", quantity: 1, price: 0 }];
    }

    console.log("📝 Received body:", JSON.stringify(req.body));
    console.log("🧾 Items parsed:", items);

    return res.status(200).json({
      success: true,
      message: "Order data received (not yet submitted to Square).",
      received: {
        items,
        customer_name,
        customer_email,
        customer_phone,
        notes,
      },
    });
  } catch (err) {
    console.error("🔥 create-order error:", err);
    return res.status(200).json({
      success: true,
      message: "Order received, but error occurred. Check logs.",
      error: String(err?.message || err),
    });
  }
});

// ─────────────────────────────────────────────
//  SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
