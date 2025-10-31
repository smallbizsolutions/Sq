import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Health check route (optional)
app.get("/", (req, res) => {
  res.send("Square Order API running!");
});

// Create order route
app.post("/order", async (req, res) => {
  try {
    const response = await fetch("https://connect.squareupsandbox.com/v2/orders", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2025-10-16"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
