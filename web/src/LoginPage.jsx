import { useState } from 'react';
import { useAuth } from './shared/AuthContext.jsx';
import { Card, ErrorNote, Field } from './shared/ui.jsx';

/**
 * The demo accounts are listed here deliberately: this is a review build with
 * seeded data, and a reviewer should not have to read the seeder to get in.
 */
const DEMO = [
  { email: 'hq@fnb.test', role: 'HQ admin — all outlets' },
  { email: 'downtown@fnb.test', role: 'Outlet staff — Downtown Café' },
  { email: 'airport@fnb.test', role: 'Outlet staff — Airport Kiosk' },
  { email: 'mall@fnb.test', role: 'Outlet staff — Mall Stand' },
];

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('hq@fnb.test');
  const [password, setPassword] = useState('Password123!');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      // Routing is driven by the user's role once auth state updates.
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 style={{ marginBottom: 6 }}>F&amp;B Point of Sale</h1>
        <p className="page-sub">Sign in to head office or to an outlet terminal.</p>

        <Card>
          <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
            <Field label="Email">
              <input
                type="email"
                value={email}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>

            <ErrorNote error={error} />

            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="demo-logins">
            <div className="small muted" style={{ marginBottom: 6 }}>
              Demo accounts — password <code>Password123!</code>
            </div>
            {DEMO.map((account) => (
              <button
                key={account.email}
                type="button"
                onClick={() => { setEmail(account.email); setPassword('Password123!'); }}
              >
                <span>{account.email}</span>
                <span className="muted">{account.role}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
