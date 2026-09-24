import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client.js';
import { Card, Empty, ErrorNote, Field, Loading } from '../shared/ui.jsx';

export function OutletsPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ code: '', name: '', address: '' });

  const outlets = useQuery({ queryKey: ['outlets'], queryFn: () => api('/hq/outlets') });

  const create = useMutation({
    mutationFn: (body) => api('/hq/outlets', { method: 'POST', body }),
    onSuccess: () => {
      setDraft({ code: '', name: '', address: '' });
      queryClient.invalidateQueries({ queryKey: ['outlets'] });
    },
  });

  const rows = outlets.data?.outlets ?? [];

  return (
    <>
      <div className="page-head"><h1>Outlets</h1></div>
      <p className="page-sub">
        Each outlet keeps its own menu assignment, its own stock and its own receipt sequence.
        Open one to assign menu items, override prices and manage stock.
      </p>

      <div className="grid cols-2">
        <Card title={`Outlets (${rows.length})`} flush>
          <ErrorNote error={outlets.error} />
          {outlets.isLoading ? (
            <Loading />
          ) : !rows.length ? (
            <Empty>No outlets yet.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Code</th><th>Name</th><th>Address</th><th /></tr>
                </thead>
                <tbody>
                  {rows.map((outlet) => (
                    <tr key={outlet.id}>
                      <td className="muted">{outlet.code}</td>
                      <td><strong>{outlet.name}</strong></td>
                      <td className="muted small">{outlet.address ?? '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Link className="btn sm" to={`/hq/outlets/${outlet.id}`}>Manage</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Open a new outlet">
          <form
            style={{ display: 'grid', gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({
                code: draft.code.trim(),
                name: draft.name.trim(),
                address: draft.address.trim() || undefined,
              });
            }}
          >
            <Field label="Code">
              <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="HB-04" required />
            </Field>
            <Field label="Name">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Harbour Bar" required />
            </Field>
            <Field label="Address">
              <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="Pier 9" />
            </Field>

            <ErrorNote error={create.error} />

            <button className="btn primary" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create outlet'}
            </button>

            <p className="small muted" style={{ lineHeight: 1.5, margin: 0 }}>
              A new outlet starts with an empty menu and its receipt counter at zero. Its first sale
              will be receipt #1, numbered independently of every other outlet.
            </p>
          </form>
        </Card>
      </div>
    </>
  );
}
