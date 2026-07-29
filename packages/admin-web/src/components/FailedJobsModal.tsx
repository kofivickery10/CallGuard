import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useDialog } from './DialogProvider';

interface FailedJob {
  id: string;
  name: string;
  failed_reason: string | null;
  failed_at: string | null;
  attempts_made: number;
  ref: Record<string, string>;
}

interface Props {
  queue: string;
  onClose: () => void;
  /** Called after a retry or clear, so the dashboard can refresh its counts. */
  onChanged: () => void;
}

/**
 * Failed-job drill-down for one queue. BullMQ retains failed jobs (hundreds per
 * queue, with no expiry), so without this the only way to see or clear a failure
 * was to open Redis by hand — and the health panel stayed red indefinitely.
 */
export default function FailedJobsModal({ queue, onClose, onChanged }: Props) {
  const { confirm } = useDialog();
  const [jobs, setJobs] = useState<FailedJob[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.get<{ jobs: FailedJob[] }>(`/superadmin/queues/${queue}/failed?limit=50`);
      setJobs(r.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
      setJobs([]);
    }
  }, [queue]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const retryOne = (id: string) =>
    act(() => api.post(`/superadmin/queues/${queue}/failed/retry`, { job_ids: [id] }));

  const removeOne = (id: string) =>
    act(() => api.delete(`/superadmin/queues/${queue}/failed`, { job_ids: [id] }));

  const retryAll = async () => {
    const ok = await confirm(
      `Re-run every failed job on the ${queue} queue? Transcription and scoring jobs spend money on each run.`,
      { title: 'Retry all failed jobs', confirmLabel: 'Retry all' }
    );
    if (!ok) return;
    await act(async () => {
      // The endpoint retries in batches, so say what is left instead of
      // implying the queue was emptied.
      const r = await api.post<{ retried: number; remaining_failed: number; batch_limit: number }>(
        `/superadmin/queues/${queue}/failed/retry`,
        {}
      );
      setNote(
        r.remaining_failed > 0
          ? `Retried ${r.retried} (batches of ${r.batch_limit}). ${r.remaining_failed} still failed — run it again to continue.`
          : `Retried ${r.retried}. Nothing left failed on this queue.`
      );
    });
  };

  const clearAll = async () => {
    const ok = await confirm(
      `Discard every failed job on the ${queue} queue? The work is not re-run and the failure record is gone.`,
      { title: 'Clear failed jobs', confirmLabel: 'Clear all', danger: true }
    );
    if (ok) await act(() => api.delete(`/superadmin/queues/${queue}/failed`, {}));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto py-8">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="failed-jobs-title"
        className="relative bg-card border border-border rounded-card w-full max-w-2xl p-6 shadow-xl my-auto"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 id="failed-jobs-title" className="text-section-title text-text-primary capitalize">
              {queue} — failed jobs
            </h2>
            <p className="text-page-sub text-text-muted mt-0.5">
              Newest first, up to 50. Retrying re-runs the job; clearing only discards the record.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close failed jobs"
            className="text-text-muted hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary rounded"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {error && <p className="text-table-cell text-fail mb-3">{error}</p>}
        {note && <p className="text-table-cell text-text-secondary mb-3">{note}</p>}

        {jobs === null ? (
          <p className="text-table-cell text-text-muted py-6">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="text-table-cell text-text-muted py-6">
            No failed jobs on this queue.
          </p>
        ) : (
          <>
            <div className="max-h-80 overflow-y-auto divide-y divide-border-light border border-border-light rounded-btn">
              {jobs.map((job) => (
                <div key={job.id} className="p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-table-cell text-text-primary font-semibold">
                      {job.name}
                      <span className="text-text-muted font-normal"> · attempt {job.attempts_made}</span>
                    </p>
                    <p className="text-badge text-text-muted mt-0.5">
                      {job.failed_at ? new Date(job.failed_at).toLocaleString('en-GB') : 'no timestamp'}
                      {Object.entries(job.ref).map(([k, v]) => (
                        <span key={k} className="ml-2 font-mono">{k}={v.slice(0, 8)}</span>
                      ))}
                    </p>
                    {job.failed_reason && (
                      <p className="text-badge text-fail mt-1 break-words">{job.failed_reason}</p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => retryOne(job.id)}
                      disabled={busy}
                      className="text-badge px-2 py-1 rounded-btn border border-border text-text-secondary hover:bg-sidebar-hover disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      Retry
                    </button>
                    <button
                      onClick={() => removeOne(job.id)}
                      disabled={busy}
                      aria-label={`Discard failed job ${job.name}`}
                      className="text-badge px-2 py-1 rounded-btn border border-border text-fail hover:bg-fail-bg disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={clearAll}
                disabled={busy}
                className="px-[18px] py-[9px] rounded-btn border border-border text-fail font-semibold text-table-cell hover:bg-fail-bg disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary"
              >
                Clear all
              </button>
              <button
                onClick={retryAll}
                disabled={busy}
                className="px-[18px] py-[9px] rounded-btn bg-primary text-white font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary"
              >
                Retry all
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
