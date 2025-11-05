import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { Client, Environment, WebhooksHelper } from "square";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// ----- CORS -----
const origins =
  (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: origins.length ? origins : "*",
    credentials: false
  })
);

// ----- Square client -----
const env =
  (process.env.SQUARE_ENV || "production").toLowerCase() === "sandbox"
    ? Environment.Sandbox
    : Environment.Production;

if (!process.env.SQUARE_ACCESS_TOKEN) {
  console.error("Missing SQUARE_ACCESS_TOKEN");
}

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: env
});

const { catalogApi, ordersApi, terminalsApi, inventoryApi } = client;

// ----- health -----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ----- GET /menu  ------------------------------------------------------------
// Pull live catalog (items, variations, modifier lists) + overlay inventory.
// Keep it simple: no DB, just live fetch. Add caching later if you want.
app.get("/menu", async (_req, res) => {
  try {
    const types = [
      "ITEM",
      "ITEM_VARIATION",
      "MODIFIER_LIST",
      "MODIFIER",
      "CATEGORY",
      "TAX",
      "IMAGE",
      "ITEM_OPTION"
    ];

    const { result } = await catalogApi.searchCatalogObjects({
      objectTypes: types,
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
            priceMoney: v.itemVariationData?.priceMoney ?? null,
            sku: v.itemVariationData?.sku ?? null
          }));

        const modifierListIds =
          data?.modifierListInfo?.map(m => m.modifierListId) ?? [];

        const modifierLists = modifierListIds
          .map(id => byId.get(id))
          .filter(Boolean)
          .map(list => ({
            id: list.id,
            name: list.modifierListData?.name ?? "",
            min:
              list.modifierListData?.minSelectedModifiers != null
                ? list.modifierListData.minSelectedModifiers
                : 0,
            max:
              list.modifierListData?.maxSelectedModifiers != null
                ? list.modifierListData.maxSelectedModifiers
                : 0,
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
          data?.categories?.map(c => byId.get(c.id)?.categoryData?.name) ?? [];

        return {
          id: item.id,
          name: data?.name ?? "",
          description: data?.description ?? "",
          imageIds: data?.imageIds ?? [],
          categories: categories.filter(Boolean),
          variations,
          modifierLists
        };
      });

    // Inventory overlay (sold out)
    const variationIds = items.flatMap(i => i.variations.map(v => v.id));
    let counts = [];
    if (variationIds.length) {
      const inv = await inventoryApi.batchRetrieveInventoryCounts({
        locationIds: [process.env.SQUARE_LOCATION_ID],
        catalogObjectIds: variationIds
      });
      counts = inv.result?.counts ?? [];
    }
    const inStock = new Map(
      counts.map(c => [c.catalogObjectId, Number(c.quantity ?? 0)])
    );
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

// ----- POST /checkout  -------------------------------------------------------
// Body: { lineItems:[{ catalogObjectId, quantity, modifiers?:[{catalogObjectId,quantity?}] }], note?, customerName?, phone? }
app.post("/checkout", async (req, res) => {
  try {
    const { lineItems, note, customerName, phone } = req.body ?? {};
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ error: "no_line_items" });
    }

    // 1) Create Order
    const orderResp = await ordersApi.createOrder({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        referenceId: "kiosk",
        lineItems: lineItems.map(li => ({
          catalogObjectId: li.catalogObjectId, // variation id
          quantity: String(li.quantity ?? "1"),
          modifiers:
            (li.modifiers ?? []).map(m => ({
              catalogObjectId: m.catalogObjectId,
              quantity: m.quantity ? String(m.quantity) : "1"
            })) ?? []
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

    // Total (Square prices from catalog; use totalMoney if present, fallback to netAmounts.totalMoney)
    const totalMoney =
      order.totalMoney ??
      order.netAmounts?.totalMoney;
    if (!totalMoney?.amount) {
      return res.status(500).json({ error: "order_total_missing" });
    }

    // 2) Terminal Checkout (card-present on paired device)
    const checkoutResp = await terminalsApi.createTerminalCheckout({
      idempotencyKey: crypto.randomUUID(),
      checkout: {
        orderId: order.id,
        amountMoney: {
          amount: Number(totalMoney.amount),
          currency: totalMoney.currency || "USD"
        },
        deviceOptions: {
          deviceId: process.env.TERMINAL_DEVICE_ID
        }
        // Tips/signature/receipt options available here if you want.
      }
    });

    res.json({
      checkoutId: checkoutResp.result.checkout?.id,
      status: "PENDING_ON_TERMINAL"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "checkout_start_failed" });
  }
});

// ----- Webhooks (optional but useful) ---------------------------------------
// Subscribe in Square Dashboard to:
// - terminal.checkout.updated  (to flip UI after payment)
// - catalog.version.updated    (to invalidate menu cache if you add caching)
app.post("/webhooks/square", (req, res) => {
  try {
    const sig = req.headers["x-square-hmacsha256-signature"];
    const valid = WebhooksHelper.verifySignature({
      signatureKey: process.env.WEBHOOK_SIGNATURE_KEY || "",
      signatureHeader: Array.isArray(sig) ? sig[0] : sig,
      requestBody: JSON.stringify(req.body),
      notificationUrl: "https://YOUR-BACKEND-DOMAIN/webhooks/square"
    });
    if (!valid) return res.status(401).end();

    // Handle events as needed
    res.sendStatus(200);
  } catch {
    res.sendStatus(200);
  }
});

const port = Number(process.env.PORT || 5175);
app.listen(port, () => console.log(`Server running on :${port}`));
