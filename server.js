const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Square SDK
const { Client, Environment } = require("square");

// Load env vars
const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_LOCATION_ID,
  SQUARE_ENVIRONMENT,
} = process.env;

// Init Square client
const squareClient = new Client({
  accessToken: SQUARE_ACCESS_TOKEN,
  environment:
    SQUARE_ENVIRONMENT === "production"
      ? Environment.Production
      : Environment.Sandbox,
});

const catalogApi = squareClient.catalogApi;
const ordersApi = squareClient.ordersApi;

const app = express();
app.use(cors());
app.use(express.json());

// Root/health
app.get("/", (_req, res) => res.send("✅ API is running"));
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() })
);

/**
 * ====== GET MENU (Square Catalog) ======
 * VAPI agent will call this tool to know what items exist
 */
app.get("/api/menu", async (_req, res) => {
  try {
    const response = await catalogApi.listCatalog(undefined, "ITEM");
    const items =
      response.result.objects?.map((o) => ({
        id: o.id,
        name: o.itemData?.name,
        price:
          o.itemData?.variations?.[0]?.itemVariationData?.priceMoney?.amount /
          100,
      })) || [];

    return res.status(200).json({ success: true, items });
  } catch (err) {
    console.error("🔥 Error fetching menu:", err);
    return res.status(200).json({
      success: false,
      message: "Failed to fetch menu",
      debug: String(err),
    });
  }
});

/**
 * ====== CREATE ORDER ======
 * Called by VAPI tool "createOrder"
 */
app.post("/api/create-order", async (req, res) => {
  try {
    const { items_json, customer_name, customer_phone, notes } =
      req.body || {};

    let items = [];
    try {
      items = Array.isArray(items_json)
        ? items_json
        : JSON.parse(items_json || "[]");
    } catch (e) {
      items = [];
    }

    // Prevent Square rejection: must have items
    if (!items.length) {
      items = [{ name: "Unknown item", quantity: 1, price: 0 }];
    }

    console.log("🧾 Order received from VAPI:", items);

    // Build Square line items
    const lineItems = items.map((i) => ({
      name: i.name,
      quantity: String(i.quantity || 1),
      basePriceMoney: {
        amount: Math.round((i.price || 0) * 100),
        currency: "USD",
      },
    }));

    const orderReq = {
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems,
        note: notes || "",
      },
    };

    const result = await ordersApi.createOrder({ order: orderReq.order });

    return res.status(200).json({
      success: true,
      message: "✅ Square order created",
      squareResponse: result.result,
    });
  } catch (err) {
    console.error("🔥 ORDER ERROR:", err);
    return res.status(200).json({
      success: false,
      message: "Order received but Square call failed",
      debug: String(err),
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
