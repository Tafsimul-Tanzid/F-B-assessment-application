/** Small presentational pieces shared across pages. */

export const Card = ({ title, action, children, flush = false }) => (
  <section className="card">
    {(title || action) && (
      <header className="card-head">
        {typeof title === 'string' ? <h2>{title}</h2> : title}
        {action}
      </header>
    )}
    <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
  </section>
);

export const Loading = ({ label = 'Loading…' }) => <div className="spinner">{label}</div>;

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export const ErrorNote = ({ error }) => {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <span aria-hidden="true">⚠</span>
      <span>
        {error.message}
        {error.details?.length ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {error.details.map((d, i) => (
              <li key={i}>{d.field ? `${d.field}: ${d.message}` : d.message}</li>
            ))}
          </ul>
        ) : null}
      </span>
    </div>
  );
};

export const SuccessNote = ({ children }) =>
  children ? (
    <div className="alert success" role="status">
      <span aria-hidden="true">✓</span>
      <span>{children}</span>
    </div>
  ) : null;

/**
 * Stock status. The icon and the word carry the meaning; the colour only
 * reinforces it, so the state survives colour-blindness and greyscale print.
 */
export const StockPill = ({ quantity, lowAt = 10 }) => {
  const n = Number(quantity ?? 0);
  if (n <= 0) return <span className="pill out"><span aria-hidden="true">●</span> Out of stock</span>;
  if (n <= lowAt) return <span className="pill low"><span aria-hidden="true">▲</span> Low · {n}</span>;
  return <span className="pill ok"><span aria-hidden="true">✓</span> {n} in stock</span>;
};

export const Field = ({ label, children }) => (
  <label className="field">
    <span>{label}</span>
    {children}
  </label>
);
