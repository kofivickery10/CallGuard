import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { ScoreGauge } from '../components/ScoreGauge';
import { CoachingPanel } from '../components/CoachingPanel';
import { ItemResultBadge } from '../components/ItemResultBadge';
import { SeverityBadge } from '../components/BreachBadges';
import { formatPhone } from '../lib/format';
import type { JourneyWithDetail, ItemResult } from '@callguard/shared';

const RESULT_ORDER: Record<ItemResult, number> = { fail: 0, manual_review: 1, pass: 2, na: 3 };

export function JourneyDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { notify } = useDialog();
  const canAction = user?.role === 'admin' || user?.role === 'supervisor';
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const { data: journey, isLoading, isError } = useQuery({
    queryKey: ['journey', id],
    queryFn: () => api.get<JourneyWithDetail>(`/journeys/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'pending' || s === 'scoring' ? 4000 : false;
    },
  });

  const resolve = async (itemScoreId: string, result: 'pass' | 'fail') => {
    setResolvingId(itemScoreId);
    try {
      await api.post('/review-items/resolve', { kind: 'journey', item_score_id: itemScoreId, result });
      queryClient.invalidateQueries({ queryKey: ['journey', id] });
      queryClient.invalidateQueries({ queryKey: ['review-items'] });
    } catch (err) {
      await notify('Failed to resolve: ' + (err instanceof Error ? err.message : 'unknown error'));
    } finally {
      setResolvingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mr-3" />
        Loading…
      </div>
    );
  }

  if (isError || !journey) {
    return (
      <div className="bg-card border border-border rounded-card p-10 text-center">
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block">
          Could not load this journey — it may have been removed.
        </div>
        <div className="mt-4">
          <Link
            to="/journeys"
            className="text-primary text-table-cell font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Back to Journeys
          </Link>
        </div>
      </div>
    );
  }

  const items = [...journey.item_scores].sort(
    (a, b) => (RESULT_ORDER[a.result] - RESULT_ORDER[b.result])
  );
  const failed = journey.item_scores.filter((i) => i.result === 'fail');
  const pendingReview = journey.item_scores.filter((i) => i.result === 'manual_review');
  const customerLabel =
    journey.customer_name ?? (journey.customer_phone ? formatPhone(journey.customer_phone) : null);

  return (
    <div>
      <Link
        to="/journeys"
        className="inline-flex items-center gap-1.5 text-table-cell text-text-muted hover:text-text-primary mb-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Journeys
      </Link>

      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-page-title text-text-primary">
            Journey
            {customerLabel && (
              <>
                {' — '}
                <Link
                  to={`/customers/${journey.customer_id}`}
                  className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {customerLabel}
                </Link>
              </>
            )}
          </h2>
          <div className="flex items-center gap-4 mt-1.5 text-table-cell text-text-subtle">
            <span className="capitalize">{journey.status}</span>
            {journey.customer_name && journey.customer_phone && (
              <span>{formatPhone(journey.customer_phone)}</span>
            )}
            {journey.branch && (
              <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-table-header text-text-secondary">
                Branch: {journey.branch}
              </span>
            )}
            <span>Trigger: {journey.trigger_source.replace('_', ' ')}</span>
            {journey.scored_at && <span>Scored {new Date(journey.scored_at).toLocaleString('en-GB')}</span>}
          </div>
        </div>
        {journey.overall_score != null && (
          <div className="flex items-center gap-3">
            <span
              className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${
                journey.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
              }`}
            >
              {journey.pass ? 'Pass' : 'Fail'}
            </span>
            <ScoreGauge score={Number(journey.overall_score)} size="lg" />
          </div>
        )}
      </div>

      {journey.status === 'failed' && journey.error_message && (
        <div className="bg-fail-bg border-l-[3px] border-l-fail rounded-card p-4 mb-6">
          <div className="text-table-cell font-semibold text-fail">Scoring failed</div>
          <div className="text-xs text-fail mt-1">{journey.error_message}</div>
        </div>
      )}

      {(journey.status === 'pending' || journey.status === 'scoring') && (
        <div className="bg-card border border-border rounded-card p-10 text-center mb-6">
          <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <div className="text-base font-semibold text-text-primary">
            {journey.status === 'pending' ? 'Queued for scoring' : 'Scoring the journey'}
          </div>
        </div>
      )}

      {journey.status === 'scored' && (
        <div className="mb-4">
          <CoachingPanel
            coaching={journey.coaching}
            plan={user?.organization_plan ?? null}
            callStatus="scored"
            isAdmin={user?.role === 'admin'}
            subject="journey"
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Checkpoints */}
        <div className="lg:col-span-2 bg-card border border-border rounded-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h3 className="text-section-title text-text-primary">Checkpoints ({journey.item_scores.length})</h3>
            <div className="text-xs text-text-muted">
              {failed.length} failed · {pendingReview.length} to review
            </div>
          </div>
          <div>
            {journey.item_scores.length === 0 && (
              <div className="px-5 py-12 text-center text-text-muted text-table-cell">
                {journey.status === 'pending' || journey.status === 'scoring'
                  ? 'Checkpoints appear once scoring completes.'
                  : 'No checkpoints on this scorecard.'}
              </div>
            )}
            {items.map((item) => (
              <div key={item.id} className="border-b border-border-light last:border-0 px-5 py-[11px]">
                <div className="flex justify-between items-start gap-4">
                  <div className="min-w-0 flex-1">
                    {item.section && (
                      <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-0.5">
                        {item.section}
                      </div>
                    )}
                    <div className="text-table-cell text-text-secondary">{item.label}</div>
                    {item.evidence && (
                      <blockquote className="text-xs text-text-muted italic border-l-2 border-border pl-2.5 mt-1.5 leading-relaxed">
                        {item.evidence}
                        {item.source_call_id && (
                          <Link to={`/calls/${item.source_call_id}`} className="not-italic ml-2 text-primary hover:underline">
                            source call →
                          </Link>
                        )}
                      </blockquote>
                    )}
                    {item.reasoning && (
                      <p className="text-xs text-text-muted mt-1.5 leading-relaxed">{item.reasoning}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <ItemResultBadge result={item.result} />
                    {item.result === 'manual_review' && canAction && (
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => resolve(item.id, 'pass')}
                          disabled={resolvingId === item.id}
                          className="text-badge text-pass hover:text-white hover:bg-pass px-2 py-1 rounded-btn border border-pass/30 hover:border-pass transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          Pass
                        </button>
                        <button
                          onClick={() => resolve(item.id, 'fail')}
                          disabled={resolvingId === item.id}
                          className="text-badge text-fail hover:text-white hover:bg-fail px-2 py-1 rounded-btn border border-fail/30 hover:border-fail transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          Fail
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar: composing calls + breaches */}
        <div className="space-y-4">
          <div className="bg-card border border-border rounded-card overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-section-title text-text-primary">Calls in this journey ({journey.calls.length})</h3>
            </div>
            <div>
              {journey.calls.length === 0 && (
                <div className="px-5 py-4 text-table-cell text-text-muted">No calls linked.</div>
              )}
              {journey.calls.map((c) => (
                <Link
                  key={c.id}
                  to={`/calls/${c.id}`}
                  className="flex items-center justify-between px-5 py-3 border-b border-border-light last:border-0 hover:bg-table-header transition-colors"
                >
                  <div>
                    <div className="text-table-cell text-text-primary">
                      {c.call_date ? new Date(c.call_date).toLocaleDateString('en-GB') : 'Undated'}
                    </div>
                    <div className="text-xs text-text-muted">{c.agent_name || 'Unknown agent'}</div>
                  </div>
                  {c.role === 'wrap_up' && (
                    <span className="text-[10px] uppercase tracking-wider text-pass font-semibold">Wrap-up</span>
                  )}
                </Link>
              ))}
            </div>
          </div>

          <div className="bg-card border border-border rounded-card overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-section-title text-text-primary">Breaches ({failed.length})</h3>
            </div>
            {failed.length === 0 ? (
              <p className="px-5 py-6 text-center text-text-muted text-table-cell">No failed checkpoints</p>
            ) : (
              <div>
                {failed.map((item) => (
                  <div key={item.id} className="px-5 py-3 border-b border-border-light last:border-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-table-cell text-text-secondary">{item.label}</span>
                      {item.severity && <SeverityBadge severity={item.severity} />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
