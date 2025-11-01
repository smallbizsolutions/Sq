import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Client, Environment } from "square";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

// Square client config
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === "sandbox"
    ? Environment.Sandbox
    : Environment.Production
});

const catalogApi = client.catalogApi;
const ordersApi = client.ordersApi;
const locationId = process.env.SQUARE_LOCATION_ID;

// ✅ TEST ROUTE
app.get("/", (req, res) => {
  res.send("✅ Square backend is running!");
});

// ✅ GET ITEMS (Menu)
app.get("/api/items", async (req, res) => {
  try {
    const response = await catalogApi.listCatalog(undefined, "ITEM");

    if (!response.result.objects) {
      return res.json({
        items: [],
        note: "Square API returned no items. Sandbox catalog is empty from the API side."
      });
    }

    const items = response.result.objects.map(obj => ({
      id: obj.id,
      name: obj.itemData?.name,
      price: obj.itemData?.variations?.[0]?.itemVariationData?.priceMoney?.amount ?? 0
    }));

    res.json({ items });
  } catch (err) {
    console.error("❌ Square API Error (items):", err);
    res.status(500).json({ error: true, message: "Failed to fetch items" });
  }
});

// ✅ CREATE ORDER
app.post("/api/order", async (req, res) => {
  try {
    const { lineItems } = req.body;

    const orderRequest = {
      order: {
        locationId,
        lineItems
      }
    };

    const response = await ordersApi.createOrder({ order: orderRequest });
    res.json({ success: true, order: response.result.order });

  } catch (err) {
    console.error("❌ Square API Error (order):", err);
    res.status(500).json({ error: true, message: "Failed to create order" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
