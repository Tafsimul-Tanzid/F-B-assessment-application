import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, money } from '../api/client.js';
import { Card, Empty, ErrorNote, Loading } from '../shared/ui.jsx';

export function SalesHistoryPage() {
  const [selected, setSelected] = useState(null);

  const sales = useQuery({
    queryKey: ['outlet-sales'],
    queryFn: () => api('/outlet/sales', { params: { limit: 100 } }),
  });

  const detail = useQuery({
    queryKey: ['outlet-sale', selected],
    queryFn: () => api(`/outlet/sales/${selected}`),
    enabled: Boolean(selected),
  });

  const rows = sales.data?.sales ?? [];

  return (
    <>
      <div className="page-head"><h1>Sales</h1></div>
      <p className="page-sub">
        This outlet's own receipts, numbered sequentially from #1 and independently of every other
        outlet. Reprints show the prices exactly as they were charged.
      </p>

      <div className="pos">
        <Card title={`Receipts (${rows.length})`} flush>
          <ErrorNote error={sales.error} />
          {sales.isLoading ? (
            <Loading />
          ) : !rows.length ? (
            <Empty>No sales yet today.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Receipt</th><th>Time</th><th className="num">Lines</th>
                    <th className="num">Total</th><th>Cashier</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sale) => (
                    <tr key={sale.id}>
                      <td><strong>#{sale.receiptNo}</strong></td>
                      <td className="muted small">{new Date(sale.soldAt).toLocaleString()}</td>
                      <td className="num">{sale.itemCount}</td>
                      <td className="num"><strong>{money(sale.totalAmount)}</strong></td>
                      <td className="muted small">{sale.cashierName ?? '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn sm" onClick={() => setSelected(sale.id)}>Reprint</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div>
          {selected && (
            <Card title="Reprint">
              {detail.isLoading ? (
                <Loading />
              ) : detail.data ? (
                <div className="receipt">
                  <div className="receipt-no">#{detail.data.sale.receiptNo}</div>
                  <div className="muted small" style={{ marginBottom: 12 }}>
                    {detail.data.sale.outletName} · {new Date(detail.data.sale.soldAt).toLocaleString()}
                  </div>
                  {detail.data.sale.items.map((item, i) => (
                    <div className="receipt-line" key={i}>
                      <span>{Number(item.quantity)} × {item.itemName}</span>
                      <span>{money(item.lineTotal)}</span>
                    </div>
                  ))}
                  <div className="receipt-total">
                    <span>Total</span>
                    <span>{money(detail.data.sale.totalAmount)}</span>
                  </div>
                  <p className="small muted" style={{ marginTop: 14, lineHeight: 1.5 }}>
                    Item names and prices are stored on the sale itself, so this reprint is
                    unaffected by any later menu change.
                  </p>
                </div>
              ) : (
                <ErrorNote error={detail.error} />
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
