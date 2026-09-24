import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, money } from '../api/client.js';
import { BarChart } from '../shared/BarChart.jsx';
import { Card, Empty, ErrorNote, Field, Loading } from '../shared/ui.jsx';

/** Presets rather than a bare pair of date inputs, which is what people actually want. */
const RANGES = [
  { key: 'all', label: 'All time' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'today', label: 'Today' },
];

function rangeToParams(key, custom) {
  if (key === 'custom') return { from: custom.from || undefined, to: custom.to || undefined };
  if (key === 'all') return {};

  const now = new Date();
  // `to` is exclusive in the API, so it is pushed to the start of tomorrow;
  // otherwise a sale later today would fall outside "today".
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = new Date(to);

  if (key === 'today') from.setDate(to.getDate() - 1);
  if (key === '7d') from.setDate(to.getDate() - 7);
  if (key === '30d') from.setDate(to.getDate() - 30);

  return { from: from.toISOString(), to: to.toISOString() };
}

export function ReportsPage() {
  const [range, setRange] = useState('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const params = rangeToParams(range, custom);

  const revenue = useQuery({
    queryKey: ['reports', 'revenue', params],
    queryFn: () => api('/hq/reports/revenue', { params }),
  });

  const topItems = useQuery({
    queryKey: ['reports', 'top-items', params],
    queryFn: () => api('/hq/reports/top-items', { params: { ...params, limit: 5 } }),
  });

  const outlets = revenue.data?.outlets ?? [];
  const totals = revenue.data?.totals;

  const bestOutlet = outlets.find((o) => Number(o.revenue) > 0);

  return (
    <>
      <div className="page-head">
        <h1>Reports</h1>
      </div>
      <p className="page-sub">
        Revenue and best sellers across every outlet. Figures come from the price recorded on each
        sale at the time it was rung up, so changing a menu price never restates past revenue.
      </p>

      {/* Filters sit in one row above the charts. */}
      <div className="row" style={{ marginBottom: 20 }}>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={range === r.key ? 'btn primary sm' : 'btn sm'}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
        <button
          className={range === 'custom' ? 'btn primary sm' : 'btn sm'}
          onClick={() => setRange('custom')}
        >
          Custom
        </button>

        {range === 'custom' && (
          <>
            <Field label="From">
              <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </Field>
            <Field label="To (exclusive)">
              <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </Field>
          </>
        )}
      </div>

      <ErrorNote error={revenue.error} />

      {revenue.isLoading ? (
        <Loading />
      ) : (
        <>
          {/* Headline numbers are stat tiles, not a one-bar chart. */}
          <div className="kpi-row">
            <div className="kpi">
              <div className="kpi-label">Total revenue</div>
              <div className="kpi-value hero">{money(totals?.revenue)}</div>
              <div className="kpi-note">across {totals?.outletCount ?? 0} outlets</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Sales</div>
              <div className="kpi-value">{totals?.saleCount ?? 0}</div>
              <div className="kpi-note">completed transactions</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Average sale</div>
              <div className="kpi-value">
                {money(totals?.saleCount ? Number(totals.revenue) / Number(totals.saleCount) : 0)}
              </div>
              <div className="kpi-note">per transaction</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Top outlet</div>
              <div className="kpi-value" style={{ fontSize: '1.15rem' }}>
                {bestOutlet ? bestOutlet.outletName : '—'}
              </div>
              <div className="kpi-note">
                {bestOutlet ? `${money(bestOutlet.revenue)} revenue` : 'no sales in this period'}
              </div>
            </div>
          </div>

          <div className="grid" style={{ marginBottom: 16 }}>
            <Card title="Revenue by outlet">
              <BarChart
                rows={outlets.map((o) => ({
                  key: o.outletId,
                  label: o.outletName,
                  value: Number(o.revenue),
                }))}
              />

              {/* The same figures as a table: the chart is never the only way
                  to read the data. */}
              <div className="table-scroll" style={{ marginTop: 18 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Outlet</th>
                      <th>Code</th>
                      <th className="num">Sales</th>
                      <th className="num">Items</th>
                      <th className="num">Avg sale</th>
                      <th className="num">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outlets.map((o) => (
                      <tr key={o.outletId}>
                        <td>{o.outletName}</td>
                        <td className="muted">{o.outletCode}</td>
                        <td className="num">{o.saleCount}</td>
                        <td className="num">{o.itemsSold}</td>
                        <td className="num">{money(o.averageSale)}</td>
                        <td className="num"><strong>{money(o.revenue)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <Card title="Top 5 items per outlet" flush>
            {topItems.isLoading ? (
              <Loading />
            ) : !topItems.data?.outlets?.length ? (
              <Empty>No sales in this period yet.</Empty>
            ) : (
              <div className="grid cols-2" style={{ padding: 16 }}>
                {topItems.data.outlets.map((outlet) => (
                  <div key={outlet.outletId}>
                    <h3 style={{ marginBottom: 10 }}>
                      {outlet.outletName} <span className="muted small">· {outlet.outletCode}</span>
                    </h3>
                    <BarChart
                      rows={outlet.items.map((item) => ({
                        key: item.menuItemId,
                        label: item.itemName,
                        value: Number(item.unitsSold),
                      }))}
                      format={(v) => String(v)}
                      unit=" sold"
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
