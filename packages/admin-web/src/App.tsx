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
      end={to === '/'}
      className={({ isActive }) =>
        `block px-3 py-[9px] rounded-btn text-nav-item transition-all ${
          isActive
            ? 'bg-sidebar-active text-pass font-semibold'
            : 'text-text-secondary hover:bg-sidebar-hover hover:text-text-primary'
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
      <aside className="w-52 bg-white border-r border-sidebar-border flex flex-col shrink-0">
        <div className="px-4 py-4 flex items-center gap-2.5">
          <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="none">
              <rect x="4.5"  y="14"   width="2.4" height="4"  rx="1.1" fill="white"/>
              <rect x="9"    y="11"   width="2.4" height="7"  rx="1.1" fill="white"/>
              <rect x="13.5" y="8"    width="2.4" height="10" rx="1.1" fill="white"/>
              <circle cx="19" cy="6"  r="1.6" fill="white"/>
            </svg>
          </div>
          <div className="leading-tight">
            <span className="block text-[15px] font-bold text-text-primary tracking-tight">CallGuard <span className="text-primary">AI</span></span>
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-text-muted">Superadmin</span>
          </div>
        </div>
        <div className="px-4 pt-2.5 pb-1">
          <span className="text-nav-label uppercase text-text-muted">Menu</span>
        </div>
        <nav className="px-3 space-y-0.5 flex-1">
          <NavItem to="/" label="Dashboard" />
          <NavItem to="/tenants" label="Tenants" />
          <NavItem to="/billing" label="Billing" />
        </nav>
        <div className="p-3 border-t border-sidebar-border">
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
