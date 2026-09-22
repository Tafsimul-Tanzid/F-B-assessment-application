import * as reportRepository from '../repositories/report.repository.js';

/**
 * HQ reporting.
 *
 * Both reports accept an optional date range; omitting it reports over all
 * time. `to` is exclusive, so a caller asking for a single day passes that
 * day and the next, and a sale at 23:59:59.999 is not lost to rounding.
 */

export async function getRevenueByOutlet({ from, to } = {}) {
  const rows = await reportRepository.revenueByOutlet({ from, to });

  // Aggregate across outlets for the dashboard header. Summed as Numbers for
  // display only — the authoritative per-outlet figures stay as the strings
  // Postgres returned.
  const companyRevenue = rows.reduce((acc, row) => acc + Number(row.revenue), 0);
  const companySales = rows.reduce((acc, row) => acc + Number(row.saleCount), 0);

  return {
    range: { from: from ?? null, to: to ?? null },
    totals: {
      revenue: companyRevenue.toFixed(2),
      saleCount: companySales,
      outletCount: rows.length,
    },
    outlets: rows,
  };
}

export async function getTopItemsByOutlet({ from, to, limit = 5 } = {}) {
  const rows = await reportRepository.topItemsByOutlet({ from, to, limit });

  // The query returns one flat, ranked row per item; group it per outlet so
  // the client does not have to. An outlet with no sales in the period simply
  // has no rows here — the revenue report is where zero-revenue outlets are
  // guaranteed to appear.
  const byOutlet = new Map();

  for (const row of rows) {
    if (!byOutlet.has(row.outletId)) {
      byOutlet.set(row.outletId, {
        outletId: row.outletId,
        outletCode: row.outletCode,
        outletName: row.outletName,
        items: [],
      });
    }

    byOutlet.get(row.outletId).items.push({
      menuItemId: row.menuItemId,
      itemName: row.itemName,
      unitsSold: row.unitsSold,
      revenue: row.revenue,
      saleCount: row.saleCount,
      rank: Number(row.rank),
    });
  }

  return {
    range: { from: from ?? null, to: to ?? null },
    limit,
    outlets: [...byOutlet.values()],
  };
}
