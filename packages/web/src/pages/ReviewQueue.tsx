import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { SeverityBadge, StatusBadge } from '../components/BreachBadges';
import { BreachDetailDrawer } from '../components/BreachDetailDrawer';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import type { BreachStatus, BreachWithDetail, ManualReviewItem } from '@callguard/shared';

type QueueItem = BreachWithDetail & { risk_score: number };

export function ReviewQueue() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { notify } = useDialog();
  const canAction = user?.role === 'admin' || user?.role === 'supervisor';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['review-queue'],
    queryFn: () =>
      api.get<{ data: QueueItem[] }>('/breaches/review-queue?limit=50'),
  });

  const { data: manualData } = useQuery({
    queryKey: ['review-items'],
    queryFn: () => api.get<{ data: ManualReviewItem[] }>('/review-items'),
  });
  const manualItems = manualData?.data ?? [];

  const resolveManual = async (item: ManualReviewItem, result: 'pass' | 'fail') => {
    const key = item.item_score_id;
    setResolvingKey(key);
    try {
      await api.post('/review-items/resolve', {
        kind: item.kind,
        item_score_id: item.item_score_id,
        result,
      });
      queryClient.invalidateQueries({ queryKey: ['review-items'] });
      queryClient.invalidateQueries({ queryKey: ['breaches'] });
      queryClient.invalidateQueries({ queryKey: ['breach-summary'] });
    } catch (err) {
      await notify('Failed to resolve: ' + (err instanceof Error ? err.message : 'unknown error'));
    } finally {
      setResolvingKey(null);
    }
  };

  const updateStatus = async (breachId: string, status: BreachStatus) => {
    try {
      setBusyId(breachId);
      await api.post(`/breaches/${breachId}/status`, { status });
      queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      queryClient.invalidateQueries({ queryKey: ['breaches'] });
      queryClient.invalidateQueries({ queryKey: ['breach-summary'] });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Review Queue</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            The breaches your compliance team should look at next, ranked by severity, status and age.
          </p>
        </div>
      </div>

      {/* Manual-review checkpoints: manual items + consent gates that couldn't
          be auto-scored. These sit outside the breach workflow until a human
          marks them, and are excluded from the score meanwhile. */}
      {manualItems.length > 0 && (
        <div className="bg-card border border-border rounded-card overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-section-title text-text-primary">Awaiting human review ({manualItems.length})</h3>
              <p className="text-xs text-text-muted mt-0.5">Manual checkpoints and consent gates that need a reviewer to mark pass or fail.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>
                  {['Checkpoint', 'Where', 'Customer', 'Severity', ''].map((h) => (
                    <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {manualItems.map((item) => (
                  <tr key={`${item.kind}-${item.item_score_id}`} className="border-b border-border-light last:border-0 hover:bg-table-header transition-colors">
                    <td className="px-5 py-3 text-table-cell text-text-primary">
                      {item.section && <span className="text-text-muted">{item.section}: </span>}
                      {item.label}
                    </td>
                    <td className="px-5 py-3 text-table-cell">
                      <Link
                        to={item.kind === 'journey' ? `/journeys/${item.parent_id}` : `/calls/${item.parent_id}`}
                        className="text-primary hover:underline capitalize"
                      >
                        {item.kind}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-table-cell text-text-cell">{item.customer_name || '—'}</td>
                    <td className="px-5 py-3">{item.severity && <SeverityBadge severity={item.severity} />}</td>
                    <td className="px-5 py-3 text-right">
                      {canAction && (
                        <div className="inline-flex gap-1.5">
                          <button
                            onClick={() => resolveManual(item, 'pass')}
                            disabled={resolvingKey === item.item_score_id}
                            className="text-xs text-pass hover:text-white hover:bg-pass px-2 py-1 rounded border border-pass/30 hover:border-pass transition-colors disabled:opacity-50"
                          >
                            Pass
                          </button>
                          <button
                            onClick={() => resolveManual(item, 'fail')}
                            disabled={resolvingKey === item.item_score_id}
                            className="text-xs text-fail hover:text-white hover:bg-fail px-2 py-1 rounded border border-fail/30 hover:border-fail transition-colors disabled:opacity-50"
                          >
                            Fail
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-card overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border w-[80px]">Rank</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Severity</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">What was breached</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Call</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Agent</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Status</th>
              <th className="text-right px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={`s-${i}`} className="border-b border-border-light last:border-0">
                  {Array.from({ length: 7 }).map((__, j) => (
                    <td key={j} className="px-5 py-3.5">
                      <div
                        className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                        style={{
                          backgroundImage: 'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                          width: j === 2 ? '70%' : '40%',
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            )}

            {!isLoading && data?.data.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-text-muted text-table-cell">
                  Nothing flagged for review. All breaches are coached, resolved, or noted.
                </td>
              </tr>
            )}

            {data?.data.map((b, i) => (
              <tr
                key={b.id}
                className="hover:bg-table-header transition-colors border-b border-border-light last:border-0"
              >
                <td className="px-5 py-3.5">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary-light text-pass text-table-cell font-bold tabular-nums">
                    {i + 1}
                  </span>
                </td>
                <td className="px-5 py-3.5">
                  <SeverityBadge severity={b.severity} />
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-primary">
                  <button
                    onClick={() => setSelectedId(b.id)}
                    className="text-left font-semibold text-text-primary hover:text-primary"
                  >
                    {b.breach_type}
                  </button>
                  {b.evidence && (
                    <div className="text-xs text-text-muted mt-1 line-clamp-1 max-w-[480px]">
                      "{b.evidence}"
                    </div>
                  )}
                </td>
                <td className="px-5 py-3.5">
                  <Link
                    to={b.journey_id ? `/journeys/${b.journey_id}` : `/calls/${b.call_id}`}
                    className="text-primary text-table-cell hover:underline"
                  >
                    {b.call_file_name}
                  </Link>
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-cell">
                  {b.agent_name || '--'}
                </td>
                <td className="px-5 py-3.5">
                  <StatusBadge status={b.status} />
                </td>
                <td className="px-5 py-3.5 text-right">
                  <div className="inline-flex gap-1.5">
                    {b.status !== 'acknowledged' && (
                      <button
                        onClick={() => updateStatus(b.id, 'acknowledged')}
                        disabled={busyId === b.id}
                        className="text-xs text-text-secondary hover:text-primary px-2 py-1 rounded border border-border hover:border-primary transition-colors disabled:opacity-50"
                      >
                        Acknowledge
                      </button>
                    )}
                    {b.status !== 'escalated' && (
                      <button
                        onClick={() => updateStatus(b.id, 'escalated')}
                        disabled={busyId === b.id}
                        className="text-xs text-fail hover:text-fail-bg hover:bg-fail px-2 py-1 rounded border border-fail/30 hover:border-fail transition-colors disabled:opacity-50"
                      >
                        Escalate
                      </button>
                    )}
                    <button
                      onClick={() => updateStatus(b.id, 'coached')}
                      disabled={busyId === b.id}
                      className="text-xs text-pass hover:text-white hover:bg-pass px-2 py-1 rounded border border-pass/30 hover:border-pass transition-colors disabled:opacity-50"
                    >
                      Coached
                    </button>
                    <button
                      onClick={() => updateStatus(b.id, 'resolved')}
                      disabled={busyId === b.id}
                      className="text-xs text-pass hover:text-white hover:bg-pass px-2 py-1 rounded border border-pass/30 hover:border-pass transition-colors disabled:opacity-50"
                    >
                      Resolve
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedId && (
        <BreachDetailDrawer breachId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
