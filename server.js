// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { Client, Environment } from "square";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---- Square client ----
const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? Environment.Production
    : Environment.Sandbox,
});

// Normalize catalog -> simple menu
async function fetchMenuSimple() {
  const { objectsApi } = square;
  const out = [];
  // Pull items
  const itemsResp = await objectsApi.searchCatalogObjects({
    objectTypes: ["ITEM"],
    query: { prefixQuery: { attributeName: "name", prefix: "" } }
  });

  const items = itemsResp.result.objects || [];
  for (const it of items) {
    const name = it.itemData?.name?.trim();
    const variations = it.itemData?.variations || [];
    if (!name || variations.length === 0) continue;

    // take first variation’s price if present
    const v0 = variations[0];
    const priceMoney = v0.itemVariationData?.priceMoney?.amount;
    const price = (typeof priceMoney === "number") ? (priceMoney / 100).toFixed(2) : undefined;

    out.push({ name, price });
  }

  // fallback if nothing
  if (out.length === 0) {
    return [
      { name: "Burger", price: "4.99" },
      { name: "Fries",  price: "1.99" },
      { name: "Soda",   price: "0.99" },
    ];
  }
  return out;
}

// ---- Unified endpoint ----
app.post("/api/create-order", async (req, res) => {
  try {
    const action = (req.body?.action || "create").toLowerCase();

    // 1) MENU
    if (action === "menu") {
      const menu = await fetchMenuSimple();
      return res.json({ success: true, menu });
    }

    // 2) CREATE ORDER
    const itemsJson = req.body?.items_json;
    if (!itemsJson || itemsJson.trim().length === 0) {
      return res.json({ success: false, error: "No line items provided" });
    }

    const notes = req.body?.notes || "";
    const customer_name = req.body?.customer_name || "";
    const customer_phone = req.body?.customer_phone || "";
    const customer_email = req.body?.customer_email || "";

    let parsed;
    try {
      parsed = JSON.parse(itemsJson);
    } catch {
      return res.json({ success: false, error: "items_json must be a JSON string" });
    }

    // Build order request (very simple: one line item per entry)
    const lineItems = [];
    for (const { name, quantity } of parsed) {
      if (!name) continue;
      const qty = String(quantity ?? 1);
      lineItems.push({ name, quantity: qty });
    }
    if (lineItems.length === 0) {
      return res.json({ success: false, error: "No valid items" });
    }

    // If you want a real Square order, map names->catalogObjectIds here.
    // For demo, we just echo back a fake orderId.
    const orderId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

    return res.json({
      success: true,
      orderId,
      message: "Order placed",
      echo: { notes, customer_name, customer_phone, customer_email, lineItems }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// Health
app.get("/", (_, res) => res.send("ok"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("server on :" + port));
