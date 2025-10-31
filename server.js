const express = require("express");
const cors = require("cors");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root route
app.get("/", (req, res) => {
  res.send("✅ Square API server is running");
});

// Create order route (Vapi-compatible)
app.post("/api/create-order", async (req, res) => {
  try {
    const {
      items_json,
      customer_name,
      customer_email,
      customer_phone,
      notes,
    } = req.body;

    // Handle both stringified and real arrays
    let items;
    try {
      items =
        typeof items_json === "string"
          ? JSON.parse(items_json)
          : Array.isArray(items_json)
          ? items_json
          : [];
    } catch (err) {
      console.error("❌ Failed to parse items_json:", err.message);
      return res
        .status(400)
        .json({ error: "Invalid items_json format", details: err.message });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // Log what we received
    console.log("💥 Order received:", {
      items,
      customer_name,
      customer_email,
      customer_phone,
      notes,
    });

    // Placeholder for Square API
    res.status(200).json({
      success: true,
      message: "Order created successfully!",
      received: {
        items,
        customer_name,
        customer_email,
        customer_phone,
        notes,
      },
    });
  } catch (error) {
    console.error("🔥 Server error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Listen on Railway port or local 8080
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
