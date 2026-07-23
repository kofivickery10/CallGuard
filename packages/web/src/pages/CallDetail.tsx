import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { CallStatusBadge } from '../components/CallStatusBadge';
import { ScoreGauge } from '../components/ScoreGauge';
import { TranscriptViewer } from '../components/TranscriptViewer';
import { ScorecardResultCard } from '../components/ScorecardResultCard';
import { AssignAgentDropdown } from '../components/AssignAgentDropdown';
import { ShareLinksPanel } from '../components/ShareLinksPanel';
import { CoachingPanel } from '../components/CoachingPanel';
import { ScoreCorrectionModal } from '../components/ScoreCorrectionModal';
import { useDialog } from '../components/DialogProvider';
import { ItemResultBadge } from '../components/ItemResultBadge';
import { formatDuration } from '../lib/format';
import { hasFeature, isItemPass } from '@callguard/shared';
import type { Call, CallScore, CallItemScore, CallCoaching } from '@callguard/shared';

type ScoreWithItems = CallScore & {
  coaching: CallCoaching | null;
  item_scores: (CallItemScore & { label: string; item_description: string; score_type: string })[];
};

// Journey context attached to a call that belongs to a scored sale journey
// (per-call scoring doesn't run for these — the score lives on the journey).
type JourneyContext = {
  id: string;
  status: string;
  branch: string | null;
  overall_score: string | null;
  pass: boolean | null;
  this_call_items: Array<{
    result: 'pass' | 'fail' | 'na' | 'manual_review';
    normalized_score: string | null;
    evidence: string | null;
    label: string;
  }>;
};
type CallWithJourney = Call & { journey?: JourneyContext | null };

