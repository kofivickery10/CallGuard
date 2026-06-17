import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { api } from './api/client';
import { pingOnIncrease } from './lib/browserPing';
import { ThemeToggle } from './components/ThemeToggle';
import { Logo } from './components/Logo';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import TenantList from './pages/TenantList';
import TenantDetail from './pages/TenantDetail';
import Billing from './pages/Billing';
import Audit from './pages/Audit';
import Announcements from './pages/Announcements';
import Search from './pages/Search';
import Support from './pages/Support';

function NavItem({ to, label, badge = 0 }: { to: string; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `flex items-center justify-between px-3 py-[9px] rounded-btn text-nav-item transition-all ${
          isActive
            ? 'bg-sidebar-active text-pass font-semibold'
            : 'text-text-secondary hover:bg-sidebar-hover hover:text-text-primary'
        }`
      }
    >
      <span>{label}</span>
      {badge > 0 && (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-fail text-white text-[11px] font-bold flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </NavLink>
  );
}

function SidebarSearch() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}
    >
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search…"
        className="w-full border border-border rounded-btn px-3 py-1.5 text-sm bg-page focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </form>
  );
}

function AppLayout() {
  const { user, loading, logout } = useAuth();
  const [supportUnread, setSupportUnread] = useState(0);
  const prevSupportUnreadRef = useRef<number | null>(null);

  // Poll the cross-tenant support unread count for the sidebar badge, and fire a
  // desktop ping when it rises while the tab isn't focused.
  useEffect(() => {
    if (!user) return;
    const load = () =>
      api.get<{ count: number }>('/support/unread-count')
        .then((r) => {
          setSupportUnread(r.count);
          prevSupportUnreadRef.current = pingOnIncrease(
            prevSupportUnreadRef.current,
            r.count,
            'CallGuard support',
            'A customer sent a new support message.'
          );
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [user]);

  if (loading) return <div className="flex items-center justify-center min-h-screen text-text-muted text-sm">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-52 bg-card border-r border-sidebar-border flex flex-col shrink-0">
        <div className="px-4 py-4">
          <Logo className="h-7 w-auto" />
          <span className="block mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Superadmin</span>
        </div>
        <div className="px-3 pt-2.5 pb-2">
          <SidebarSearch />
        </div>
        <div className="px-4 pt-1 pb-1">
          <span className="text-nav-label uppercase text-text-muted">Menu</span>
        </div>
        <nav className="px-3 space-y-0.5 flex-1">
          <NavItem to="/" label="Dashboard" />
          <NavItem to="/tenants" label="Tenants" />
          <NavItem to="/billing" label="Billing" />
          <NavItem to="/audit" label="Audit log" />
          <NavItem to="/announcements" label="Announcements" />
          <NavItem to="/support" label="Support" badge={supportUnread} />
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <p className="text-xs text-text-muted truncate mb-2">{user.email}</p>
          <div className="flex items-center justify-between">
            <button
              onClick={logout}
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              Sign out
            </button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-page">
        <Routes>
          <Route path="/"              element={<Dashboard />} />
          <Route path="/tenants"       element={<TenantList />} />
          <Route path="/tenants/:id"   element={<TenantDetail />} />
          <Route path="/billing"       element={<Billing />} />
          <Route path="/audit"         element={<Audit />} />
          <Route path="/announcements" element={<Announcements />} />
          <Route path="/support"       element={<Support />} />
          <Route path="/search"        element={<Search />} />
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
