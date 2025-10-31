import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Simple root route so Railway can confirm it's live
app.get("/", (req, res) => {
  res.send("✅ Square Order Proxy is live!");
});

// POST route to create an order via Square
app.post("/order", async (req, res) => {
  try {
    const response = await fetch("https://connect.squareup.com/v2/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Square API Error:", data);
      return res.status(response.status).json({
        error: true,
        message: data.errors || data,
      });
    }

    console.log("✅ Square Order Created:", data);
    res.status(200).json(data);

  } catch (error) {
    console.error("❌ Proxy Error:", error);
    res.status(500).json({ error: true, message: error.message });
  }
});

// Bind on 0.0.0.0 so Railway’s reverse proxy can connect
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