export function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const scoreOnly = useScoreOnly();
  const queryClient = useQueryClient();
  const { confirm, notify } = useDialog();
  const isAdmin = user?.role === 'admin';
  const canAction = user?.role === 'admin' || user?.role === 'supervisor';
  const canLearn = user ? hasFeature(user.organization_plan, 'ai_learning') : false;
  const [correctingItem, setCorrectingItem] = useState<{
    itemScoreId: string;
    label: string;
    pass: boolean;
    evidence: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleToggleReviewed = async () => {
    if (!call) return;
    await api.post(`/calls/${call.id}/review`, { reviewed: !call.reviewed_at });
    queryClient.invalidateQueries({ queryKey: ['call', call.id] });
  };

  const handleToggleExemplar = async () => {
    if (!call) return;
    await api.post(`/calls/${call.id}/exemplar`, {
      is_exemplar: !call.is_exemplar,
      reason: !call.is_exemplar ? 'Marked by admin' : undefined,
    });
    queryClient.invalidateQueries({ queryKey: ['call', call.id] });
  };

  const handleDelete = async () => {
    if (!call) return;
    const ok = await confirm(
      `Delete this call permanently?\n\n"${call.file_name}"\n\nThis removes the audio, transcript, scores, breaches, and any corrections. This cannot be undone.`,
      { danger: true, confirmLabel: 'Delete' }
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/calls/${call.id}`);
      queryClient.invalidateQueries({ queryKey: ['calls'] });
      navigate('/calls');
    } catch (err) {
      setDeleting(false);
      await notify('Failed to delete call: ' + (err instanceof Error ? err.message : 'unknown error'));
    }
  };

  const { data: call, isLoading: callLoading, isError: callError } = useQuery({
    queryKey: ['call', id],
    queryFn: () => api.get<CallWithJourney>(`/calls/${id}`),
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data?.status;
      // Terminal states: stop polling. 'skipped' is terminal too. A journey
      // call rests at 'transcribed' (scored on the journey, never per-call), so
      // that's terminal here as well — otherwise it would poll forever.
      if (status === 'scored' || status === 'failed' || status === 'skipped') return false;
      if (status === 'transcribed' && data?.journey) return false;
      return 3000;
    },
  });

  const { data: scoresData } = useQuery({
    queryKey: ['call-scores', id],
    queryFn: () => api.get<{ data: ScoreWithItems[] }>(`/calls/${id}/scores`),
    enabled: call?.status === 'scored',
  });

  if (callError || (!callLoading && !call)) {
    return (
      <div>
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
          Could not load this call.{' '}
          <Link
            to="/calls"
            className="text-primary underline font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Back to Calls
          </Link>
        </div>
      </div>
    );
  }

  if (!call) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mr-3" />
        Loading...
      </div>
    );
  }

  const scores = scoresData?.data || [];
  const primaryScore = scores[0];

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-page-title text-text-primary">{call.file_name}</h2>
            {call.is_exemplar && (
              <span
                className="text-secondary"
                title={call.exemplar_reason || 'Exemplar call'}
                aria-label="Exemplar call"
              >
                <svg className="w-4 h-4 inline-block" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                </svg>
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 mt-1.5 text-table-cell text-text-subtle">
            <CallStatusBadge status={call.status} pass={primaryScore?.pass} />
            {isAdmin ? (
              <AssignAgentDropdown callId={call.id} currentAgentId={call.agent_id} />
            ) : call.agent_name && (
              <span>Agent: {call.agent_name}</span>
            )}
            {call.duration_seconds != null && call.duration_seconds > 0 ? (
              <span>{formatDuration(call.duration_seconds)}</span>
            ) : null}
            {canAction && call.status === 'scored' && (
              <button
                onClick={handleToggleReviewed}
                className={`inline-flex items-center gap-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${call.reviewed_at ? 'text-pass' : 'text-text-muted hover:text-text-secondary'}`}
                title={call.reviewed_at ? 'Reviewed - click to clear' : 'Mark this call reviewed (feeds calibration / agreement tracking)'}
              >
                {call.reviewed_at ? (
                  <>
                    <svg className="w-4 h-4 inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    Reviewed
                  </>
                ) : (
                  'Mark reviewed'
                )}
              </button>
            )}
            {canAction && call.status === 'scored' && canLearn && (
              <button
                onClick={handleToggleExemplar}
                className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-secondary font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                title={call.is_exemplar ? 'Remove exemplar flag' : 'Mark as firm exemplar - feeds the AI learning system'}
              >
                {call.is_exemplar ? (
                  <svg className="w-4 h-4 inline-block text-secondary" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                  </svg>
                )}
                {call.is_exemplar ? 'Exemplar' : 'Mark as exemplar'}
              </button>
            )}
          </div>
        </div>
        <div className="flex items-start gap-4">
          {primaryScore?.overall_score != null && (
            <ScoreGauge score={primaryScore.overall_score} size="lg" />
          )}
          {isAdmin && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-xs text-text-muted hover:text-fail font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Permanently delete this call"
            >
              {deleting ? 'Deleting...' : 'Delete call'}
            </button>
          )}
        </div>
      </div>

      {/* Processing state */}
      {(call.status === 'uploaded' || call.status === 'transcribing' || call.status === 'scoring') && (
        <div className="bg-card border border-border rounded-card p-10 text-center mb-6">
          <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <div className="text-base font-semibold text-text-primary mb-1">
            {call.status === 'uploaded' && 'Queued for processing'}
            {call.status === 'transcribing' && 'Transcribing audio'}
            {call.status === 'scoring' && 'Scoring against scorecard'}
          </div>
          <div className="text-table-cell text-text-muted">This usually takes less than a minute</div>
        </div>
      )}

      {call.status === 'failed' && (
        <div className="bg-fail-bg border-l-[3px] border-l-fail rounded-card p-4 mb-6">
          <div className="text-table-cell font-semibold text-fail">Processing failed</div>
          {call.error_message && <div className="text-xs text-flag-text mt-1">{call.error_message}</div>}
        </div>
      )}

      {call.status === 'skipped' && (
        <div className="bg-table-header border-l-[3px] border-l-text-muted rounded-card p-4 mb-6">
          <div className="text-table-cell font-semibold text-text-secondary">Not scored — call too short</div>
          <div className="text-xs text-text-muted mt-1">
            {call.error_message || 'This call was too short to evaluate against a scorecard and was skipped.'}
          </div>
        </div>
      )}

      {/* Journey context: this call is scored as part of a sale journey */}
      {call.journey && (
        <div className="bg-card border border-border rounded-card overflow-hidden mb-4">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-section-title text-text-primary">Part of a scored sale</h3>
              <p className="text-xs text-text-muted mt-0.5">
                This call is scored together with the other calls in the sale
                {call.journey.branch ? ` (${call.journey.branch})` : ''}, not on its own.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {call.journey.overall_score != null && (
                <ScoreGauge score={Number(call.journey.overall_score)} size="lg" />
              )}
              {!scoreOnly && call.journey.status === 'scored' && (
                call.journey.pass === true ? (
                  <span className="inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold bg-pass-bg text-pass">Pass</span>
                ) : call.journey.pass === false ? (
                  <span className="inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold bg-fail-bg text-fail">Fail</span>
                ) : (
                  <span className="inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold bg-review-bg text-review">Review</span>
                )
              )}
              <Link
                to={`/journeys/${call.journey.id}`}
                className="inline-flex items-center gap-2 bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                View sale
              </Link>
            </div>
          </div>
          {call.journey.this_call_items.length > 0 ? (
            <div className="divide-y divide-border-light">
              <div className="px-5 pt-3 pb-1 text-table-header uppercase text-text-muted">
                Checkpoints evidenced in this call
              </div>
              {call.journey.this_call_items.map((item, i) => (
                <div key={`${item.label}-${i}`} className="px-5 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-table-cell text-text-cell">{item.label}</div>
                    {item.evidence && (
                      <div className="text-xs text-text-muted mt-0.5 italic line-clamp-2">"{item.evidence}"</div>
                    )}
                  </div>
                  <span className="shrink-0">
                    <ItemResultBadge result={item.result} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-4 text-table-cell text-text-muted">
              No checkpoints were attributed specifically to this call — see the full sale for the combined score.
            </div>
          )}
        </div>
      )}

      {/* 2-column grid: scorecard + transcript */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Scorecard panel */}
        {primaryScore && (
          <div className="bg-card border border-border rounded-card overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex justify-between items-center">
              <h3 className="text-section-title text-text-primary">Compliance Scorecard</h3>
              {primaryScore.overall_score != null && (
                <ScoreGauge score={primaryScore.overall_score} size="lg" />
              )}
            </div>
            <div>
              {primaryScore.item_scores.map((item) => (
                <ScorecardResultCard
                  key={item.id}
                  label={item.label}
                  score={item.score}
                  scoreType={item.score_type}
                  normalizedScore={item.normalized_score}
                  confidence={item.confidence}
                  evidence={item.evidence}
                  reasoning={item.reasoning}
                  result={item.result}
                  canCorrect={canAction && canLearn}
                  onCorrect={() => setCorrectingItem({
                    itemScoreId: item.id,
                    label: item.label,
                    pass: isItemPass(item.normalized_score ?? 0),
                    evidence: item.evidence,
                  })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Transcript panel — flex column so the viewer fills the card height,
            which the grid stretches to match the scorecard column. */}
        {call.transcript_text && (
          <div className="bg-card border border-border rounded-card overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-section-title text-text-primary">Transcript</h3>
            </div>
            <TranscriptViewer transcript={call.transcript_text} />
          </div>
        )}
      </div>

      {/* Coaching panel (shown when call is scored, gated by plan) */}
      {call.status === 'scored' && user && (
        <div className="mt-6">
          <CoachingPanel
            coaching={primaryScore?.coaching || null}
            plan={user.organization_plan}
            callStatus={call.status}
            isAdmin={isAdmin}
            priorCoachingCount={primaryScore?.prior_coaching_count}
          />
        </div>
      )}

      {/* Share with client (admin only, once scored) */}
      {isAdmin && call.status === 'scored' && (
        <div className="mt-6">
          <ShareLinksPanel callId={call.id} />
        </div>
      )}

      {correctingItem && (
        <ScoreCorrectionModal
          callId={call.id}
          itemScoreId={correctingItem.itemScoreId}
          itemLabel={correctingItem.label}
          currentPass={correctingItem.pass}
          evidence={correctingItem.evidence}
          onClose={() => setCorrectingItem(null)}
        />
      )}
    </div>
  );
}
