import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import TenantList from './pages/TenantList';
import TenantDetail from './pages/TenantDetail';
import Billing from './pages/Billing';

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `block px-3 py-2 rounded-btn text-sm font-medium transition-colors ${
          isActive
            ? 'bg-primary/10 text-primary'
            : 'text-text-secondary hover:bg-gray-100'
        }`
      }
    >
      {label}
    </NavLink>
  );
}

function AppLayout() {
  const { user, loading, logout } = useAuth();

  if (loading) return <div className="flex items-center justify-center min-h-screen text-text-muted text-sm">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-52 bg-white border-r border-border flex flex-col shrink-0">
        <div className="px-4 py-5 border-b border-border">
          <p className="text-sm font-bold text-text-primary">CallGuard</p>
          <p className="text-xs text-text-muted">Admin Portal</p>
        </div>
        <nav className="p-3 space-y-1 flex-1">
          <NavItem to="/" label="Dashboard" />
          <NavItem to="/tenants" label="Tenants" />
          <NavItem to="/billing" label="Billing" />
        </nav>
        <div className="p-3 border-t border-border">
          <p className="text-xs text-text-muted truncate mb-2">{user.email}</p>
          <button
            onClick={logout}
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-page">
        <Routes>
          <Route path="/"              element={<Dashboard />} />
          <Route path="/tenants"       element={<TenantList />} />
          <Route path="/tenants/:id"   element={<TenantDetail />} />
          <Route path="/billing"       element={<Billing />} />
          <Route path="*"              element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginGuard />} />
          <Route path="/*"    element={<AppLayout />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function LoginGuard() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user)    return <Navigate to="/" replace />;
  return <Login />;
}
