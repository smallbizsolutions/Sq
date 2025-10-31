import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// this route receives order data from Vapi and forwards it to Square
app.post("/order", async (req, res) => {
  try {
    const squareResponse = await fetch("https://connect.squareupsandbox.com/v2/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Square-Version": "2025-10-16",
        "Authorization": `Bearer ${process.env.SQUARE_TOKEN}`
      },
      body: JSON.stringify(req.body)
    });

    const data = await squareResponse.json();
    res.status(squareResponse.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error forwarding to Square" });
  }
});

app.get("/", (_, res) => res.send("Square proxy running"));
app.listen(3000, () => console.log("Server running on port 3000"));
