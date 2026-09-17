import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useScoreOnly } from '../context/AuthContext';
import { formatDuration, formatPhone } from '../lib/format';
import type { CallListResponse, CallListRow, CallStatus } from '@callguard/shared';

type UploadRow = CallListRow;

// Statuses where something is still happening, so the rail is worth re-reading.
const IN_FLIGHT: CallStatus[] = ['captured', 'uploaded', 'transcribing', 'scoring'];

interface Pill {
  label: string;
  className: string;
}

/**
 * What has become of one upload, in the words this page has already used.
 *
 * Deliberately not CallStatusBadge: that badge answers "what state is this row
 * in" for the calls table, where 'captured' means "waiting for a sale". Here
 * 'captured' means "we haven't fetched the recording yet", and a transcribed
 * call at a firm that scores sales is resting on purpose rather than pending.
 * The shape and token pairs are the badge recipe (DESIGN_SYSTEM §4).
 *
 * `salesScoring` is null when the firm's scoring mode hasn't loaded — then no
 * claim is made about what a transcribed call is waiting for.
 */
function uploadPill(call: UploadRow, salesScoring: boolean | null, scoreOnly: boolean): Pill {
  const muted = 'bg-table-header text-text-muted';
  const processing = 'bg-processing-bg text-processing';

  // The list gives a call's result under whichever shape its firm scores by:
  // the sale it belongs to, or the call's own score. Either way this rail only
  // needs "is it part of a sale, and what did it come to".
  const inSale = call.sale != null;
  const result = call.sale ?? call.score;
  const overallScore = result?.overall_score ?? null;
  const pass = result?.pass ?? null;

  switch (call.status) {
    case 'captured':
      return { label: 'Fetching the recording', className: processing };
    case 'uploaded':
    case 'transcribing':
      return { label: 'Transcribing', className: processing };
    case 'transcribed':
      if (inSale) return { label: 'Scoring the sale', className: processing };
      if (salesScoring === true) return { label: 'Held until a sale', className: muted };
      if (salesScoring === false) return { label: 'Scoring', className: processing };
      return { label: 'Transcribed', className: muted };
    case 'scoring':
      return { label: 'Scoring', className: processing };
    case 'scored': {
      const score = overallScore == null ? null : Math.round(Number(overallScore));
      const sale = inSale ? 'Sale' : null;
      // In score-only mode the verdict is never surfaced — the score stands in
      // for it, exactly as CallStatusBadge does.
      if (scoreOnly || pass == null) {
        return {
          label: [sale, score == null ? 'Scored' : `${score}%`].filter(Boolean).join(' '),
          className: score == null ? muted : processing,
        };
      }
      return {
        label: [sale, pass ? 'Pass' : 'Fail', score == null ? null : `${score}%`]
          .filter(Boolean)
          .join(' '),
        className: pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail',
      };
    }
    case 'skipped':
      return { label: 'Too short to score', className: muted };
    case 'failed':
      return { label: 'Failed', className: 'bg-fail-bg text-fail' };
    default:
      return { label: 'Uploaded', className: muted };
  }
}

function when(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  return sameDay
    ? `Today, ${time}`
    : `${date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${time}`;
}

/**
 * The last five calls this user put here themselves — enough to see that the
 * last upload landed, and where it got to, without leaving the page.
 */
export function RecentUploadsRail({ salesScoring }: { salesScoring: boolean | null }) {
  const scoreOnly = useScoreOnly();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-uploads'],
    queryFn: () => api.get<CallListResponse>('/calls?uploaded_by=me&limit=5'),
    refetchInterval: (query) =>
      (query.state.data?.data ?? []).some((c) => IN_FLIGHT.includes(c.status)) ? 15_000 : false,
  });

  const rows = data?.data ?? [];

  return (
    <section
      aria-labelledby="recent-uploads-title"
      className="bg-card border border-border rounded-card"
    >
      <div className="px-5 py-4 border-b border-border">
        <h3 id="recent-uploads-title" className="text-section-title text-text-primary">
          Your recent uploads
        </h3>
      </div>

      {isError ? (
        <div className="p-5">
          <p className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
            Couldn't load your recent uploads.
          </p>
        </div>
      ) : isLoading ? (
        <ul className="p-5 space-y-4" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="space-y-2">
              <div
                className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                style={{
                  backgroundImage:
                    'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                  width: '70%',
                }}
              />
              <div
                className="h-3 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                style={{
                  backgroundImage:
                    'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                  width: '45%',
                }}
              />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-table-cell text-text-muted">
          Nothing yet. A call you upload appears here, with where it has got to.
        </p>
      ) : (
        <ul>
          {rows.map((call) => {
            const pill = uploadPill(call, salesScoring, scoreOnly);
            const duration = formatDuration(call.duration_seconds);
            return (
              <li key={call.id} className="border-b border-border-light last:border-0">
                <Link
                  to={`/calls/${call.id}`}
                  className="block px-5 py-3.5 hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <div className="text-table-cell font-semibold text-text-primary truncate">
                    {formatPhone(call.customer_phone) || call.file_name}
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <span className="text-xs text-text-muted">
                      {when(call.called_at)}
                      {duration !== '--' && ` · ${duration}`}
                    </span>
                    <span
                      className={`shrink-0 text-badge font-semibold px-2.5 py-[3px] rounded-full ${pill.className}`}
                    >
                      {pill.label}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
