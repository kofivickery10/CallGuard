import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { CallStatusBadge } from '../components/CallStatusBadge';
import { ScoreGauge } from '../components/ScoreGauge';
import { TranscriptViewer } from '../components/TranscriptViewer';
import { ScorecardResultCard } from '../components/ScorecardResultCard';
import { AssignAgentDropdown } from '../components/AssignAgentDropdown';
import { ShareLinksPanel } from '../components/ShareLinksPanel';
import { CoachingPanel } from '../components/CoachingPanel';
import { ScoreCorrectionModal } from '../components/ScoreCorrectionModal';
import { hasFeature } from '@callguard/shared';
import type { Call, CallScore, CallItemScore, CallCoaching } from '@callguard/shared';

type ScoreWithItems = CallScore & {
  coaching: CallCoaching | null;
  item_scores: (CallItemScore & { label: string; item_description: string; score_type: string })[];
};

export function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === 'admin';
  const canLearn = user ? hasFeature(user.organization_plan, 'ai_learning') : false;
  const [correctingItem, setCorrectingItem] = useState<{
    itemScoreId: string;
    label: string;
    pass: boolean;
    evidence: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

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
    if (!window.confirm(`Delete this call permanently?\n\n"${call.file_name}"\n\nThis removes the audio, transcript, scores, breaches, and any corrections. This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.delete(`/calls/${call.id}`);
      queryClient.invalidateQueries({ queryKey: ['calls'] });
      navigate('/calls');
    } catch (err) {
      setDeleting(false);
      alert('Failed to delete call: ' + (err instanceof Error ? err.message : 'unknown error'));
    }
  };

  const { data: call } = useQuery({
    queryKey: ['call', id],
    queryFn: () => api.get<Call>(`/calls/${id}`),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'scored' || status === 'failed' ? false : 3000;
    },
  });

  const { data: scoresData } = useQuery({
    queryKey: ['call-scores', id],
    queryFn: () => api.get<{ data: ScoreWithItems[] }>(`/calls/${id}/scores`),
    enabled: call?.status === 'scored',
  });

  if (!call) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        <div className="w-10 h-10 border-3 border-border border-t-primary rounded-full animate-spin mr-3" />
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
                className="text-secondary text-[18px]"
                title={call.exemplar_reason || 'Exemplar call'}
              >
                ★
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
            {call.duration_seconds && (
              <span>
                {Math.floor(call.duration_seconds / 60)}:{String(Math.floor(call.duration_seconds % 60)).padStart(2, '0')}
              </span>
            )}
            {isAdmin && call.status === 'scored' && canLearn && (
              <button
                onClick={handleToggleExemplar}
                className="text-[12px] text-text-muted hover:text-secondary font-semibold transition-colors"
                title={call.is_exemplar ? 'Remove exemplar flag' : 'Mark as firm exemplar - feeds the AI learning system'}
              >
                {call.is_exemplar ? '★ Exemplar' : '☆ Mark as exemplar'}
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
              className="text-[12px] text-text-muted hover:text-fail font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Permanently delete this call"
            >
              {deleting ? 'Deleting...' : 'Delete call'}
            </button>
          )}
        </div>
      </div>

      {/* Processing state */}
      {(call.status === 'uploaded' || call.status === 'transcribing' || call.status === 'scoring') && (
        <div className="bg-white border border-border rounded-xl p-10 text-center mb-6">
          <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <div className="text-[16px] font-semibold text-text-primary mb-1">
            {call.status === 'uploaded' && 'Queued for processing'}
            {call.status === 'transcribing' && 'Transcribing audio'}
            {call.status === 'scoring' && 'Scoring against scorecard'}
          </div>
          <div className="text-table-cell text-text-muted">This usually takes less than a minute</div>
        </div>
      )}

      {call.status === 'failed' && (
        <div className="bg-fail-bg border-l-[3px] border-l-fail rounded-r-lg p-4 mb-6">
          <div className="text-table-cell font-semibold text-fail">Processing failed</div>
          {call.error_message && <div className="text-[12px] text-flag-text mt-1">{call.error_message}</div>}
        </div>
      )}

      {/* 2-column grid: scorecard + transcript */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Scorecard panel */}
        {primaryScore && (
          <div className="bg-white border border-border rounded-card overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex justify-between items-center">
              <h3 className="text-[15px] font-semibold text-text-primary">Compliance Scorecard</h3>
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
                  canCorrect={isAdmin && canLearn}
                  onCorrect={() => setCorrectingItem({
                    itemScoreId: item.id,
                    label: item.label,
                    pass: item.normalized_score >= 70,
                    evidence: item.evidence,
                  })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Transcript panel */}
        {call.transcript_text && (
          <div className="bg-white border border-border rounded-card overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-[15px] font-semibold text-text-primary">Transcript</h3>
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
