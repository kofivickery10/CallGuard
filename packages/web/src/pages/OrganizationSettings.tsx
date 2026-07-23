import { useState, useEffect } from 'react';
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

interface ActiveSeats {
  current_month: string;
  current_active_seats: number;
  previous_month: string;
  previous_active_seats: number;
  current_advisers: { id: string; name: string; scored_calls: number }[];
}

export function OrganizationSettings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [error, setError] = useState('');

  const currentPlan = user?.organization_plan as Plan | undefined;

  // Data-improvement opt-in (DPA §4.2). undefined = loading.
  const [dataOptIn, setDataOptIn] = useState<boolean | undefined>(undefined);
  const [dataOptInAt, setDataOptInAt] = useState<string | null>(null);
  const [savingOptIn, setSavingOptIn] = useState(false);

  // Industry / advice domain (frames AI scoring). undefined = loading.
  const [industry, setIndustry] = useState<string | undefined>(undefined);
  const [industryDraft, setIndustryDraft] = useState('');
  const [savingIndustry, setSavingIndustry] = useState(false);

  // Transcription keyterms (domain vocabulary boosted in speech-to-text).
  // Stored as an array; edited as one term per line. undefined = loading.
  const [keyterms, setKeyterms] = useState<string | undefined>(undefined);
  const [keytermsDraft, setKeytermsDraft] = useState('');
  const [savingKeyterms, setSavingKeyterms] = useState(false);

  // Active-seat usage (admin only)
  const [seats, setSeats] = useState<ActiveSeats | null>(null);

  useEffect(() => {
    api
      .get<OrganizationInfo>('/organization')
      .then((org) => {
        setDataOptIn(org.data_improvement_opt_in ?? false);
        setDataOptInAt(org.data_improvement_opt_in_at ?? null);
        setIndustry(org.industry ?? '');
        setIndustryDraft(org.industry ?? '');
        const terms = (org.keyterms ?? []).join('\n');
        setKeyterms(terms);
        setKeytermsDraft(terms);
      })
      .catch(() => {
        setDataOptIn(false);
        setIndustry('');
        setKeyterms('');
      });
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api.get<ActiveSeats>('/organization/active-seats').then(setSeats).catch(() => setSeats(null));
  }, [isAdmin]);

  const handleIndustrySave = async () => {
    setSavingIndustry(true);
    setError('');
    try {
      const updated = await api.put<OrganizationInfo>('/organization/industry', {
        industry: industryDraft.trim() || null,
      });
      const next = updated.industry ?? '';
      setIndustry(next);
      setIndustryDraft(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingIndustry(false);
    }
  };

  const handleKeytermsSave = async () => {
    setSavingKeyterms(true);
    setError('');
    try {
      const terms = keytermsDraft
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await api.put<OrganizationInfo>('/organization/keyterms', {
        keyterms: terms,
      });
      const next = (updated.keyterms ?? []).join('\n');
      setKeyterms(next);
      setKeytermsDraft(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingKeyterms(false);
    }
  };

  const handleOptInChange = async (value: boolean) => {
    setSavingOptIn(true);
    setError('');
    try {
      const updated = await api.put<OrganizationInfo>('/organization/data-improvement', {
        opt_in: value,
      });
      setDataOptIn(updated.data_improvement_opt_in ?? false);
      setDataOptInAt(updated.data_improvement_opt_in_at ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingOptIn(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Organisation Settings</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Manage your CallGuard AI plan and organisation details
        </p>
      </div>

      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <h3 className="text-table-cell uppercase tracking-wider text-text-muted font-semibold mb-2">
          Organisation
        </h3>
        <p className="text-table-cell text-text-primary font-semibold">{user?.organization_name}</p>
      </div>

      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <h3 className="text-table-cell uppercase tracking-wider text-text-muted font-semibold mb-1">
          Industry / advice domain
        </h3>
        <p className="text-xs text-text-subtle mb-3">
          Describe what this organisation does (e.g. “FCA-regulated protection insurance advice”). The
          AI uses this to score calls in the right regulatory and commercial context.
        </p>
        {industry === undefined ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={industryDraft}
              onChange={(e) => setIndustryDraft(e.target.value)}
              disabled={!isAdmin || savingIndustry}
              maxLength={200}
              placeholder="e.g. FCA-regulated protection insurance advice"
              className="flex-1 min-w-[260px] px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none disabled:opacity-60"
            />
            {isAdmin && (
              <button
                onClick={handleIndustrySave}
                disabled={savingIndustry || industryDraft.trim() === (industry ?? '').trim()}
                className="px-3 py-2 rounded-btn text-table-cell border border-primary bg-primary text-white font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {savingIndustry ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        )}
        {!isAdmin && (
          <p className="text-[11px] text-text-muted mt-2">Ask your admin to change this.</p>
        )}
      </div>

      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <h3 className="text-table-cell uppercase tracking-wider text-text-muted font-semibold mb-1">
          Transcription vocabulary
        </h3>
        <p className="text-xs text-text-subtle mb-3">
          Terms specific to your business — product names, industry jargon, provider names — that
          transcription should recognise accurately. One term per line, up to 60 terms. Your
          organisation and agent names are included automatically.
        </p>
        {keyterms === undefined ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : (
          <div>
            <textarea
              value={keytermsDraft}
              onChange={(e) => setKeytermsDraft(e.target.value)}
              disabled={!isAdmin || savingKeyterms}
              rows={6}
              aria-label="Transcription vocabulary, one term per line"
              placeholder={'e.g.\nlife cover\ncritical illness\nsum assured'}
              className="w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none disabled:opacity-60 resize-y"
            />
            {isAdmin && (
              <div className="mt-2 flex justify-end">
                <button
                  onClick={handleKeytermsSave}
                  disabled={savingKeyterms || keytermsDraft.trim() === (keyterms ?? '').trim()}
                  className="px-3 py-2 rounded-btn text-table-cell border border-primary bg-primary text-white font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
                >
                  {savingKeyterms ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </div>
        )}
        {!isAdmin && (
          <p className="text-[11px] text-text-muted mt-2">Ask your admin to change this.</p>
        )}
      </div>

      {isAdmin && seats && (
        <div className="bg-card border border-border rounded-card p-5 mb-5">
          <h3 className="text-table-cell uppercase tracking-wider text-text-muted font-semibold mb-1">
            Active seats
          </h3>
          <p className="text-xs text-text-subtle mb-3">
            Advisers with at least one scored call in the month. This is the basis for per-seat billing.
          </p>
          <div className="flex gap-8">
            <div>
              <div className="text-card-value text-text-primary leading-none">{seats.current_active_seats}</div>
              <div className="text-[11px] text-text-muted mt-1">This month ({seats.current_month})</div>
            </div>
            <div>
              <div className="text-card-value text-text-muted leading-none">{seats.previous_active_seats}</div>
              <div className="text-[11px] text-text-muted mt-1">Last month ({seats.previous_month})</div>
            </div>
          </div>
          {seats.current_advisers.length > 0 && (
            <div className="mt-4 border-t border-border-light pt-3">
              <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold mb-2">
                Active this month
              </div>
              <ul className="space-y-1">
                {seats.current_advisers.map((a) => (
                  <li key={a.id} className="flex justify-between text-table-cell">
                    <span className="text-text-secondary">{a.name}</span>
                    <span className="text-text-muted">{a.scored_calls} scored</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-table-cell uppercase tracking-wider text-text-muted font-semibold mb-1">
              Help improve CallGuard
            </h3>
            <p className="text-xs text-text-subtle max-w-xl">
              Off by default. When on, you allow CallGuard to use{' '}
              <strong>irreversibly anonymised</strong> data derived from your calls to improve our
              scoring and calibration models. Your raw audio, transcripts and identifiable data are{' '}
              <strong>never</strong> used, special-category data is excluded, and you can switch this
              off at any time. See{' '}
              <a
                href="https://callguardai.co.uk/dpa#instructions"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                DPA §4.2
              </a>
              .
            </p>
            {dataOptIn && dataOptInAt && (
              <p className="text-[11px] text-text-muted mt-2">
                Opted in on {new Date(dataOptInAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
              </p>
            )}
          </div>
          <button
            role="switch"
            aria-checked={!!dataOptIn}
            aria-label="Allow anonymised data to improve CallGuard"
            disabled={!isAdmin || savingOptIn || dataOptIn === undefined}
            onClick={() => isAdmin && handleOptInChange(!dataOptIn)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              dataOptIn ? 'bg-primary' : 'bg-border'
            } ${!isAdmin ? 'cursor-default' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-card shadow transition-transform ${
                dataOptIn ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
        {!isAdmin && (
          <p className="text-[11px] text-text-muted mt-2">Ask your admin to change this.</p>
        )}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-section-title text-text-primary">Plan</h3>
        {currentPlan && (
          <span className="text-xs text-text-muted">
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
          return (
            <div
              key={p}
              className={`bg-card rounded-card p-5 border transition-all ${
                isCurrent ? 'border-primary ring-2 ring-primary/20' : 'border-border'
              }`}
            >
              {isCurrent && (
                <div className="inline-block text-[10px] font-semibold uppercase tracking-wider text-pass bg-primary-light px-2 py-0.5 rounded mb-2">
                  Current plan
                </div>
              )}
              <h4 className="text-lg font-bold text-text-primary">{PLAN_LABELS[p]}</h4>
              <p className="text-table-cell text-text-subtle mt-1">{PLAN_DESCRIPTIONS[p]}</p>
              <ul className="mt-4 space-y-1.5 text-xs text-text-cell">
                {PLAN_FEATURE_MATRIX.map(({ label, has }) => {
                  const included = has(p);
                  return (
                    <li
                      key={label}
                      className={`flex items-center gap-1.5 ${included ? '' : 'text-text-muted line-through'}`}
                    >
                      {included ? <Check /> : <Cross />} {label}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-text-muted mt-4 text-center">
        To change your organisation's plan, contact CallGuard support.
      </p>
    </div>
  );
}

// What each tier includes, in ladder order (base capabilities first, then the
// Professional and Enterprise adds). Flag-gated rows read the real gates in
// shared FEATURES via hasFeature, so the cards can never drift from what the
// product actually enforces; always-included capabilities have no flag.
const PLAN_FEATURE_MATRIX: Array<{ label: string; has: (p: Plan) => boolean }> = [
  { label: 'AI scoring & breach register', has: () => true },
  { label: 'Multi-call sale scoring', has: () => true },
  { label: 'AI coaching', has: (p) => hasFeature(p, 'coaching') },
  { label: 'AI insights & trends', has: (p) => hasFeature(p, 'insights') },
  { label: 'Customer tracking', has: (p) => hasFeature(p, 'customer_journey') },
  { label: 'AI learning (corrections & exemplars)', has: (p) => hasFeature(p, 'ai_learning') },
  { label: 'CRM & dialler integrations', has: () => true },
  { label: 'Compliance document pack', has: () => true },
  { label: 'SFTP ingestion', has: () => true },
  { label: 'Live call streaming', has: (p) => hasFeature(p, 'live_streaming') },
  { label: 'Live coaching', has: (p) => hasFeature(p, 'live_coaching') },
  { label: 'Dedicated support', has: (p) => hasFeature(p, 'dedicated_support') },
  { label: 'White-label branding', has: (p) => hasFeature(p, 'white_label') },
];

function Check() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 text-primary flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
