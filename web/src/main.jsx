import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles.css';
import { AuthProvider, useAuth } from './shared/AuthContext.jsx';
import { Layout } from './shared/Layout.jsx';
import { Loading } from './shared/ui.jsx';
import { LoginPage } from './LoginPage.jsx';
import { ReportsPage } from './hq/ReportsPage.jsx';
import { MenuItemsPage } from './hq/MenuItemsPage.jsx';
import { OutletsPage } from './hq/OutletsPage.jsx';
import { OutletDetailPage } from './hq/OutletDetailPage.jsx';
import { PosPage } from './outlet/PosPage.jsx';
import { SalesHistoryPage } from './outlet/SalesHistoryPage.jsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

/**
 * Role-aware gate. The API enforces access on every request regardless; this
 * only keeps the UI from offering a screen the user cannot use.
 */
function Protected({ role, children }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading label="Restoring session…" />;
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to={user.role === 'HQ_ADMIN' ? '/hq' : '/pos'} replace />;
  return children;
}

function Root() {
  const { user, loading } = useAuth();
  if (loading) return <Loading label="Restoring session…" />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'HQ_ADMIN' ? '/hq/reports' : '/pos'} replace />;
}

function LoginRoute() {
  const { user } = useAuth();
  if (user) return <Navigate to={user.role === 'HQ_ADMIN' ? '/hq/reports' : '/pos'} replace />;
  return <LoginPage />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Root />} />
            <Route path="/login" element={<LoginRoute />} />

            <Route
              element={
                <Protected>
                  <Layout />
                </Protected>
              }
            >
              <Route path="/hq" element={<Navigate to="/hq/reports" replace />} />
              <Route path="/hq/reports" element={<Protected role="HQ_ADMIN"><ReportsPage /></Protected>} />
              <Route path="/hq/menu" element={<Protected role="HQ_ADMIN"><MenuItemsPage /></Protected>} />
              <Route path="/hq/outlets" element={<Protected role="HQ_ADMIN"><OutletsPage /></Protected>} />
              <Route path="/hq/outlets/:outletId" element={<Protected role="HQ_ADMIN"><OutletDetailPage /></Protected>} />

              <Route path="/pos" element={<Protected role="OUTLET_STAFF"><PosPage /></Protected>} />
              <Route path="/pos/history" element={<Protected role="OUTLET_STAFF"><SalesHistoryPage /></Protected>} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
