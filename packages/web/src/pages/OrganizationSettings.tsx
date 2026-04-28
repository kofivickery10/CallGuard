import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import {
  PLANS,
  PLAN_LABELS,
  PLAN_DESCRIPTIONS,
  hasFeature,
  type Plan,
  type OrganizationInfo,
} from '@callguard/shared';

export function OrganizationSettings() {
  const { user, refreshUser } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [saving, setSaving] = useState<Plan | null>(null);
  const [error, setError] = useState('');

  const currentPlan = user?.organization_plan as Plan | undefined;

  const handleChange = async (plan: Plan) => {
    setSaving(plan);
    setError('');
    try {
      await api.put<OrganizationInfo>('/organization/plan', { plan });
      await refreshUser();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Organisation Settings</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Manage your CallGuard plan and organisation details
        </p>
      </div>

      <div className="bg-white border border-border rounded-card p-5 mb-5">
        <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-2">
          Organisation
        </h3>
        <p className="text-table-cell text-text-primary font-semibold">{user?.organization_name}</p>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-text-primary">Plan</h3>
        {currentPlan && (
          <span className="text-[12px] text-text-muted">
            Current: <strong className="text-text-primary uppercase">{currentPlan}</strong>
          </span>
        )}
      </div>

      {error && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p;
          const isSaving = saving === p;
          return (
            <div
              key={p}
              className={`bg-white rounded-card p-5 border transition-all ${
                isCurrent ? 'border-primary ring-2 ring-primary/20' : 'border-border'
              }`}
            >
              {isCurrent && (
                <div className="inline-block text-[10px] font-semibold uppercase tracking-wider text-pass bg-primary-light px-2 py-0.5 rounded mb-2">
                  Current plan
                </div>
              )}
              <h4 className="text-[18px] font-bold text-text-primary">{PLAN_LABELS[p]}</h4>
              <p className="text-table-cell text-text-subtle mt-1">{PLAN_DESCRIPTIONS[p]}</p>
              <ul className="mt-4 space-y-1.5 text-[12px] text-text-cell">
                <li className="flex items-center gap-1.5">
                  <Check /> Scoring & breach register
                </li>
                <li className={`flex items-center gap-1.5 ${hasFeature(p, 'coaching') ? '' : 'text-text-muted line-through'}`}>
                  {hasFeature(p, 'coaching') ? <Check /> : <Cross />} AI coaching per call
                </li>
                <li className={`flex items-center gap-1.5 ${p === 'pro' ? '' : 'text-text-muted line-through'}`}>
                  {p === 'pro' ? <Check /> : <Cross />} Webhooks & priority support
                </li>
              </ul>
              {!isCurrent && isAdmin && (
                <button
                  onClick={() => handleChange(p)}
                  disabled={!!saving}
                  className="mt-4 w-full bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
                >
                  {isSaving ? 'Switching...' : `Switch to ${PLAN_LABELS[p]}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!isAdmin && (
        <p className="text-[12px] text-text-muted mt-4 text-center">
          Ask your admin to change your organisation's plan.
        </p>
      )}

      <p className="text-[11px] text-text-muted mt-6 text-center">
        Plan changes are applied immediately. In production, this would be gated by billing.
      </p>
    </div>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 text-primary flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
