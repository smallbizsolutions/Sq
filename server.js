// server.js
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { Client } from "square";

const app = express();
app.use(bodyParser.json());

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: "production", // or "sandbox"
});

const { catalogApi, ordersApi, terminalsApi, inventoryApi } = client;

// ---- GET /menu  -------------------------------------------------------------
app.get("/menu", async (req, res) => {
  try {
    // 1) Pull catalog objects needed for a food menu
    const types = [
      "ITEM","ITEM_VARIATION","MODIFIER_LIST","MODIFIER","CATEGORY","TAX","IMAGE","ITEM_OPTION"
    ];
    const now = new Date().toISOString();
    const search = await catalogApi.searchCatalogObjects({
      objectTypes: types,
      includeRelatedObjects: true,
      includeDeletedObjects: false,
      // Optional: use beginTime if you persist lastSync to do delta loads
      // beginTime: lastSync
    });

    const objects = [
      ...(search.result?.objects ?? []),
      ...(search.result?.relatedObjects ?? [])
    ];

    // 2) Build a simple normalized menu (items with variations, modifiers, categories)
    const byId = new Map(objects.map(o => [o.id, o]));
    const items = objects.filter(o => o.type === "ITEM" && !o.isDeleted).map(item => {
      const data = item.itemData;
      const variations = (data?.variations ?? [])
        .map(v => byId.get(v.id) || v)
        .filter(v => !v.isDeleted)
        .map(v => ({
          id: v.id,
          name: v.itemVariationData?.name,
          priceMoney: v.itemVariationData?.priceMoney,
          sku: v.itemVariationData?.sku
        }));
      const modifierListIds = data?.modifierListInfo?.map(m => m.modifierListId) ?? [];
      const modifierLists = modifierListIds
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(list => ({
          id: list.id,
          name: list.modifierListData?.name,
          modifiers: (list.modifierListData?.modifiers ?? [])
            .map(m => byId.get(m.id) || m)
            .filter(m => !m.isDeleted)
            .map(m => ({
              id: m.id,
              name: m.modifierData?.name,
              priceMoney: m.modifierData?.priceMoney
            }))
        }));

      const categories = (data?.categories ?? []).map(c => byId.get(c.id)?.categoryData?.name).filter(Boolean);

      return {
        id: item.id,
        name: data?.name,
        description: data?.description,
        imageIds: data?.imageIds ?? [],
        categories,
        variations,
        modifierLists
      };
    });

    // 3) Overlay inventory availability for each variation
    const variationIds = items.flatMap(i => i.variations.map(v => v.id));
    const inv = variationIds.length
      ? await inventoryApi.batchRetrieveInventoryCounts({
          catalogObjectIds: variationIds,
          locationIds: [process.env.SQUARE_LOCATION_ID]
        })
      : { result: { counts: [] } };

    const inStock = new Map(
      (inv.result?.counts ?? []).map(c => [c.catalogObjectId, Number(c.quantity ?? 0)])
    );

    for (const i of items) {
      for (const v of i.variations) {
        if (inStock.has(v.id)) v.soldOut = inStock.get(v.id) <= 0;
      }
    }

    res.json({ updatedAt: now, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "menu_fetch_failed" });
  }
});

// ---- POST /checkout  --------------------------------------------------------
app.post("/checkout", async (req, res) => {
  try {
    const { lineItems, customerName, phone } = req.body;

    // 1) CreateOrder (OPEN) with a PICKUP fulfillment
    const orderResp = await ordersApi.createOrder({
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems, // [{ catalogObjectId: variationId, quantity:"1", modifiers:[{catalogObjectId: modId}] }]
        fulfillments: [{
          type: "PICKUP",
          state: "PROPOSED",
          pickupDetails: { recipient: { displayName: customerName, phoneNumber: phone } }
        }]
      },
      idempotencyKey: crypto.randomUUID()
    });

    const orderId = orderResp.result.order.id;

    // 2) Kick off a Terminal checkout tied to that order
    const terminalResp = await terminalsApi.createTerminalCheckout({
      idempotencyKey: crypto.randomUUID(),
      checkout: {
        deviceOptions: { deviceId: process.env.TERMINAL_DEVICE_ID },
        orderId,                 // <-- ties itemization to the Terminal
        amountMoney: orderResp.result.order.totalMoney, // ensure totals match
        // optional: skip receipt/signature, enable tips, etc.
      }
    });

    res.json({ checkoutId: terminalResp.result.checkout.id, status: "pending" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "checkout_start_failed" });
  }
});

// ---- Webhook (Terminal + Catalog)  -----------------------------------------
app.post("/webhooks/square", async (req, res) => {
  // Verify signature in production (omitted here)
  const event = req.body;

  if (event.type === "terminal.checkout.updated") {
    const status = event.data?.object?.terminalCheckout?.status;
    const orderId = event.data?.object?.terminalCheckout?.orderId;
    if (status === "COMPLETED") {
      // You can mark fulfillment READY/IN_PROGRESS here if you want
      // or let KDS staff manage states in the kitchen app.
    }
  }

  if (event.type === "catalog.version.updated") {
    // Trigger a delta re-sync from lastSync timestamp in your DB
  }

  res.sendStatus(200);
});

app.listen(3000);
