import { money } from '../api/client.js';

/**
 * Horizontal bar chart for comparing one measure across a handful of named
 * categories.
 *
 * Form and colour follow from the data's job. This compares magnitude for a
 * SINGLE measure, so every bar wears the same sequential hue: the categories
 * are not the subject, the amounts are, and a categorical palette would imply
 * a distinction that does not exist (and would repaint the survivors whenever
 * a filter changed the row count).
 *
 * Every bar is directly labelled with its value, so the chart is readable
 * without hovering and without an axis, and the same rows are available as a
 * table beneath it for screen readers and for anyone who wants the numbers.
 */
export function BarChart({ rows, valueKey = 'value', labelKey = 'label', format = money, unit = '' }) {
  if (!rows?.length) return <div className="empty">No data for this period.</div>;

  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0));

  return (
    <div className="bars">
      {rows.map((row) => {
        const value = Number(row[valueKey]) || 0;
        // Guard the all-zero case: every bar renders empty rather than full.
        const pct = max > 0 ? (value / max) * 100 : 0;
        const label = `${row[labelKey]}: ${format(value)}${unit}`;

        return (
          <div className={value > 0 ? 'bar-row' : 'bar-row empty'} key={row.key ?? row[labelKey]}>
            <div className="bar-name" title={row[labelKey]}>{row[labelKey]}</div>
            <div
              className="bar-track"
              role="img"
              aria-label={label}
              title={label}
            >
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="bar-value">{format(value)}{unit}</div>
          </div>
        );
      })}
    </div>
  );
}
