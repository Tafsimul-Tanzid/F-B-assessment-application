import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, money } from '../api/client.js';
import { Card, Empty, ErrorNote, Field, Loading, StockPill } from '../shared/ui.jsx';

/**
 * One outlet's menu assignment and stock.
 *
 * Assignment and stock live on the same screen on purpose: they are the same
 * decision in practice ("do we sell this here, and do we have any?"), and the
 * API creates the stock row as part of assigning the item.
 */
export function OutletDetailPage() {
  const { outletId } = useParams();
  const queryClient = useQueryClient();
  const [toAssign, setToAssign] = useState('');
  const [overrideDraft, setOverrideDraft] = useState({});
  const [restock, setRestock] = useState({});

  const outlets = useQuery({ queryKey: ['outlets'], queryFn: () => api('/hq/outlets') });
  const outlet = outlets.data?.outlets?.find((o) => o.id === outletId);

  const assigned = useQuery({
    queryKey: ['outlet-menu', outletId],
    queryFn: () => api(`/hq/outlets/${outletId}/menu`),
  });

  // Distinct from MenuItemsPage's key: this fetches active items only (the
  // default, no includeInactive param), which must not share a cache entry
  // with the master menu's includeInactive=true query.
  const catalogue = useQuery({
    queryKey: ['menu-items', { includeInactive: false }],
    queryFn: () => api('/hq/menu-items'),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['outlet-menu', outletId] });
    queryClient.invalidateQueries({ queryKey: ['outlet-inventory', outletId] });
  };

  const assign = useMutation({
    mutationFn: (body) => api(`/hq/outlets/${outletId}/menu`, { method: 'POST', body }),
    onSuccess: () => { setToAssign(''); refresh(); },
  });

  const updateAssignment = useMutation({
    mutationFn: ({ menuItemId, body }) =>
      api(`/hq/outlets/${outletId}/menu/${menuItemId}`, { method: 'PATCH', body }),
    onSuccess: (_data, variables) => {
      setOverrideDraft((d) => { const next = { ...d }; delete next[variables.menuItemId]; return next; });
      refresh();
    },
  });

  const unassign = useMutation({
    mutationFn: (menuItemId) => api(`/hq/outlets/${outletId}/menu/${menuItemId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const adjust = useMutation({
    mutationFn: (body) => api(`/hq/outlets/${outletId}/inventory/adjust`, { method: 'POST', body }),
    onSuccess: (_data, variables) => {
      setRestock((r) => ({ ...r, [variables.menuItemId]: '' }));
      refresh();
    },
  });

  const menu = assigned.data?.menu ?? [];
  const assignedIds = new Set(menu.map((m) => m.menuItemId));
  const available = (catalogue.data?.menuItems ?? []).filter((m) => !assignedIds.has(m.id));

  return (
    <>
      <div className="page-head">
        <h1>{outlet ? outlet.name : 'Outlet'}</h1>
        <Link className="btn sm" to="/hq/outlets">← All outlets</Link>
      </div>
      <p className="page-sub">
        {outlet ? `${outlet.code} · ${outlet.address ?? 'no address on file'}. ` : ''}
        Assign items from the master menu, optionally override the price for this outlet, and keep
        its stock topped up. Only assigned, available items appear on this outlet's till.
      </p>

      <ErrorNote error={outlets.error} />

      <Card
        title="Assign an item from the master menu"
      >
        <div className="row">
          <div style={{ flex: '2 1 260px' }}>
            <Field label="Menu item">
              <select value={toAssign} onChange={(e) => setToAssign(e.target.value)}>
                <option value="">
                  {available.length ? 'Choose an item…' : 'Every active item is already assigned'}
                </option>
                {available.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} — {money(item.basePrice)} ({item.sku})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button
            className="btn primary"
            disabled={!toAssign || assign.isPending}
            onClick={() => assign.mutate({ menuItemId: toAssign })}
          >
            {assign.isPending ? 'Assigning…' : 'Assign to this outlet'}
          </button>
        </div>
        {/* catalogue.error surfaces here too: it silently emptied `available`
            above, and without this the dropdown's "Every active item is
            already assigned" message would misreport a failed fetch as a
            business fact. */}
        <ErrorNote error={assign.error ?? catalogue.error} />
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
          Assigning creates the stock record at zero, so the item is on the menu but cannot be sold
          until it is stocked.
        </p>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title={`This outlet's menu (${menu.length})`} flush>
          <ErrorNote error={assigned.error ?? updateAssignment.error ?? unassign.error ?? adjust.error} />

          {assigned.isLoading ? (
            <Loading />
          ) : !menu.length ? (
            <Empty>Nothing assigned yet — this outlet cannot sell anything.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Base</th>
                    <th className="num">Outlet price</th>
                    <th>Stock</th>
                    <th>Restock</th>
                    <th>On till</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {menu.map((row) => {
                    const draftValue = overrideDraft[row.menuItemId];
                    const pending = draftValue !== undefined;
                    const overridden = row.priceOverride !== null;

                    return (
                      <tr key={row.menuItemId}>
                        <td>
                          <strong>{row.name}</strong>
                          <div className="muted small">{row.sku}{row.category ? ` · ${row.category}` : ''}</div>
                        </td>

                        <td className="num muted">{money(row.basePrice)}</td>

                        <td className="num">
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                            <input
                              type="number" step="0.01" min="0" style={{ width: 92 }}
                              placeholder={money(row.basePrice)}
                              value={pending ? draftValue : (row.priceOverride ?? '')}
                              onChange={(e) =>
                                setOverrideDraft((d) => ({ ...d, [row.menuItemId]: e.target.value }))
                              }
                            />
                            {pending && (
                              <button
                                className="btn sm primary"
                                onClick={() =>
                                  updateAssignment.mutate({
                                    menuItemId: row.menuItemId,
                                    // Empty clears the override, so the outlet
                                    // falls back to the master base price.
                                    body: { priceOverride: draftValue === '' ? null : draftValue },
                                  })
                                }
                              >
                                Save
                              </button>
                            )}
                          </div>
                          {!pending && (
                            <div className="muted small" style={{ marginTop: 3 }}>
                              {overridden ? 'overridden' : 'inherits base'}
                            </div>
                          )}
                        </td>

                        <td><StockPill quantity={row.stock} /></td>

                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input
                              type="number" step="1" style={{ width: 76 }} placeholder="+24"
                              value={restock[row.menuItemId] ?? ''}
                              onChange={(e) => setRestock((r) => ({ ...r, [row.menuItemId]: e.target.value }))}
                            />
                            <button
                              className="btn sm"
                              disabled={!restock[row.menuItemId] || adjust.isPending}
                              onClick={() =>
                                adjust.mutate({ menuItemId: row.menuItemId, delta: restock[row.menuItemId] })
                              }
                            >
                              Apply
                            </button>
                          </div>
                        </td>

                        <td>
                          <button
                            className="btn sm"
                            onClick={() =>
                              updateAssignment.mutate({
                                menuItemId: row.menuItemId,
                                body: { isAvailable: !row.isAvailable },
                              })
                            }
                          >
                            {row.isAvailable ? 'Visible' : 'Hidden'}
                          </button>
                        </td>

                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn sm danger"
                            onClick={() => unassign.mutate(row.menuItemId)}
                            title="Only possible once stock is zero"
                          >
                            Unassign
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
