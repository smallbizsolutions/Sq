import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { Client, Environment } from "square";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../client/dist");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// ---- Square client ----
const env =
  (process.env.SQUARE_ENV || "production").toLowerCase() === "sandbox"
    ? Environment.Sandbox
    : Environment.Production;

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: env
});

const { catalogApi, ordersApi, terminalsApi, inventoryApi } = client;

// ---- Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- GET /menu (live catalog + inventory)
app.get("/menu", async (_req, res) => {
  try {
    const { result } = await catalogApi.searchCatalogObjects({
      objectTypes: [
        "ITEM","ITEM_VARIATION","MODIFIER_LIST","MODIFIER",
        "CATEGORY","TAX","IMAGE","ITEM_OPTION"
      ],
      includeRelatedObjects: true,
      includeDeletedObjects: false
    });

    const objects = [
      ...(result.objects ?? []),
      ...(result.relatedObjects ?? [])
    ];
    const byId = new Map(objects.map(o => [o.id, o]));

    const items = objects
      .filter(o => o.type === "ITEM" && !o.isDeleted)
      .map(item => {
        const data = item.itemData;

        const variations = (data?.variations ?? [])
          .map(v => byId.get(v.id) || v)
          .filter(v => !v.isDeleted)
          .map(v => ({
            id: v.id,
            name: v.itemVariationData?.name ?? "",
            priceMoney: v.itemVariationData?.priceMoney ?? null
          }));

        const modifierLists = (data?.modifierListInfo ?? [])
          .map(info => byId.get(info.modifierListId))
          .filter(Boolean)
          .map(list => ({
            id: list.id,
            name: list.modifierListData?.name ?? "",
            modifiers: (list.modifierListData?.modifiers ?? [])
              .map(m => byId.get(m.id) || m)
              .filter(m => !m.isDeleted)
              .map(m => ({
                id: m.id,
                name: m.modifierData?.name ?? "",
                priceMoney: m.modifierData?.priceMoney ?? null
              }))
          }));

        const categories =
          data?.categories?.map(c => byId.get(c.id)?.categoryData?.name).filter(Boolean) ?? [];

        return {
          id: item.id,
          name: data?.name ?? "",
          description: data?.description ?? "",
          imageIds: data?.imageIds ?? [],
          categories,
          variations,
          modifierLists
        };
      });

    // Inventory overlay
    const variationIds = items.flatMap(i => i.variations.map(v => v.id));
    let counts = [];
    if (variationIds.length) {
      const inv = await inventoryApi.batchRetrieveInventoryCounts({
        locationIds: [process.env.SQUARE_LOCATION_ID],
        catalogObjectIds: variationIds
      });
      counts = inv.result?.counts ?? [];
    }
    const inStock = new Map(counts.map(c => [c.catalogObjectId, Number(c.quantity ?? 0)]));
    for (const it of items) {
      for (const v of it.variations) {
        if (inStock.has(v.id)) v.soldOut = inStock.get(v.id) <= 0;
      }
    }

    res.json({ updatedAt: new Date().toISOString(), items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "menu_fetch_failed" });
  }
});

// ---- POST /checkout (Order -> Terminal Checkout)
app.post("/checkout", async (req, res) => {
  try {
    const { lineItems, note, customerName, phone } = req.body ?? {};
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ error: "no_line_items" });
    }

    const orderResp = await ordersApi.createOrder({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        referenceId: "kiosk",
        lineItems: lineItems.map(li => ({
          catalogObjectId: li.catalogObjectId,
          quantity: String(li.quantity ?? "1"),
          modifiers: (li.modifiers ?? []).map(m => ({
            catalogObjectId: m.catalogObjectId,
            quantity: m.quantity ? String(m.quantity) : "1"
          }))
        })),
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickupDetails: {
              recipient: {
                displayName: customerName || "Guest",
                phoneNumber: phone || undefined
              }
            }
          }
        ],
        note
      }
    });

    const order = orderResp.result.order;
    if (!order?.id) return res.status(500).json({ error: "order_create_failed" });

    const totalMoney = order.totalMoney ?? order.netAmounts?.totalMoney;
    if (!totalMoney?.amount) return res.status(500).json({ error: "order_total_missing" });

    const checkoutResp = await terminalsApi.createTerminalCheckout({
      idempotencyKey: crypto.randomUUID(),
      checkout: {
        orderId: order.id,
        amountMoney: {
          amount: Number(totalMoney.amount),
          currency: totalMoney.currency || "USD"
        },
        deviceOptions: { deviceId: process.env.TERMINAL_DEVICE_ID }
      }
    });

    res.json({ checkoutId: checkoutResp.result.checkout?.id, status: "PENDING_ON_TERMINAL" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "checkout_start_failed" });
  }
});

// ---- Serve built client
app.use(express.static(clientDist));
app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Server running on :${port}`));
