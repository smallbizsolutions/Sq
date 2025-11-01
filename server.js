import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Client, Environment } from "square";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === "production"
    ? Environment.Production
    : Environment.Sandbox,
});

const catalogApi = client.catalogApi;

// ✅ GET menu items
app.get("/api/items", async (req, res) => {
  try {
    const response = await catalogApi.listCatalog(undefined, "ITEM");
    const items = response.result.objects || [];
    res.json({ items });
  } catch (err) {
    console.error("❌ Square API Error:", err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

// ✅ Root check
app.get("/", (req, res) => {
  res.send("✅ Square backend running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
