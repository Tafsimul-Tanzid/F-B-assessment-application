import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

const HQ_NAV = [
  { to: '/hq/reports', label: 'Reports' },
  { to: '/hq/menu', label: 'Master menu' },
  { to: '/hq/outlets', label: 'Outlets' },
];

const OUTLET_NAV = [
  { to: '/pos', label: 'Point of sale' },
  { to: '/pos/history', label: 'Sales' },
];

export function Layout() {
  const { user, logout, isHq } = useAuth();
  const nav = isHq ? HQ_NAV : OUTLET_NAV;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          F&amp;B <span>{isHq ? 'HQ' : user?.outlet?.code ?? 'POS'}</span>
        </div>

        <nav className="nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/pos'}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="who">
          <span className="muted">
            {user?.fullName}
            {user?.outlet ? ` · ${user.outlet.name}` : ' · Head office'}
          </span>
          <button className="btn sm" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
