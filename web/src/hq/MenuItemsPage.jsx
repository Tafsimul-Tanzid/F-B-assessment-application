import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, money } from '../api/client.js';
import { Card, Empty, ErrorNote, Field, Loading, SuccessNote } from '../shared/ui.jsx';

export function MenuItemsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState({ sku: '', name: '', category: '', basePrice: '' });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);

  // The key includes every param that changes the response. Without this,
  // this query and OutletDetailPage's catalogue query (which fetches active
  // items only) would collide on the same cache entry and each could serve
  // the other's stale, wrong result for up to the 10s staleTime.
  const menuItems = useQuery({
    queryKey: ['menu-items', { search, includeInactive: true }],
    queryFn: () => api('/hq/menu-items', { params: { search: search || undefined, includeInactive: 'true' } }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['menu-items'] });

  const create = useMutation({
    mutationFn: (body) => api('/hq/menu-items', { method: 'POST', body }),
    onSuccess: (data) => {
      setDraft({ sku: '', name: '', category: '', basePrice: '' });
      setNotice(`Added "${data.menuItem.name}" to the master menu.`);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }) => api(`/hq/menu-items/${id}`, { method: 'PATCH', body }),
    onSuccess: () => { setEditing(null); invalidate(); },
  });

  const deactivate = useMutation({
    mutationFn: (id) => api(`/hq/menu-items/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const items = menuItems.data?.menuItems ?? [];

  return (
    <>
      <div className="page-head"><h1>Master menu</h1></div>
      <p className="page-sub">
        The company-wide catalogue. Items are assigned to outlets separately, where each outlet can
        override the price. Changing a price here affects future sales only — past receipts keep the
        price they were rung up at.
      </p>

      <div className="grid cols-2">
        <Card title="Add an item">
          <form
            style={{ display: 'grid', gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              create.mutate({
                sku: draft.sku.trim(),
                name: draft.name.trim(),
                category: draft.category.trim() || undefined,
                basePrice: draft.basePrice,
              });
            }}
          >
            <div className="row">
              <div style={{ flex: '1 1 120px' }}>
                <Field label="SKU">
                  <input value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} placeholder="COF-MOC" required />
                </Field>
              </div>
              <div style={{ flex: '2 1 160px' }}>
                <Field label="Name">
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Mocha" required />
                </Field>
              </div>
            </div>

            <div className="row">
              <div style={{ flex: '1 1 120px' }}>
                <Field label="Category">
                  <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="Coffee" />
                </Field>
              </div>
              <div style={{ flex: '1 1 120px' }}>
                <Field label="Base price">
                  <input
                    type="number" step="0.01" min="0" inputMode="decimal"
                    value={draft.basePrice}
                    onChange={(e) => setDraft({ ...draft, basePrice: e.target.value })}
                    placeholder="4.50" required
                  />
                </Field>
              </div>
            </div>

            <ErrorNote error={create.error} />
            <SuccessNote>{notice}</SuccessNote>

            <button className="btn primary" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Adding…' : 'Add to master menu'}
            </button>
          </form>
        </Card>

        <Card title="Find an item">
          <Field label="Search by name or SKU">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="latte" />
          </Field>
          <p className="small muted" style={{ marginTop: 12, lineHeight: 1.5 }}>
            Items are deactivated rather than deleted, so sales that reference them stay intact.
            A deactivated item disappears from every outlet's till immediately.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={`Catalogue (${items.length})`} flush>
          <ErrorNote error={menuItems.error} />
          {menuItems.isLoading ? (
            <Loading />
          ) : !items.length ? (
            <Empty>No menu items match.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th className="num">Base price</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const isEditing = editing?.id === item.id;
                    return (
                      <tr key={item.id}>
                        <td className="muted">{item.sku}</td>
                        <td>
                          {isEditing ? (
                            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                          ) : (
                            <strong>{item.name}</strong>
                          )}
                        </td>
                        <td className="muted">{item.category ?? '—'}</td>
                        <td className="num">
                          {isEditing ? (
                            <input
                              type="number" step="0.01" min="0" style={{ width: 96 }}
                              value={editing.basePrice}
                              onChange={(e) => setEditing({ ...editing, basePrice: e.target.value })}
                            />
                          ) : (
                            money(item.basePrice)
                          )}
                        </td>
                        <td>
                          {item.isActive
                            ? <span className="pill ok"><span aria-hidden="true">✓</span> Active</span>
                            : <span className="pill out"><span aria-hidden="true">●</span> Inactive</span>}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {isEditing ? (
                            <>
                              <button
                                className="btn sm primary"
                                disabled={update.isPending}
                                onClick={() => update.mutate({ id: item.id, body: { name: editing.name, basePrice: editing.basePrice } })}
                              >
                                Save
                              </button>{' '}
                              <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button
                                className="btn sm"
                                onClick={() => setEditing({ id: item.id, name: item.name, basePrice: item.basePrice })}
                              >
                                Edit
                              </button>{' '}
                              {item.isActive ? (
                                <button className="btn sm danger" onClick={() => deactivate.mutate(item.id)}>
                                  Deactivate
                                </button>
                              ) : (
                                <button className="btn sm" onClick={() => update.mutate({ id: item.id, body: { isActive: true } })}>
                                  Reactivate
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <ErrorNote error={update.error ?? deactivate.error} />
        </Card>
      </div>
    </>
  );
}
