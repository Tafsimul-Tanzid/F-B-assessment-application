import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, money } from '../api/client.js';
import { Card, Empty, ErrorNote, Loading } from '../shared/ui.jsx';

/**
 * The till.
 *
 * Only items assigned to this outlet appear, at this outlet's effective price.
 * The outlet is taken from the signed-in user's token, so there is no way for
 * one terminal to ring up against another outlet.
 */
export function PosPage() {
  const queryClient = useQueryClient();
  const [cart, setCart] = useState({});
  const [receipt, setReceipt] = useState(null);
  const [category, setCategory] = useState('All');

  const menu = useQuery({ queryKey: ['outlet-menu'], queryFn: () => api('/outlet/menu') });
  const rows = menu.data?.menu ?? [];

  const categories = useMemo(
    () => ['All', ...new Set(rows.map((r) => r.category).filter(Boolean))],
    [rows],
  );
  const visible = category === 'All' ? rows : rows.filter((r) => r.category === category);

  const checkout = useMutation({
    mutationFn: (items) => api('/outlet/sales', { method: 'POST', body: { items } }),
    onSuccess: (data) => {
      setReceipt(data.sale);
      setCart({});
      // Stock has moved, so the till must re-read it rather than show a stale
      // count that would let the next customer be promised something gone.
      queryClient.invalidateQueries({ queryKey: ['outlet-menu'] });
      queryClient.invalidateQueries({ queryKey: ['outlet-sales'] });
    },
  });

  const lines = Object.values(cart);
  const total = lines.reduce((sum, line) => sum + Number(line.effectivePrice) * line.quantity, 0);

  const add = (item) => {
    setReceipt(null);
    setCart((current) => {
      const existing = current[item.menuItemId];
      const quantity = (existing?.quantity ?? 0) + 1;
      // Never let the cart exceed what the outlet holds. The server enforces
      // this too; stopping here just avoids a pointless round trip and gives
      // immediate feedback.
      if (quantity > Number(item.stock)) return current;
      return { ...current, [item.menuItemId]: { ...item, quantity } };
    });
  };

  const setQuantity = (menuItemId, quantity) => {
    setCart((current) => {
      if (quantity <= 0) {
        const next = { ...current };
        delete next[menuItemId];
        return next;
      }
      const line = current[menuItemId];
      if (quantity > Number(line.stock)) return current;
      return { ...current, [menuItemId]: { ...line, quantity } };
    });
  };

  return (
    <>
      <div className="page-head">
        <h1>Point of sale</h1>
        <span className="muted small">{menu.data?.outletId ? `Till · ${rows.length} items` : ''}</span>
      </div>

      <div className="pos">
        <div>
          <div className="row" style={{ marginBottom: 12 }}>
            {categories.map((c) => (
              <button
                key={c}
                className={category === c ? 'btn primary sm' : 'btn sm'}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>

          <ErrorNote error={menu.error} />

          {menu.isLoading ? (
            <Loading label="Loading this outlet's menu…" />
          ) : !visible.length ? (
            <Card><Empty>Nothing assigned to this outlet yet. Head office assigns the menu.</Empty></Card>
          ) : (
            <div className="menu-grid">
              {visible.map((item) => {
                const inCart = cart[item.menuItemId]?.quantity ?? 0;
                const soldOut = Number(item.stock) <= 0;
                const maxed = inCart >= Number(item.stock);

                return (
                  <button
                    key={item.menuItemId}
                    className="menu-tile"
                    disabled={soldOut || maxed}
                    onClick={() => add(item)}
                    title={soldOut ? 'Out of stock' : maxed ? 'No more stock available' : `Add ${item.name}`}
                  >
                    <span className="name">{item.name}</span>
                    <span className="price">{money(item.effectivePrice)}</span>
                    <span className="foot">
                      <span className="muted small">
                        {soldOut ? 'Sold out' : `${Number(item.stock)} left`}
                      </span>
                      {inCart > 0 && <span className="pill ok">×{inCart}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="cart">
          <Card title="Current sale">
            {!lines.length ? (
              <p className="muted small" style={{ margin: 0 }}>
                Tap an item to start a sale.
              </p>
            ) : (
              <>
                {lines.map((line) => (
                  <div className="cart-line" key={line.menuItemId}>
                    <div>
                      <div className="cart-name">{line.name}</div>
                      <div className="cart-meta">
                        {money(line.effectivePrice)} each · {money(Number(line.effectivePrice) * line.quantity)}
                      </div>
                    </div>
                    <div className="qty">
                      <button onClick={() => setQuantity(line.menuItemId, line.quantity - 1)} aria-label={`Remove one ${line.name}`}>−</button>
                      <span>{line.quantity}</span>
                      <button
                        onClick={() => setQuantity(line.menuItemId, line.quantity + 1)}
                        disabled={line.quantity >= Number(line.stock)}
                        aria-label={`Add one ${line.name}`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                ))}

                <div className="cart-total">
                  <span>Total</span>
                  <span className="n">{money(total)}</span>
                </div>
              </>
            )}

            <ErrorNote error={checkout.error} />

            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <button
                className="btn primary block"
                disabled={!lines.length || checkout.isPending}
                onClick={() =>
                  checkout.mutate(
                    lines.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity })),
                  )
                }
              >
                {checkout.isPending ? 'Processing…' : `Charge ${money(total)}`}
              </button>
              {Boolean(lines.length) && (
                <button className="btn block" onClick={() => setCart({})}>Clear</button>
              )}
            </div>
          </Card>

          {receipt && (
            <div style={{ marginTop: 16 }}>
              <Card title="Receipt">
                <div className="receipt">
                  <div className="receipt-no">#{receipt.receiptNo}</div>
                  <div className="muted small" style={{ marginBottom: 12 }}>
                    {new Date(receipt.soldAt).toLocaleString()} · this outlet's own sequence
                  </div>

                  {receipt.items.map((item) => (
                    <div className="receipt-line" key={item.menuItemId}>
                      <span>{Number(item.quantity)} × {item.itemName}</span>
                      <span>{money(Number(item.unitPrice) * Number(item.quantity))}</span>
                    </div>
                  ))}

                  <div className="receipt-total">
                    <span>Total</span>
                    <span>{money(receipt.totalAmount)}</span>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
