import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { pingOnIncrease } from '../lib/browserPing';
import { NotificationBell } from './NotificationBell';
import { SupportWidget } from './SupportWidget';
import { ThemeToggle } from './ThemeToggle';
import { Logo } from './Logo';

interface Announcement {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
}

const ANNOUNCEMENT_STYLES: Record<string, string> = {
  info:     'bg-processing-bg text-processing border-processing/30',
  warning:  'bg-review-bg text-review border-review/30',
  critical: 'bg-fail-bg text-fail border-fail/30',
};

// Impersonation notice + active platform announcements, stacked at the top of
// the app. Announcements can be dismissed for the session.
function AppBanners() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Poll so announcements published in the superadmin console appear here, and
  // deactivated/expired ones disappear, without the tenant refreshing the page.
  const { data } = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api.get<{ announcements: Announcement[] }>('/announcements'),
    refetchInterval: 30_000,
  });
  const announcements = data?.announcements ?? [];

  const visible = announcements.filter((a) => !dismissed.has(a.id));
  if (!user?.impersonated && visible.length === 0) return null;

  return (
    <div className="space-y-px">
      {user?.impersonated && (
        <div className="bg-review text-white px-7 py-2 text-sm font-semibold flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
          </svg>
          Viewing as {user.organization_name} — superadmin impersonation session
        </div>
      )}
      {visible.map((a) => (
        <div key={a.id} className={`px-7 py-2 text-sm border-b flex items-start justify-between gap-3 ${ANNOUNCEMENT_STYLES[a.level]}`}>
          <div>
            <span className="font-semibold">{a.title}</span>
            <span className="ml-2">{a.body}</span>
          </div>
          <button
            onClick={() => setDismissed((prev) => new Set(prev).add(a.id))}
            className="opacity-70 hover:opacity-100 font-bold shrink-0"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

interface NavItem {
  path: string;
  label: string;
  icon: string;
  // Roles allowed to see this item. Omitted = everyone.
  roles?: string[];
  // Only CallGuard platform staff (cross-tenant support inbox).
  staffOnly?: boolean;
}

interface NavSection {
  // Optional header shown above the group; omitted = no header.
  label?: string;
  items: NavItem[];
}

// Role groups for nav visibility.
const ORG_VIEW = ['admin', 'supervisor', 'viewer']; // org-wide read
const ADMIN_SUPERVISOR = ['admin', 'supervisor'];   // see the Settings hub

// Nav is grouped into sections. Set-once configuration (scorecards, knowledge
// base, alerts, integrations, team, billing, organisation) lives behind the
// single "Settings" hub rather than cluttering the top level. Upload is an
// action button on the Calls page, not a nav destination.
const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { path: '/', label: 'Dashboard', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
      { path: '/calls', label: 'Calls', icon: 'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z' },
      { path: '/customers', label: 'Customers', icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75' },
    ],
  },
  {
    label: 'Quality',
    items: [
      { path: '/journeys', label: 'Journeys', icon: 'M4 17l6-6-6-6M12 19h8', roles: ORG_VIEW },
      { path: '/review-queue', label: 'Review Queue', icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11', roles: ORG_VIEW },
      { path: '/breaches', label: 'Breaches', icon: 'M12 2L3 7v5c0 5 3.5 9.5 9 11 5.5-1.5 9-6 9-11V7l-9-5z', roles: ORG_VIEW },
      { path: '/adviser-risk', label: 'Adviser Risk', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', roles: ORG_VIEW },
      { path: '/insights', label: 'AI Insights', icon: 'M12 2l2.39 7.36H22l-6.19 4.5L18.2 22 12 17.27 5.8 22l2.39-8.14L2 9.36h7.61z', roles: ORG_VIEW },
      { path: '/calibration', label: 'Calibration', icon: 'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83', roles: ORG_VIEW },
    ],
  },
  {
    label: 'Compliance',
    items: [
      { path: '/compliance-docs', label: 'Compliance Docs', icon: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8', roles: ORG_VIEW },
      { path: '/audit-log', label: 'Audit Log', icon: 'M12 2v20M2 12h20M12 6l4 4M12 6l-4 4M12 18l4-4M12 18l-4-4', roles: ORG_VIEW },
    ],
  },
  {
    items: [
      { path: '/settings', label: 'Settings', icon: 'M4 21v-7M4 10V3M12 21v-11M12 6V3M20 21v-9M20 8V3M1 14h6M9 6h6M17 12h6', roles: ADMIN_SUPERVISOR },
      { path: '/support-inbox', label: 'Support', icon: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z', staffOnly: true },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // Staff: unread customer messages across all orgs, for the Support nav badge.
  const { data: supportUnread } = useQuery({
    queryKey: ['support-unread-staff'],
    queryFn: () => api.get<{ count: number }>('/support/unread-count'),
    enabled: !!user?.is_staff,
    refetchInterval: 20000,
  });
  const supportUnreadCount = supportUnread?.count ?? 0;

  // Desktop ping for staff when a customer message arrives and the tab isn't focused.
  const prevSupportUnreadRef = useRef<number | null>(null);
  useEffect(() => {
    if (supportUnread === undefined) return;
    prevSupportUnreadRef.current = pingOnIncrease(
      prevSupportUnreadRef.current,
      supportUnread.count,
      'CallGuard support',
      'A customer sent a new support message.'
    );
  }, [supportUnread?.count, supportUnread]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  return (
    <div className="min-h-screen">
      {/* Mobile drawer backdrop */}
      {navOpen && (
        <div
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 bg-black/30 z-30 lg:hidden"
          aria-hidden
        />
      )}

      {/* Sidebar surface. Fixed on desktop; slides in as a drawer below lg. */}
      <aside
        className={`w-[220px] bg-card border-r border-sidebar-border flex flex-col fixed left-0 top-0 h-screen z-40 transform transition-transform duration-200 lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo + active workspace (which tenant this session belongs to) */}
        <div className="px-4 py-4 flex-shrink-0">
          <Logo className="h-8 w-auto" />
          {user?.organization_name && (
            <div className="mt-3">
              <div className="text-nav-label uppercase text-text-muted">Workspace</div>
              <div className="text-table-cell font-semibold text-text-primary truncate mt-0.5" title={user.organization_name}>
                {user.organization_name}
              </div>
            </div>
          )}
        </div>

        {/* Nav (scrolls independently when items exceed viewport height) */}
        <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-1">
          {NAV_SECTIONS.map((section, si) => {
            const visible = section.items.filter((item) =>
              item.staffOnly
                ? !!user?.is_staff
                : !item.roles || (!!user?.role && item.roles.includes(user.role))
            );
            if (visible.length === 0) return null;
            return (
              <div key={si} className={si === 0 ? '' : 'mt-3'}>
                {section.label && (
                  <div className="px-2.5 pb-1">
                    <span className="text-nav-label uppercase text-text-muted">{section.label}</span>
                  </div>
                )}
                {visible.map((item) => {
                  const isActive =
                    item.path === '/'
                      ? location.pathname === '/'
                      : location.pathname.startsWith(item.path);
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={`flex items-center gap-2.5 px-2.5 py-[6px] rounded-btn mb-px transition-all text-nav-item ${
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
                      {item.path === '/support-inbox' && supportUnreadCount > 0 && (
                        <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-fail text-white text-[11px] font-bold flex items-center justify-center">
                          {supportUnreadCount > 99 ? '99+' : supportUnreadCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-sidebar-border flex-shrink-0">
          <div className="text-table-cell font-semibold text-text-primary">{user?.name}</div>
          <div className="text-xs text-text-muted mt-0.5">{user?.email}</div>
          {user?.organization_plan && (
            <Link
              to="/settings/organization"
              className={`inline-block mt-2 px-2 py-[2px] rounded text-[10px] font-bold uppercase tracking-wider ${
                user.organization_plan === 'enterprise'
                  ? 'bg-secondary text-white'
                  : user.organization_plan === 'professional'
                    ? 'bg-primary-light text-pass'
                    : 'bg-table-header text-text-muted'
              } hover:opacity-80 transition-opacity`}
              title="Manage plan"
            >
              {user.organization_plan} plan
            </Link>
          )}
          <Link
            to="/account"
            className="flex items-center gap-1 text-text-muted hover:text-text-secondary transition-colors text-xs mt-2"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
            My account
          </Link>
          <button
            onClick={logout}
            className="flex items-center gap-1 text-text-muted hover:text-text-secondary transition-colors text-xs mt-1"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
          <ThemeToggle className="mt-1" />
        </div>
      </aside>

      {/* Main content */}
      <main className="lg:ml-[220px] min-h-screen relative">
        {/* Mobile top bar: hamburger + logo + bell (below lg only) */}
        <div className="lg:hidden sticky top-0 z-20 flex items-center justify-between h-14 px-4 bg-card border-b border-sidebar-border">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="w-10 h-10 -ml-2 rounded-btn hover:bg-sidebar-hover flex items-center justify-center"
          >
            <svg viewBox="0 0 24 24" className="w-6 h-6 stroke-text-secondary" fill="none" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <Logo className="h-6 w-auto" />
          <NotificationBell />
        </div>

        <AppBanners />

        {/* Content: fills the viewport width, gently capped only on ultra-wide. */}
        <div className="py-6 px-4 sm:px-6 lg:px-8 w-full max-w-[1760px] mx-auto">
          {/* Desktop notification bell (lg+ only). In normal flow and aligned to
              the content's right edge so it reserves its own space — an absolute
              overlay here would sit on top of each page's top-right controls. */}
          <div className="hidden lg:flex justify-end -mt-1 mb-3">
            <NotificationBell />
          </div>
          {children}
        </div>
      </main>

      {/* Tenant-facing support chat (self-hides for staff) */}
      <SupportWidget />
    </div>
  );
}
