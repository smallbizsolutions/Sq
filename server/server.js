import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { SquareClient, SquareEnvironment, WebhooksHelper } from "square";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: true }));

// --- Square client ---
const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === "production"
      ? SquareEnvironment.Production
      : SquareEnvironment.Sandbox,
});

// convenience
const catalog = client.catalog;
const orders = client.orders;
const terminal = client.terminal; // SDK v40+ groups apis by domain; if your SDK exposes `terminalApi` instead, rename accordingly.

/**
 * GET /menu
 * Pulls items/variations/modifiers from Square so the kiosk always reflects the live menu.
 */
app.get("/menu", async (_req, res) => {
  try {
    const items = [];
    const mods = {};
    const variationsByItem = {};

    // Grab all ITEM and MODIFIER_LIST objects (paged)
    let cursor = undefined;
    do {
      const page = await catalog.list({ types: ["ITEM", "MODIFIER_LIST"], cursor });
      for (const obj of page.objects ?? []) {
        if (obj.type === "ITEM") {
          items.push(obj);
          // flatten variations for quick lookup
          for (const v of obj.itemData?.variations ?? []) {
            variationsByItem[v.id!] = {
              itemId: obj.id!,
              itemName: obj.itemData?.name ?? "",
              variationId: v.id!,
              variationName: v.itemVariationData?.name ?? "",
              priceMoney: v.itemVariationData?.priceMoney ?? null
            };
          }
        }
        if (obj.type === "MODIFIER_LIST") {
          mods[obj.id!] = obj;
        }
      }
      cursor = page.cursor;
    } while (cursor);

    // Build a compact menu the UI can render quickly
    const compact = items.map((it) => ({
      id: it.id!,
      name: it.itemData?.name ?? "",
      description: it.itemData?.description ?? "",
      categories: it.itemData?.categories?.map((c) => c.categoryId) ?? [],
      imageIds: it.itemData?.imageIds ?? [],
      variations:
        it.itemData?.variations?.map((v) => ({
          id: v.id!,
          name: v.itemVariationData?.name ?? "",
          priceMoney: v.itemVariationData?.priceMoney ?? null
        })) ?? [],
      modifierLists:
        it.itemData?.modifierListInfo?.map((info) => {
          const list = mods[info.modifierListId!];
          return {
            id: info.modifierListId!,
            name: list?.modifierListData?.name ?? "",
            min: info.minSelectedModifiers ?? list?.modifierListData?.minSelectedModifiers ?? 0,
            max:
              info.maxSelectedModifiers ??
              list?.modifierListData?.maxSelectedModifiers ??
              0,
            allowQuantities:
              list?.modifierListData?.selectionType === "LIST_WITH_UP_TO_ONE" ? false : true,
            modifiers:
              list?.modifierListData?.modifiers?.map((m) => ({
                id: m.id!,
                name: m.modifierData?.name ?? "",
                priceMoney: m.modifierData?.priceMoney ?? null
              })) ?? []
          };
        }) ?? []
    }));

    res.json({ items: compact });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "menu_fetch_failed" });
  }
});

/**
 * POST /checkout
 * Body: { lineItems: [{ catalogObjectId, quantity, modifiers?: [{ catalogObjectId, quantity? }] }], note?: string }
 * Creates Order -> Terminal Checkout on the paired device.
 */
app.post("/checkout", async (req, res) => {
  try {
    const { lineItems, note } = req.body ?? {};
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ error: "no_line_items" });
    }

    // 1) Create Order linked to catalog variation/modifier IDs
    const createOrder = await orders.create({
      idempotencyKey: uuidv4(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems: lineItems.map((li) => ({
          catalogObjectId: li.catalogObjectId, // variation id
          quantity: String(li.quantity ?? "1"),
          modifiers:
            li.modifiers?.map((m) => ({
              catalogObjectId: m.catalogObjectId,
              quantity: m.quantity ? String(m.quantity) : "1"
            })) ?? [],
        })),
        note
      }
    });

    const order = createOrder.order!;
    const total = order.netAmounts?.totalMoney?.amount ?? order.totalMoney?.amount;
    if (total == null) {
      return res.status(500).json({ error: "order_total_missing" });
    }

    // 2) Kick the Terminal checkout on the paired device
    const checkout = await terminal.createCheckout({
      idempotencyKey: uuidv4(),
      checkout: {
        amountMoney: {
          amount: BigInt(total), // must match order total
          currency: order.totalMoney?.currency ?? "USD"
        },
        deviceOptions: {
          deviceId: process.env.TERMINAL_DEVICE_ID
        },
        orderId: order.id,
        // Optional: configure tips/signature/receipt screens here
      }
    });

    res.json({ checkout: checkout.checkout });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "checkout_failed" });
  }
});

/**
 * Optional webhook for Terminal & Catalog updates
 */
app.post("/webhooks/square", (req, res) => {
  try {
    const signature = req.headers["x-square-hmacsha256-signature"];
    const isValid = WebhooksHelper.verifySignature({
      requestBody: JSON.stringify(req.body),
      signatureHeader: Array.isArray(signature) ? signature[0] : signature,
      signatureKey: process.env.WEBHOOK_SIGNATURE_KEY,
      notificationUrl: "https://your-domain.com/webhooks/square"
    });

    if (!isValid) return res.status(401).end();

    // Handle:
    // - terminal.checkout.updated (update UI/order state)
    // - catalog.version.updated (invalidate menu cache)
    // - inventory.count.updated (optional)
    // See Events reference for exact event types
    res.status(200).end();
  } catch (e) {
    res.status(400).end();
  }
});

const port = Number(process.env.PORT || 5175);
app.listen(port, () => console.log(`Server running on :${port}`));
