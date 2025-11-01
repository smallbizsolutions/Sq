import express from "express";
import cors from "cors";
import { Client, Environment } from "square";

const app = express();
app.use(cors());
app.use(express.json());

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.SQUARE_ENVIRONMENT === "production"
      ? Environment.Production
      : Environment.Sandbox,
});

const catalogApi = client.catalogApi;
const ordersApi = client.ordersApi;
const paymentsApi = client.paymentsApi;

// ✅ GET menu items
app.get("/api/items", async (req, res) => {
  try {
    const response = await catalogApi.listCatalog(undefined, "ITEM");
    const items =
      response.result.objects?.map((item) => ({
        id: item.id,
        name: item.itemData?.name,
        price:
          item.itemData?.variations?.[0]?.itemVariationData?.priceMoney?.amount /
          100,
      })) || [];

    res.json(items);
  } catch (error) {
    console.error("Error fetching items:", error);
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
