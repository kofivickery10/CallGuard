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
  type ScoringScope,
  type TranscriptionMode,
} from '@callguard/shared';

interface ScoringSettingsForm {
  scoring_scope: ScoringScope;
  min_scoreable_seconds: number;
  min_scoreable_words: number;
  pass_threshold: number;
  retention_days: number;
  transcription_mode: TranscriptionMode;
  deepgram_region: 'eu' | 'us';
}

const SCOPE_OPTIONS: { value: ScoringScope; label: string; hint: string }[] = [
  { value: 'sales_only', label: 'Sales only', hint: 'Score journeys once a sale is confirmed (via the Zoho sale trigger). Every call is still transcribed.' },
  { value: 'over_threshold', label: 'Over length threshold', hint: 'Score every call once it clears the length threshold below.' },
  { value: 'everything', label: 'Everything', hint: 'Score every transcribed call, regardless of length.' },
];

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

  // Adviser stereo-channel mapping (undefined = loading)
  const [adviserChannel, setAdviserChannel] = useState<number | null | undefined>(undefined);
  const [savingChannel, setSavingChannel] = useState(false);

  // Data-improvement opt-in (DPA §4.2). undefined = loading.
  const [dataOptIn, setDataOptIn] = useState<boolean | undefined>(undefined);
  const [dataOptInAt, setDataOptInAt] = useState<string | null>(null);
  const [savingOptIn, setSavingOptIn] = useState(false);

  // Industry / advice domain (frames AI scoring). undefined = loading.
  const [industry, setIndustry] = useState<string | undefined>(undefined);
  const [industryDraft, setIndustryDraft] = useState('');
  const [savingIndustry, setSavingIndustry] = useState(false);

  // Active-seat usage (admin only)
  const [seats, setSeats] = useState<ActiveSeats | null>(null);

  // Scoring/ingestion policy (spec §10). undefined = loading.
  const [scoring, setScoring] = useState<ScoringSettingsForm | undefined>(undefined);
  const [scoringDraft, setScoringDraft] = useState<ScoringSettingsForm | undefined>(undefined);
  const [savingScoring, setSavingScoring] = useState(false);

  useEffect(() => {
    api
      .get<OrganizationInfo>('/organization')
      .then((org) => {
        setAdviserChannel(org.adviser_channel ?? null);
        setDataOptIn(org.data_improvement_opt_in ?? false);
        setDataOptInAt(org.data_improvement_opt_in_at ?? null);
        setIndustry(org.industry ?? '');
        setIndustryDraft(org.industry ?? '');
        const s: ScoringSettingsForm = {
          scoring_scope: org.scoring_scope ?? 'sales_only',
          min_scoreable_seconds: org.min_scoreable_seconds ?? 15,
          min_scoreable_words: org.min_scoreable_words ?? 30,
          pass_threshold: org.pass_threshold ?? 70,
          retention_days: org.retention_days ?? 1825,
          transcription_mode: org.transcription_mode ?? 'mono_diarize',
          deepgram_region: org.deepgram_region ?? 'eu',
        };
        setScoring(s);
        setScoringDraft(s);
      })
      .catch(() => {
        setAdviserChannel(null);
        setDataOptIn(false);
        setIndustry('');
      });
  }, []);

  const handleScoringSave = async () => {
    if (!scoringDraft) return;
    setSavingScoring(true);
    setError('');
    try {
      const updated = await api.put<OrganizationInfo>('/organization/scoring-settings', scoringDraft);
      const s: ScoringSettingsForm = {
        scoring_scope: updated.scoring_scope ?? scoringDraft.scoring_scope,
        min_scoreable_seconds: updated.min_scoreable_seconds ?? scoringDraft.min_scoreable_seconds,
        min_scoreable_words: updated.min_scoreable_words ?? scoringDraft.min_scoreable_words,
        pass_threshold: updated.pass_threshold ?? scoringDraft.pass_threshold,
        retention_days: updated.retention_days ?? scoringDraft.retention_days,
        transcription_mode: updated.transcription_mode ?? scoringDraft.transcription_mode,
        deepgram_region: updated.deepgram_region ?? scoringDraft.deepgram_region,
      };
      setScoring(s);
      setScoringDraft(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingScoring(false);
    }
  };

  const scoringDirty = !!(scoring && scoringDraft) && JSON.stringify(scoring) !== JSON.stringify(scoringDraft);

  useEffect(() => {
    if (!isAdmin) return;
    api.get<ActiveSeats>('/organization/active-seats').then(setSeats).catch(() => setSeats(null));
  }, [isAdmin]);

  const handleChannelChange = async (value: number | null) => {
    setSavingChannel(true);
    setError('');
    try {
      const updated = await api.put<OrganizationInfo>('/organization/adviser-channel', {
        adviser_channel: value,
      });
      setAdviserChannel(updated.adviser_channel ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingChannel(false);
    }
  };

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
        <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-2">
          Organisation
        </h3>
        <p className="text-table-cell text-text-primary font-semibold">{user?.organization_name}</p>
      </div>

      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-1">
          Industry / advice domain
        </h3>
        <p className="text-[12px] text-text-subtle mb-3">
          Describe what this organisation does (e.g. “FCA-regulated protection insurance advice”). The
          AI uses this to score calls in the right regulatory and commercial context.
        </p>
        {industry === undefined ? (
          <p className="text-[12px] text-text-muted">Loading…</p>
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

      {isAdmin && seats && (
        <div className="bg-card border border-border rounded-card p-5 mb-5">
          <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-1">
            Active seats
          </h3>
          <p className="text-[12px] text-text-subtle mb-3">
            Advisers with at least one scored call in the month. This is the basis for per-seat billing.
          </p>
          <div className="flex gap-8">
            <div>
              <div className="text-[28px] font-bold text-text-primary leading-none">{seats.current_active_seats}</div>
              <div className="text-[11px] text-text-muted mt-1">This month ({seats.current_month})</div>
            </div>
            <div>
              <div className="text-[28px] font-bold text-text-muted leading-none">{seats.previous_active_seats}</div>
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
        <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-1">
          Call recording
        </h3>
        <p className="text-[12px] text-text-subtle mb-3">
          Which stereo channel is the adviser recorded on? Most diallers record the adviser and
          customer on separate channels. If unsure, play a recording and check the balance (left vs
          right).
        </p>
        {adviserChannel === undefined ? (
          <p className="text-[12px] text-text-muted">Loading…</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {[
              { value: null as number | null, label: 'Auto-detect' },
              { value: 0 as number | null, label: 'Left channel' },
              { value: 1 as number | null, label: 'Right channel' },
            ].map((opt) => {
              const active = adviserChannel === opt.value;
              return (
                <button
                  key={String(opt.value)}
                  onClick={() => isAdmin && handleChannelChange(opt.value)}
                  disabled={!isAdmin || savingChannel}
                  className={`px-3 py-2 rounded-btn text-table-cell border transition-colors disabled:opacity-60 ${
                    active
                      ? 'border-primary bg-primary-light text-pass font-semibold'
                      : 'border-border text-text-secondary hover:border-primary/50'
                  } ${!isAdmin ? 'cursor-default' : ''}`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
        {!isAdmin && (
          <p className="text-[11px] text-text-muted mt-2">Ask your admin to change this.</p>
        )}
      </div>

      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-1">
          Scoring policy
        </h3>
        <p className="text-[12px] text-text-subtle mb-3">
          Which calls get the expensive scoring pass, the length below which a call is skipped as
          too short to evaluate, the pass mark, and how long call data is retained before it's
          deleted.
        </p>
        {!scoringDraft ? (
          <p className="text-[12px] text-text-muted">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-[11px] text-text-muted uppercase tracking-wider mb-1.5">Scoring scope</label>
              <div className="flex flex-wrap gap-2">
                {SCOPE_OPTIONS.map((opt) => {
                  const active = scoringDraft.scoring_scope === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      title={opt.hint}
                      disabled={!isAdmin}
                      onClick={() => isAdmin && setScoringDraft({ ...scoringDraft, scoring_scope: opt.value })}
                      className={`px-3 py-2 rounded-btn text-table-cell border transition-colors disabled:opacity-60 ${
                        active
                          ? 'border-primary bg-primary-light text-pass font-semibold'
                          : 'border-border text-text-secondary hover:border-primary/50'
                      } ${!isAdmin ? 'cursor-default' : ''}`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-text-muted mt-1.5">
                {SCOPE_OPTIONS.find((o) => o.value === scoringDraft.scoring_scope)?.hint}
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <NumberField
                label="Skip under (seconds)"
                value={scoringDraft.min_scoreable_seconds}
                disabled={!isAdmin}
                onChange={(v) => setScoringDraft({ ...scoringDraft, min_scoreable_seconds: v })}
              />
              <NumberField
                label="Skip under (words)"
                value={scoringDraft.min_scoreable_words}
                disabled={!isAdmin}
                onChange={(v) => setScoringDraft({ ...scoringDraft, min_scoreable_words: v })}
              />
              <NumberField
                label="Pass threshold (%)"
                value={scoringDraft.pass_threshold}
                disabled={!isAdmin}
                min={0}
                max={100}
                onChange={(v) => setScoringDraft({ ...scoringDraft, pass_threshold: v })}
              />
              <NumberField
                label="Retention (days)"
                value={scoringDraft.retention_days}
                min={30}
                disabled={!isAdmin}
                onChange={(v) => setScoringDraft({ ...scoringDraft, retention_days: v })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-text-muted uppercase tracking-wider mb-1.5">
                  Transcription mode
                </label>
                <select
                  value={scoringDraft.transcription_mode}
                  disabled={!isAdmin}
                  onChange={(e) =>
                    setScoringDraft({ ...scoringDraft, transcription_mode: e.target.value as TranscriptionMode })
                  }
                  className="w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary disabled:opacity-60 focus:border-primary focus:outline-none"
                >
                  <option value="mono_diarize">Mono (diarise speakers)</option>
                  <option value="stereo_multichannel">Split-stereo (separate channels)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-text-muted uppercase tracking-wider mb-1.5">
                  Deepgram region
                </label>
                <select
                  value={scoringDraft.deepgram_region}
                  disabled={!isAdmin}
                  onChange={(e) => setScoringDraft({ ...scoringDraft, deepgram_region: e.target.value as 'eu' | 'us' })}
                  className="w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary disabled:opacity-60 focus:border-primary focus:outline-none"
                >
                  <option value="eu">EU (UK/EU data residency)</option>
                  <option value="us">US</option>
                </select>
              </div>
            </div>

            {isAdmin && (
              <div className="flex justify-end">
                <button
                  onClick={handleScoringSave}
                  disabled={savingScoring || !scoringDirty}
                  className="px-[18px] py-[9px] rounded-btn text-table-cell border border-primary bg-primary text-white font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
                >
                  {savingScoring ? 'Saving…' : 'Save scoring policy'}
                </button>
              </div>
            )}
          </div>
        )}
        {!isAdmin && (
          <p className="text-[11px] text-text-muted mt-2">Ask your admin to change this.</p>
        )}
      </div>

      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-1">
              Help improve CallGuard
            </h3>
            <p className="text-[12px] text-text-subtle max-w-xl">
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
              <h4 className="text-[18px] font-bold text-text-primary">{PLAN_LABELS[p]}</h4>
              <p className="text-table-cell text-text-subtle mt-1">{PLAN_DESCRIPTIONS[p]}</p>
              <ul className="mt-4 space-y-1.5 text-[12px] text-text-cell">
                <li className="flex items-center gap-1.5">
                  <Check /> Scoring & breach register
                </li>
                <li className={`flex items-center gap-1.5 ${hasFeature(p, 'coaching') ? '' : 'text-text-muted line-through'}`}>
                  {hasFeature(p, 'coaching') ? <Check /> : <Cross />} AI coaching per call
                </li>
                <li className={`flex items-center gap-1.5 ${p === 'enterprise' ? '' : 'text-text-muted line-through'}`}>
                  {p === 'enterprise' ? <Check /> : <Cross />} Dedicated support & white-label
                </li>
              </ul>
            </div>
          );
        })}
      </div>

      <p className="text-[12px] text-text-muted mt-4 text-center">
        To change your organisation's plan, contact CallGuard support.
      </p>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  min = 0,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <label className="block text-[11px] text-text-muted uppercase tracking-wider mb-1.5">{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        onBlur={(e) => {
          // Snap back into range on blur so a cleared/0 retention field can't be
          // saved below its floor — the purge job treats retention_days=0 as
          // "delete everything older than now", so an accidental clear is
          // catastrophic. Server enforces the same floor; this is the guard rail.
          const n = Number(e.target.value) || 0;
          const clamped = Math.min(max ?? Infinity, Math.max(min ?? 0, n));
          if (clamped !== value) onChange(clamped);
        }}
        className="w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary disabled:opacity-60 focus:border-primary focus:outline-none"
      />
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
