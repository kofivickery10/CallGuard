import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { PLAN_LABELS, effectivePlan } from '@callguard/shared';
import type { Plan } from '@callguard/shared';

interface ActiveSeatsData {
  billed_seats: number;
  billed_total: number;
  current_month: string;
  current_active_seats: number;
  previous_month: string;
  previous_active_seats: number;
  current_advisers: Array<{ id: string; name: string; scored_calls: number; plan_override: string | null }>;
  team: Array<{ id: string; name: string; role: string; billed: boolean }>;
}

const ROLE_LABELS: Record<string, string> = {
  adviser: 'Adviser',
  supervisor: 'Supervisor',
  viewer: 'Viewer',
  admin: 'Admin',
};

interface OrgData {
  id: string;
  name: string;
  plan: string;
}

export default function BillingOverview() {
  const { data: seatsData } = useQuery({
    queryKey: ['active-seats'],
    queryFn: () => api.get<ActiveSeatsData>('/organization/active-seats'),
  });

  const { data: orgData } = useQuery({
    queryKey: ['org'],
    queryFn: () => api.get<OrgData>('/organization'),
  });

  const orgPlan = orgData?.plan as Plan | undefined;
  const planLabel = orgPlan ? (PLAN_LABELS[orgPlan] ?? orgPlan) : '—';

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-page-title">Billing Overview</h1>
        <p className="text-page-sub text-text-secondary">
          Every person on your team is a billed seat, whatever their role and whether or not they took
          a call this month.
        </p>
      </div>

      {/* Plan */}
      <div className="bg-card rounded-card border border-border p-5 space-y-1">
        <p className="text-table-cell text-text-muted font-semibold uppercase tracking-wider text-xs">Current plan</p>
        <p className="text-card-value text-text-primary">{planLabel}</p>
        <p className="text-table-cell text-text-muted text-xs mt-1">To change your plan, contact CallGuard support.</p>
      </div>

      {/* Seat summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-card rounded-card border border-border p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">
            Billed seats — {seatsData?.current_month ?? '—'}
          </p>
          <p className="text-card-value text-text-primary">{seatsData?.billed_seats ?? '—'}</p>
          <p className="text-xs text-text-muted mt-1">
            £{seatsData ? seatsData.billed_total.toFixed(2) : '—'} this month
          </p>
        </div>
        <div className="bg-card rounded-card border border-border p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">
            Advisers with a scored call
          </p>
          <p className="text-card-value text-text-primary">{seatsData?.current_active_seats ?? '—'}</p>
          <p className="text-xs text-text-muted mt-1">
            Usage this month — not the billing basis ({seatsData?.previous_active_seats ?? '—'} last month)
          </p>
        </div>
      </div>

      {/* Team / who's billed */}
      {seatsData && seatsData.team.length > 0 && (
        <div className="bg-card rounded-card border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <h2 className="text-section-title text-text-primary">Team ({seatsData.team.length})</h2>
          </div>
          <table className="w-full">
            <thead className="bg-table-header border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 text-table-header uppercase tracking-wider text-text-muted">Name</th>
                <th className="text-left px-4 py-2.5 text-table-header uppercase tracking-wider text-text-muted">Role</th>
                <th className="text-right px-4 py-2.5 text-table-header uppercase tracking-wider text-text-muted">Billed?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {seatsData.team.map((u) => (
                <tr key={u.id} className="hover:bg-page">
                  <td className="px-4 py-3 text-table-cell text-text-primary">{u.name}</td>
                  <td className="px-4 py-3 text-table-cell text-text-secondary">{ROLE_LABELS[u.role] ?? u.role}</td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded ${u.billed ? 'bg-pass-bg text-pass' : 'bg-table-header text-text-muted'}`}
                    >
                      {u.billed ? 'Yes' : 'No'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Usage detail: advisers with a scored call this month */}
      {seatsData && seatsData.current_advisers.length > 0 && (
        <div className="bg-card rounded-card border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <h2 className="text-section-title text-text-primary">
              Scored calls this month, by adviser
            </h2>
          </div>
          <table className="w-full">
            <thead className="bg-table-header border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 text-table-header uppercase tracking-wider text-text-muted">Adviser</th>
                <th className="text-left px-4 py-2.5 text-table-header uppercase tracking-wider text-text-muted">Tier</th>
                <th className="text-left px-4 py-2.5 text-table-header uppercase tracking-wider text-text-muted">Scored calls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {seatsData.current_advisers.map((a) => {
                const adviserPlan = orgPlan
                  ? effectivePlan(orgPlan, a.plan_override as Plan | null)
                  : orgPlan;
                const tierLabel = adviserPlan ? PLAN_LABELS[adviserPlan] : '—';
                const hasOverride = !!a.plan_override && orgPlan && a.plan_override !== orgPlan;
                return (
                  <tr key={a.id} className="hover:bg-page">
                    <td className="px-4 py-3 text-table-cell text-text-primary">{a.name}</td>
                    <td className="px-4 py-3 text-table-cell text-text-secondary">
                      {tierLabel}
                      {hasOverride && (
                        <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary/10 text-secondary">
                          override
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-table-cell text-text-secondary">{a.scored_calls}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
