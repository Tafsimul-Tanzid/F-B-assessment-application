import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, money } from '../api/client.js';
import { Card, Empty, ErrorNote, Loading } from '../shared/ui.jsx';

export function SalesHistoryPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [reason, setReason] = useState('');

  const sales = useQuery({
    queryKey: ['outlet-sales'],
    queryFn: () => api('/outlet/sales', { params: { limit: 100 } }),
  });

  const detail = useQuery({
    queryKey: ['outlet-sale', selected],
    queryFn: () => api(`/outlet/sales/${selected}`),
    enabled: Boolean(selected),
  });

  const voidSale = useMutation({
    mutationFn: ({ saleId, reason: why }) =>
      api(`/outlet/sales/${saleId}/void`, { method: 'POST', body: { reason: why } }),
    onSuccess: () => {
      setVoiding(null);
      setReason('');
      // Stock came back and the reports changed, so both must be re-read.
      queryClient.invalidateQueries({ queryKey: ['outlet-sales'] });
      queryClient.invalidateQueries({ queryKey: ['outlet-sale'] });
      queryClient.invalidateQueries({ queryKey: ['outlet-menu'] });
    },
  });

  const rows = sales.data?.sales ?? [];

  return (
    <>
      <div className="page-head"><h1>Sales</h1></div>
      <p className="page-sub">
        This outlet's own receipts, numbered sequentially from #1 and independently of every other
        outlet. Reprints show the prices exactly as they were charged. Voiding returns the stock
        and issues a credit note — the sale itself is kept, and its receipt number is never reused.
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
                    <th className="num">Total</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sale) => {
                    const isVoided = sale.status === 'voided';
                    return (
                      <tr key={sale.id}>
                        <td>
                          <strong style={isVoided ? { textDecoration: 'line-through' } : undefined}>
                            #{sale.receiptNumber}
                          </strong>
                        </td>
                        <td className="muted small">{new Date(sale.soldAt).toLocaleString()}</td>
                        <td className="num">{sale.itemCount}</td>
                        <td className="num">
                          <strong style={isVoided ? { textDecoration: 'line-through' } : undefined}>
                            {money(sale.totalAmount)}
                          </strong>
                        </td>
                        <td>
                          {isVoided ? (
                            /* Icon plus words, never colour alone. */
                            <span className="pill out">
                              <span aria-hidden="true">●</span> Voided · CN#{sale.creditNoteNo}
                            </span>
                          ) : (
                            <span className="pill ok"><span aria-hidden="true">✓</span> Completed</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn sm" onClick={() => setSelected(sale.id)}>Reprint</button>{' '}
                          {!isVoided && (
                            <button
                              className="btn sm danger"
                              onClick={() => { setVoiding(sale); setReason(''); }}
                            >
                              Void
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div>
          {voiding && (
            <div style={{ marginBottom: 16 }}>
              <Card title={`Void receipt #${voiding.receiptNumber}?`}>
                <p className="small" style={{ marginTop: 0, lineHeight: 1.5 }}>
                  This returns <strong>{voiding.itemCount}</strong> line
                  {voiding.itemCount === 1 ? '' : 's'} worth {money(voiding.totalAmount)} to stock and
                  issues a credit note. The sale is kept in the books and its receipt number is not
                  reused.
                </p>

                <label className="field">
                  <span>Reason (recorded against the void)</span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Customer changed their mind"
                    autoFocus
                  />
                </label>

                <ErrorNote error={voidSale.error} />

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    className="btn danger"
                    disabled={reason.trim().length < 3 || voidSale.isPending}
                    onClick={() => voidSale.mutate({ saleId: voiding.id, reason })}
                  >
                    {voidSale.isPending ? 'Voiding…' : 'Void this sale'}
                  </button>
                  <button className="btn" onClick={() => setVoiding(null)}>Cancel</button>
                </div>
              </Card>
            </div>
          )}

          {selected && (
            <Card title="Reprint">
              {detail.isLoading ? (
                <Loading />
              ) : detail.data ? (
                <div className="receipt">
                  <div className="receipt-no">#{detail.data.sale.receiptNumber}</div>
                  <div className="muted small" style={{ marginBottom: 12 }}>
                    {detail.data.sale.outletName} · {new Date(detail.data.sale.soldAt).toLocaleString()}
                  </div>

                  {detail.data.sale.status === 'voided' && (
                    <div className="alert error" style={{ marginBottom: 12 }}>
                      <span aria-hidden="true">●</span>
                      <span>
                        <strong>Voided</strong> — credit note #{detail.data.sale.creditNoteNo}
                        {detail.data.sale.voidReason ? ` · ${detail.data.sale.voidReason}` : ''}
                      </span>
                    </div>
                  )}
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
