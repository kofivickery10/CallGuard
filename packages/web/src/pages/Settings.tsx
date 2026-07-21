import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';

interface SettingsCard {
  path: string;
  label: string;
  description: string;
  icon: string;
  roles: string[];
  // Per-tenant module gate (e.g. the Data Capture module).
  requiresFeature?: 'capture';
}

const ADMIN = ['admin'];
const ADMIN_SUPERVISOR = ['admin', 'supervisor'];

// Set-once configuration, grouped behind the Settings hub so it doesn't
// clutter the main nav. Each card is role-gated.
const CARDS: SettingsCard[] = [
  {
    path: '/settings/organization',
    label: 'Organisation',
    description: 'Plan, adviser channel, and data-improvement consent.',
    icon: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-3M9 9v.01M9 12v.01M9 15v.01M9 18v.01',
    roles: ADMIN,
  },
  {
    path: '/scorecards',
    label: 'Scorecards',
    description: 'Define and edit the criteria calls are scored against.',
    icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
    roles: ADMIN,
  },
  {
    path: '/capture-forms',
    label: 'Data Capture Forms',
    description: 'Question sets the AI captures answers to on every sale.',
    icon: 'M4 4h16v4H4zM4 10h16v4H4zM4 16h10v4H4zM18 18l2 2 4-4',
    roles: ADMIN,
    requiresFeature: 'capture',
  },
  {
    path: '/knowledge-base',
    label: 'Knowledge Base',
    description: 'Business context that informs scoring and coaching.',
    icon: 'M4 19.5A2.5 2.5 0 016.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z',
    roles: ADMIN,
  },
  {
    path: '/alerts',
    label: 'Alerts',
    description: 'Email/Slack rules for breaches and failed calls.',
    icon: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
    roles: ADMIN,
  },
  {
    path: '/integrations',
    label: 'Integrations',
    description: 'API keys, SFTP sources, dialler and CRM connections.',
    icon: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
    roles: ADMIN,
  },
  {
    path: '/team',
    label: 'Team',
    description: 'Invite and manage users, roles and advisers.',
    icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
    roles: ADMIN,
  },
  {
    path: '/billing',
    label: 'Billing',
    description: 'Active seats and your current-month usage.',
    icon: 'M3 3h18v18H3zM3 9h18M9 21V9',
    roles: ADMIN_SUPERVISOR,
  },
];

export default function Settings() {
  const { user } = useAuth();
  const role = user?.role ?? '';
  const { data: orgInfo } = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<{ capture_enabled?: boolean }>('/organization'),
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  const features: Record<'capture', boolean> = { capture: orgInfo?.capture_enabled === true };
  const cards = CARDS.filter(
    (c) => c.roles.includes(role) && (!c.requiresFeature || features[c.requiresFeature])
  );

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Settings</h2>
        <p className="text-page-sub text-text-subtle mt-1">Configure your organisation, scoring and integrations.</p>
      </div>

      {cards.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-8 text-center text-text-muted text-table-cell">
          You don't have access to any settings. Contact your administrator.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((card) => (
            <Link
              key={card.path}
              to={card.path}
              className="group bg-card border border-border rounded-card p-5 hover:border-primary hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-btn bg-primary-light flex items-center justify-center flex-shrink-0">
                  <svg
                    viewBox="0 0 24 24"
                    className="w-[18px] h-[18px] text-pass"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={card.icon} />
                  </svg>
                </div>
                <span className="text-section-title text-text-primary group-hover:text-primary transition-colors">
                  {card.label}
                </span>
              </div>
              <p className="text-table-cell text-text-muted">{card.description}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
