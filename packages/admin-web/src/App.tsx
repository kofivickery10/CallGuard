import { useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import TenantList from './pages/TenantList';
import TenantDetail from './pages/TenantDetail';
import Billing from './pages/Billing';
import Audit from './pages/Audit';
import Announcements from './pages/Announcements';
import Search from './pages/Search';

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

  if (loading) return <div className="flex items-center justify-center min-h-screen text-text-muted text-sm">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-52 bg-white border-r border-sidebar-border flex flex-col shrink-0">
        <div className="px-4 py-4">
          <img src="/callguard-logo-horizontal.svg" alt="CallGuard AI" className="h-6 w-auto" />
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
          <Route path="/audit"         element={<Audit />} />
          <Route path="/announcements" element={<Announcements />} />
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
