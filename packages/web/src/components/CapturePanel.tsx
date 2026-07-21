import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useDialog } from '../components/DialogProvider';
import { CaptureResultBadge } from './CaptureResultBadge';
import type {
  CaptureRun,
  CaptureForm,
  CaptureAnswer,
  CaptureAnswerType,
  CapturePiiClass,
} from '@callguard/shared';

interface AnswerRow extends CaptureAnswer {
  label: string;
  answer_type: CaptureAnswerType;
  required: boolean;
  pii_class: CapturePiiClass;
  sort_order: number;
}

interface CaptureRecord {
  run: CaptureRun | null;
  form: CaptureForm | null;
  answers: AnswerRow[];
}

// The Data Capture record for a sale — kept visually separate from the QA
// score above it: this answers "did we capture everything the customer said",
// not "was the advice process followed". Renders nothing when the sale has no
// capture run (module off for the tenant, or pre-module sales).
export function CapturePanel({ journeyId, isAdmin }: { journeyId: string; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { notify, confirm } = useDialog();
  const [selectedFormId, setSelectedFormId] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['capture-journey', journeyId],
    queryFn: () => api.get<CaptureRecord>(`/capture/journeys/${journeyId}`),
    refetchInterval: (query) => {
      const s = query.state.data?.run?.status;
      return s === 'pending' || s === 'running' ? 4000 : false;
    },
  });

  // Only needed for the needs_form picker; lazy behind that state.
  const needsForm = data?.run?.status === 'needs_form';
  const { data: formsData } = useQuery({
    queryKey: ['capture-forms'],
    queryFn: () => api.get<{ data: CaptureForm[] }>('/capture/forms'),
    enabled: needsForm && isAdmin,
  });

  const runMutation = useMutation({
    mutationFn: (formId?: string) =>
      api.post(`/capture/journeys/${journeyId}/run`, formId ? { form_id: formId } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['capture-journey', journeyId] });
      void notify('Capture run queued — results will appear here shortly.');
    },
    onError: (err) =>
      void notify('Failed to run capture: ' + (err instanceof Error ? err.message : 'unknown error')),
  });

  const handleRerun = async () => {
    const ok = await confirm(
      'Re-run data capture for this sale? The existing captured record is replaced.',
      { confirmLabel: 'Re-run' }
    );
    if (ok) runMutation.mutate(undefined);
  };

  const handleExport = async () => {
    if (!data?.run) return;
    try {
      await api.download(`/capture/runs/${data.run.id}/export.csv`, 'capture-record.csv');
    } catch (err) {
      await notify('Export failed: ' + (err instanceof Error ? err.message : 'unknown error'));
    }
  };

  if (isLoading || !data || !data.run) return null;
  const { run, form, answers } = data;

  const missedRequired = answers.filter((a) => a.result === 'missed' && a.required).length;
  const needsReview = answers.filter((a) => a.result === 'manual_review').length;
  const capturedCount = answers.filter((a) => a.result === 'captured' || a.result === 'confirmed_only').length;

  return (
    <div className="bg-card border border-border rounded-card overflow-hidden mt-4">
      <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-section-title text-text-primary">Data Capture</h3>
          <p className="text-xs text-text-subtle mt-0.5">
            {form
              ? <>What the customer answered, against the <strong>{form.name}</strong> question set{form.context_label ? ` (${form.context_label})` : ''}. Separate from the QA score.</>
              : 'What the customer answered on this sale. Separate from the QA score.'}
          </p>
        </div>
        {run.status === 'completed' && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              className="px-3 py-1.5 rounded-btn text-badge font-semibold border border-border text-text-secondary hover:border-primary hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Export CSV
            </button>
            {isAdmin && (
              <button
                onClick={handleRerun}
                disabled={runMutation.isPending}
                className="px-3 py-1.5 rounded-btn text-badge font-semibold border border-border text-text-secondary hover:border-primary hover:text-primary transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Re-run
              </button>
            )}
          </div>
        )}
      </div>

      {run.status === 'needs_form' && (
        <div className="px-5 py-6">
          <p className="text-table-cell text-text-secondary mb-3">
            No question set could be matched to this sale automatically.
            {isAdmin ? ' Pick the one that applies:' : ' Ask an admin to pick the question set that applies.'}
          </p>
          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedFormId}
                onChange={(e) => setSelectedFormId(e.target.value)}
                aria-label="Question set for this sale"
                className="px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus:outline-none"
              >
                <option value="">Select a question set…</option>
                {(formsData?.data ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}{f.context_label ? ` — ${f.context_label}` : ''}
                  </option>
                ))}
              </select>
              <button
                onClick={() => selectedFormId && runMutation.mutate(selectedFormId)}
                disabled={!selectedFormId || runMutation.isPending}
                className="px-3 py-2 rounded-btn text-table-cell border border-primary bg-primary text-white font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {runMutation.isPending ? 'Queuing…' : 'Run capture'}
              </button>
            </div>
          )}
        </div>
      )}

      {(run.status === 'pending' || run.status === 'running') && (
        <div className="px-5 py-6 flex items-center gap-3 text-text-muted text-table-cell">
          <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
          Capturing answers from the call{answers.length !== 1 ? 's' : ''}…
        </div>
      )}

      {run.status === 'failed' && (
        <div className="px-5 py-6">
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
            Capture failed{run.error_message ? `: ${run.error_message}` : ''}.
          </div>
          {isAdmin && (
            <div className="mt-3">
              <button
                onClick={() => runMutation.mutate(undefined)}
                disabled={runMutation.isPending}
                className="px-3 py-2 rounded-btn text-table-cell border border-primary bg-primary text-white font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      {run.status === 'completed' && (
        <>
          {/* Summary strip — status is conveyed by text, not colour alone */}
          <div className="px-5 py-3 border-b border-border-light flex flex-wrap gap-4 text-badge">
            <span className="text-text-secondary">
              <strong className="text-text-primary">{capturedCount}</strong> of {answers.length} answered
            </span>
            <span className={missedRequired > 0 ? 'text-fail font-semibold' : 'text-text-muted'}>
              {missedRequired} required missed
            </span>
            {needsReview > 0 && (
              <span className="text-review font-semibold">{needsReview} need review</span>
            )}
          </div>

          <div>
            {answers.map((a) => (
              <div key={a.id} className="px-5 py-3.5 border-b border-border-light last:border-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-table-cell text-text-primary font-medium">
                      {a.label}
                      {!a.required && <span className="text-text-muted font-normal"> (optional)</span>}
                    </div>
                    {a.result === 'captured' && a.captured_value && (
                      <div className="text-table-cell text-text-secondary mt-1">
                        Answer: <strong className="text-text-primary">{a.captured_value}</strong>
                      </div>
                    )}
                    {a.result === 'confirmed_only' && (
                      <div className="text-table-cell text-text-muted mt-1 italic">
                        Answered — value not stored (personal data)
                      </div>
                    )}
                    {a.evidence && (
                      <blockquote className="text-xs text-text-muted italic border-l-2 border-border pl-2.5 mt-1.5 leading-relaxed">
                        {a.evidence}
                        {a.source_call_id && (
                          <Link
                            to={`/calls/${a.source_call_id}`}
                            className="not-italic ml-2 text-primary hover:underline"
                          >
                            source call →
                          </Link>
                        )}
                      </blockquote>
                    )}
                    {a.reasoning && (
                      <p className="text-xs text-text-muted mt-1.5 leading-relaxed">{a.reasoning}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <CaptureResultBadge result={a.result} />
                    {a.confidence != null && (
                      <span className="text-[11px] text-text-muted">
                        {(Number(a.confidence) * 100).toFixed(0)}% confidence
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {answers.length === 0 && (
              <p className="px-5 py-6 text-center text-text-muted text-table-cell">No answers recorded.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
