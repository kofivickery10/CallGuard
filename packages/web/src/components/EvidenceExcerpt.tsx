import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { AudioPlayer } from './AudioPlayer';
import { formatClock } from '../lib/format';
import type { EvidenceLocation } from '@callguard/shared';

interface EvidenceExcerptProps {
  /** Which score table the checkpoint lives in. */
  kind: 'call' | 'journey';
  /** The item score row — what the evidence is located against. */
  itemScoreId: string;
  /** The AI's own quote, shown when the transcript can't be matched. */
  quote: string | null;
  /** Null when the scorer cited no single call: there is nothing to locate. */
  sourceCallId: string | null;
  /** Checkpoint label, used to name the audio player's controls. */
  label: string;
  /** "Call 2" — how this call is numbered in the sale, when part of one. */
  callLabel?: string | null;
  /** Fetch only once the row is open; the excerpt costs a transcript read. */
  enabled?: boolean;
  /**
   * False for a checkpoint the AI never assessed (a manual checkpoint, decided
   * by a reviewer). "No evidence was found" would imply a search that never ran.
   */
  aiAssessed?: boolean;
}

// The AI prefixes a journey quote with the call it came from ("[Call 2] …").
// The call is named on the row itself, so the marker is noise in the quote.
const CALL_MARKER = /^\s*\[call\s+\d+\]\s*/i;

// Redaction tags written into the transcript at transcription (typed, numbered:
// [NAME_GIVEN_1], [CREDIT_CARD_2]). Shown as chips rather than bracketed text,
// so a reader can see at a glance that personal data was taken out, and where.
const REDACTION_TAG = /(\[[A-Z][A-Z_]*_\d+\])/g;

function WithRedactions({ text }: { text: string }) {
  return (
    <>
      {text.split(REDACTION_TAG).map((part, i) =>
        /^\[[A-Z][A-Z_]*_\d+\]$/.test(part) ? (
          <span
            key={i}
            className="inline-block font-mono text-xs leading-tight px-1 py-px rounded bg-table-header border border-border-light text-text-secondary whitespace-nowrap"
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

/**
 * Where a checkpoint's evidence sits in the call: the transcript lines either
 * side of it with the quoted line marked, and the recording cued to it.
 *
 * This is the product's core claim ("evidence, not opinion") made visible — who
 * said it, when, in their own words — rather than a paraphrase a reviewer has
 * to take on trust. The position is resolved on demand by the server
 * (services/evidence-locator.ts) and never stored, so it can't go stale against
 * a re-transcribed call.
 */
export function EvidenceExcerpt({
  kind,
  itemScoreId,
  quote,
  sourceCallId,
  label,
  callLabel,
  enabled = true,
  aiAssessed = true,
}: EvidenceExcerptProps) {
  const hasQuote = Boolean(quote && quote.trim());
  const cleanQuote = quote?.replace(CALL_MARKER, '').trim() ?? '';

  const { data, isLoading, isError } = useQuery({
    queryKey: ['evidence', kind, itemScoreId],
    queryFn: () => api.get<EvidenceLocation>(`/review-items/${kind}/${itemScoreId}/evidence`),
    enabled: enabled && hasQuote && Boolean(sourceCallId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (!hasQuote) {
    return (
      <p className="text-table-cell text-text-secondary leading-relaxed">
        {aiAssessed
          ? 'No relevant evidence was found on the calls for this checkpoint.'
          : 'Not assessed by the AI — this checkpoint is decided by a reviewer.'}
      </p>
    );
  }

  const timestamp = data?.timestamp_seconds ?? null;
  const transcriptLink = sourceCallId
    ? `/calls/${sourceCallId}?evidence=${kind}:${itemScoreId}`
    : null;

  return (
    <div className="space-y-2.5">
      {/* Speaker labels on this transcript were found to contradict what was
          said, so who said a line is not trustworthy here. Above the excerpt,
          not below it: a reviewer who reads first has already formed a view by
          the time a footnote arrives. */}
      {data?.speaker_integrity_flag && (
        <p className="text-xs text-review">
          <span className="font-semibold">Who said what may be wrong on this call.</span> Automated
          checks found adviser speech labelled as the customer, or the reverse. Judge this from the
          recording rather than the labels.
        </p>
      )}

      {isLoading && (
        <div className="space-y-1.5" aria-busy="true" aria-label="Loading the transcript">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
              style={{
                backgroundImage:
                  'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                width: i === 1 ? '92%' : '70%',
              }}
            />
          ))}
        </div>
      )}

      {/* The quote still stands on its own when the transcript can't be reached
          or matched, so the verdict is never left with no evidence at all. */}
      {(isError || !sourceCallId || (data && !data.matched)) && (
        <>
          <blockquote className="text-table-cell text-text-cell border-l-2 border-border pl-3 leading-relaxed">
            <WithRedactions text={cleanQuote} />
          </blockquote>
          <p className="text-xs text-text-secondary">
            {isError
              ? "The transcript for this call couldn't be loaded, so this is the quote as the AI recorded it."
              : !sourceCallId
                ? 'The AI did not attribute this checkpoint to a single call.'
                : 'This wording was not found in the transcript — the AI may have paraphrased it, or be reporting that it was never said. Read the call to check.'}
          </p>
        </>
      )}

      {data?.matched && (
        <ol className="rounded-btn border border-border-light divide-y divide-border-light overflow-hidden">
          {data.excerpt.map((line) => (
            <li
              key={line.index}
              className={`px-3 py-2 text-table-cell leading-relaxed ${
                line.is_match ? 'bg-review-bg text-text-primary' : 'text-text-cell'
              }`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                {line.speaker && (
                  <span
                    className={`font-semibold ${
                      line.speaker === 'Agent' ? 'text-speaker-agent' : 'text-speaker-customer'
                    }`}
                  >
                    {line.speaker === 'Agent' ? 'Adviser' : 'Customer'}:
                  </span>
                )}
                {line.is_match && timestamp != null && (
                  <span className="text-xs text-text-secondary tabular-nums">
                    {formatClock(timestamp)}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <WithRedactions text={line.text} />
                  {line.is_match && <span className="sr-only"> (the quoted passage)</span>}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {transcriptLink && (
          <Link
            to={transcriptLink}
            className="inline-flex items-center gap-1.5 min-h-[32px] py-1 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-btn"
          >
            {data && !data.matched ? 'Open the full transcript' : 'Open this moment in the call'}
            {callLabel && <span className="font-normal text-text-secondary">({callLabel})</span>}
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
        )}
      </div>

      {data?.has_audio && (
        <div>
          <AudioPlayer
            callId={data.call_id}
            startAt={timestamp}
            duration={data.duration_seconds}
            label={label}
          />
          <p className="text-xs text-text-secondary mt-1">
            {timestamp != null
              ? `Cued to ${formatClock(timestamp)}, where this was said.`
              : 'Plays from the start — the exact moment could not be pinned.'}
          </p>
        </div>
      )}

      {data && !data.has_audio && (
        <p className="text-xs text-text-secondary">
          No recording is stored for this call (retention may have purged the audio).
        </p>
      )}
    </div>
  );
}
