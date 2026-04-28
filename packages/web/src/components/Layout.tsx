import { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { NotificationBell } from './NotificationBell';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  { path: '/calls', label: 'Calls', icon: 'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z' },
  { path: '/calls/upload', label: 'Upload', icon: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12' },
  { path: '/scorecards', label: 'Scorecards', icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11', adminOnly: true },
  { path: '/knowledge-base', label: 'Knowledge Base', icon: 'M4 19.5A2.5 2.5 0 016.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z', adminOnly: true },
  { path: '/integrations', label: 'Integrations', icon: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71', adminOnly: true },
  { path: '/alerts', label: 'Alerts', icon: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0', adminOnly: true },
  { path: '/breaches', label: 'Breaches', icon: 'M12 2L3 7v5c0 5 3.5 9.5 9 11 5.5-1.5 9-6 9-11V7l-9-5z', adminOnly: true },
  { path: '/adviser-risk', label: 'Adviser Risk', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', adminOnly: true },
  { path: '/insights', label: 'AI Insights', icon: 'M12 2l2.39 7.36H22l-6.19 4.5L18.2 22 12 17.27 5.8 22l2.39-8.14L2 9.36h7.61z', adminOnly: true },
  { path: '/compliance-docs', label: 'Compliance Docs', icon: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8', adminOnly: true },
  { path: '/team', label: 'Team', icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75', adminOnly: true },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();

  return (
    <div className="flex h-screen">
      {/* Sidebar - white */}
      <aside className="w-[220px] bg-white border-r border-sidebar-border flex flex-col fixed left-0 top-0 h-screen">
        {/* Logo */}
        <div className="px-5 py-5 flex items-center gap-2.5">
          <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="white" stroke="none">
              <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/>
            </svg>
          </div>
          <span className="text-[17px] font-bold text-text-primary tracking-tight">CallGuard</span>
        </div>

        {/* Nav label */}
        <div className="px-5 pt-3 pb-1.5">
          <span className="text-nav-label uppercase text-text-muted">Menu</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3">
          {navItems
            .filter((item) => !item.adminOnly || user?.role === 'admin')
            .map((item) => {
              const isActive =
                item.path === '/'
                  ? location.pathname === '/'
                  : location.pathname.startsWith(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-2.5 px-3 py-[9px] rounded-btn mb-0.5 transition-all text-nav-item ${
                    isActive
                      ? 'bg-sidebar-active text-pass font-semibold'
                      : 'text-text-secondary hover:bg-sidebar-hover hover:text-text-primary'
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-[18px] h-[18px] flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={item.icon} />
                  </svg>
                  <span>{item.label}</span>
                </Link>
              );
            })}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-sidebar-border">
          <div className="text-[13px] font-semibold text-text-primary">{user?.name}</div>
          <div className="text-[12px] text-text-muted mt-0.5">{user?.email}</div>
          {user?.organization_plan && (
            <Link
              to="/settings"
              className={`inline-block mt-2 px-2 py-[2px] rounded text-[10px] font-bold uppercase tracking-wider ${
                user.organization_plan === 'pro'
                  ? 'bg-secondary text-white'
                  : user.organization_plan === 'growth'
                    ? 'bg-primary-light text-pass'
                    : 'bg-table-header text-text-muted'
              } hover:opacity-80 transition-opacity`}
              title="Manage plan"
            >
              {user.organization_plan} plan
            </Link>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-1 text-text-muted hover:text-text-secondary transition-colors text-[12px] mt-2"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="ml-[220px] flex-1 min-h-screen relative">
        {/* Top bar with notification bell */}
        <div className="absolute top-4 right-6 z-10">
          <NotificationBell />
        </div>
        <div className="p-8 px-9 max-w-[1200px]">{children}</div>
      </main>
    </div>
  );
}
