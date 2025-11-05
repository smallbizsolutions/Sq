import React, { useEffect, useMemo, useState } from "react";

const money = (m) =>
  m ? `$${(Number(m.amount) / 100).toFixed(2)}` : "";

export default function App() {
  const [menu, setMenu] = useState({ items: [] });
  const [category, setCategory] = useState("all");
  const [cart, setCart] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/menu")
      .then((r) => r.json())
      .then(setMenu)
      .catch(() => setError("Failed to load menu"));
  }, []);

  const categories = useMemo(() => {
    // Items may not carry category names; keep a simple “All” for now.
    return ["all"];
  }, [menu]);

  const filtered = useMemo(() => {
    if (category === "all") return menu.items;
    return menu.items.filter((i) => i.categories?.includes(category));
  }, [menu, category]);

  const addToCart = (item, variationId, selectedMods) => {
    if (!variationId) return;
    setCart((c) => [
      ...c,
      {
        id: crypto.randomUUID(),
        itemId: item.id,
        itemName: item.name,
        catalogObjectId: variationId,
        modifiers: selectedMods.map((id) => ({ catalogObjectId: id, quantity: "1" })),
        quantity: 1,
      },
    ]);
  };

  const total = useMemo(() => {
    // rough client-side total for display — real total comes from Square Order
    let cents = 0;
    for (const line of cart) {
      const item = menu.items.find((i) => i.id === line.itemId);
      const variation = item?.variations.find((v) => v.id === line.catalogObjectId);
      cents += (Number(variation?.priceMoney?.amount ?? 0)) * line.quantity;
      for (const m of line.modifiers) {
        // find the price of each selected modifier
        for (const ml of item?.modifierLists ?? []) {
          const mm = ml.modifiers.find((x) => x.id === m.catalogObjectId);
          if (mm?.priceMoney?.amount) cents += Number(mm.priceMoney.amount) * line.quantity;
        }
      }
    }
    return `$${(cents / 100).toFixed(2)}`;
  }, [cart, menu]);

  const kickoffPayment = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineItems: cart.map((c) => ({
            catalogObjectId: c.catalogObjectId,
            quantity: String(c.quantity),
            modifiers: c.modifiers
          })),
          note: "Kiosk order"
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "checkout_failed");

      // Optional: poll or rely on webhooks. Here we just show a simple status.
      alert("Sent to Terminal. Complete payment on the card reader.");
      setCart([]);
    } catch (e) {
      console.error(e);
      setError("Payment start failed. Check device pairing & totals.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Order Here</h1>
        <div className="text-xl">Cart Total: <strong>{total}</strong></div>
      </header>

      <div className="flex gap-4">
        <aside className="w-64 hidden md:block">
          <div className="card sticky top-4">
            <h2 className="text-lg font-semibold mb-3">Categories</h2>
            <div className="space-y-2">
              {categories.map((c) => (
                <button
                  key={c}
                  className={`btn w-full ${category === c ? "bg-black text-white" : "bg-gray-200"}`}
                  onClick={() => setCategory(c)}
                >
                  {c === "all" ? "All" : c}
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => (
            <ItemCard key={item.id} item={item} onAdd={addToCart} />
          ))}
        </main>

        <aside className="w-80">
          <div className="card sticky top-4 space-y-3">
            <h2 className="text-lg font-semibold">Your Order</h2>
            {cart.length === 0 ? (
              <div className="text-gray-500">Cart is empty</div>
            ) : (
              cart.map((line) => (
                <div key={line.id} className="border-b pb-2">
                  <div className="font-medium">{line.itemName}</div>
                  <div className="text-sm text-gray-600">
                    {line.modifiers.length} modifier{line.modifiers.length !== 1 ? "s" : ""}
                  </div>
                </div>
              ))
            )}
            <button
              className="btn w-full bg-emerald-600 text-white disabled:opacity-50"
              disabled={busy || cart.length === 0}
              onClick={kickoffPayment}
            >
              {busy ? "Sending to Terminal…" : "Pay at Card Reader"}
            </button>
            {error && <div className="text-red-600 text-sm">{error}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ItemCard({ item, onAdd }) {
  const [variationId, setVariationId] = useState(item.variations?.[0]?.id ?? "");
  const [selected, setSelected] = useState({}); // { modifierListId: Set(modifierId) }

  const toggle = (listId, modId) => {
    setSelected((s) => {
      const next = new Set(s[listId] ?? []);
      if (next.has(modId)) next.delete(modId);
      else next.add(modId);
      return { ...s, [listId]: next };
    });
  };

  const selectedMods = Object.values(selected)
    .flatMap((set) => Array.from(set));

  return (
    <div className="card flex flex-col gap-3">
      <div>
        <div className="text-xl font-semibold">{item.name}</div>
        {item.description ? <div className="text-sm text-gray-600">{item.description}</div> : null}
      </div>

      {item.variations?.length > 0 && (
        <select
          className="w-full border rounded-lg p-2"
          value={variationId}
          onChange={(e) => setVariationId(e.target.value)}
        >
          {item.variations.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} {v.priceMoney ? `• ${money(v.priceMoney)}` : ""}
            </option>
          ))}
        </select>
      )}

      {item.modifierLists?.map((list) => (
        <div key={list.id} className="space-y-2">
          <div className="font-medium">{list.name}</div>
          <div className="flex flex-wrap gap-2">
            {list.modifiers.map((m) => {
              const active = selected[list.id]?.has(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => toggle(list.id, m.id)}
                  className={`btn ${active ? "bg-black text-white" : "bg-gray-200"}`}
                >
                  {m.name} {m.priceMoney ? `(${money(m.priceMoney)})` : ""}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <button
        className="btn bg-blue-600 text-white mt-auto"
        onClick={() => onAdd(item, variationId, selectedMods)}
      >
        Add
      </button>
    </div>
  );
}
