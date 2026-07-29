import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { AudioPlayer } from './AudioPlayer';
import { formatClock } from '../lib/format';
import { isItemPass } from '@callguard/shared';
import type { EvidenceLocation, ManualReviewItem } from '@callguard/shared';

interface ReviewEvidencePanelProps {
  item: ManualReviewItem;
}

/**
 * The evidence behind one awaiting-review checkpoint: the AI's quote and
 * reasoning, the transcript either side of it, and the recording cued to the
 * moment it was said — so a reviewer can decide from the queue instead of
 * opening the call and hunting for the passage.
 */
export function ReviewEvidencePanel({ item }: ReviewEvidencePanelProps) {
  const hasQuote = Boolean(item.evidence && item.evidence.trim());

  // Only worth asking the server where the quote sits when there is a quote and
  // a call to find it in (an item_type='manual' checkpoint has neither).
  const { data, isLoading, isError } = useQuery({
    queryKey: ['review-evidence', item.kind, item.item_score_id],
    queryFn: () =>
      api.get<EvidenceLocation>(`/review-items/${item.kind}/${item.item_score_id}/evidence`),
    enabled: hasQuote && Boolean(item.source_call_id),
    staleTime: 5 * 60 * 1000,
  });

  const timestamp = data?.timestamp_seconds ?? null;
  const parentLink = item.kind === 'journey' ? `/journeys/${item.parent_id}` : `/calls/${item.parent_id}`;
  // Deep-link the call view at this checkpoint: it re-resolves the same
  // position, highlights the quote in the transcript and cues the recording.
  const transcriptLink = item.source_call_id
    ? `/calls/${item.source_call_id}?evidence=${item.kind}:${item.item_score_id}`
    : null;

  return (
    <div className="bg-page/60 border-t border-border-light px-5 py-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* What the AI said */}
        <div className="min-w-0">
          <div className="text-table-header uppercase text-text-muted mb-1.5">What the AI found</div>

          {item.normalized_score != null && (
            <div className="text-xs mb-1.5">
              <span className={`font-semibold ${isItemPass(Number(item.normalized_score)) ? 'text-pass' : 'text-fail'}`}>
                AI suggests: {isItemPass(Number(item.normalized_score)) ? 'Pass' : 'Fail'}
              </span>
              <span className="text-text-muted">
                {' '}— unconfirmed (low speaker-attribution confidence). Check the quote and confirm.
              </span>
            </div>
          )}

          {hasQuote ? (
            <blockquote className="text-xs text-text-secondary italic border-l-2 border-border pl-2.5 leading-relaxed">
              {item.evidence}
            </blockquote>
          ) : (
            <p className="text-xs text-text-muted leading-relaxed">
              This checkpoint is marked for human sign-off on the scorecard, so the AI never scored
              it and there is no quote. Read the {item.kind === 'journey' ? 'sale' : 'call'} and mark
              it from what you hear.
            </p>
          )}

          {item.reasoning && (
            <p className="text-xs text-text-muted mt-2 leading-relaxed">{item.reasoning}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
            {transcriptLink && (
              <Link
                to={transcriptLink}
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
              >
                {data && !data.matched ? 'Open the full transcript' : 'Open transcript at this point'}
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
            )}
            <Link
              to={parentLink}
              className="text-xs font-semibold text-text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
            >
              {item.kind === 'journey' ? 'Open the whole sale' : 'Open the call'}
            </Link>
            {item.confidence != null && (
              <span className="text-xs text-text-muted">
                AI confidence {Math.round(Number(item.confidence) * 100)}%
              </span>
            )}
          </div>
        </div>

        {/* Where it sits in the call */}
        <div className="min-w-0">
          <div className="text-table-header uppercase text-text-muted mb-1.5">
            In the call
            {item.source_call_name ? <span className="normal-case tracking-normal font-normal"> — {item.source_call_name}</span> : ''}
          </div>

          {!item.source_call_id && (
            <p className="text-xs text-text-muted">
              The AI didn't attribute this checkpoint to a single call — open the sale to see every
              call in it.
            </p>
          )}

          {item.source_call_id && !hasQuote && (
            <p className="text-xs text-text-muted mb-2">
              No quote to locate, so nothing is highlighted — play the recording or read the full
              transcript.
            </p>
          )}

          {isLoading && (
            <div className="space-y-1.5" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-3.5 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                  style={{
                    backgroundImage:
                      'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                    width: i === 1 ? '90%' : '65%',
                  }}
                />
              ))}
            </div>
          )}

          {isError && (
            <p className="text-xs text-fail" role="alert">
              Couldn't load the transcript for this call.
            </p>
          )}

          {/* Speaker labels on this transcript were found to contradict what was
              actually said. Shown above the excerpt, not below it, because a
              reviewer who reads the transcript first has already formed a view
              by the time a footnote arrives — and the whole point of this panel
              is that they decide on the evidence. Without it the panel presents
              "Agent:" and "Customer:" as fact on a call the pipeline scored at
              0.30 confidence, which is how a wrong verdict gets confirmed by a
              human and made permanent. */}
          {data?.speaker_integrity_flag && (
            <div className="rounded-btn bg-review-bg border-l-[3px] border-l-review p-2.5 mb-2.5">
              <p className="text-xs text-text-primary font-semibold">
                Who said what may be wrong on this call
              </p>
              <p className="text-xs text-text-secondary mt-0.5">
                Automated checks found speech that only an adviser would say appearing under
                "Customer" (or the reverse), so the labels below are not trustworthy. Judge this
                checkpoint from the recording rather than the labels.
              </p>
            </div>
          )}

          {data && (
            <>
              {data.matched ? (
                <div className="rounded-btn border border-border-light divide-y divide-border-light overflow-hidden">
                  {data.excerpt.map((line) => (
                    <div
                      key={line.index}
                      className={`px-2.5 py-1.5 text-xs leading-relaxed ${
                        line.is_match ? 'bg-review-bg text-text-primary font-medium' : 'text-text-muted'
                      }`}
                    >
                      {line.speaker && (
                        <span
                          className={`font-semibold mr-1.5 ${
                            line.speaker === 'Agent' ? 'text-speaker-agent' : 'text-speaker-customer'
                          }`}
                        >
                          {line.speaker}:
                        </span>
                      )}
                      {line.text}
                      {line.is_match && <span className="sr-only"> (the quoted passage)</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-text-muted">
                  No passage in the transcript matched this evidence — often because the AI is
                  reporting that the wording was never said, or paraphrased what it heard. Read the
                  transcript in full to check.
                </p>
              )}

              {data.has_audio ? (
                <div className="mt-2.5">
                  <AudioPlayer
                    callId={data.call_id}
                    startAt={timestamp}
                    duration={data.duration_seconds}
                    label={item.label}
                  />
                  <p className="text-xs text-text-muted mt-1">
                    {timestamp != null
                      ? `Cued to ${formatClock(timestamp)}, where the quote was said.`
                      : 'Plays from the start — the exact moment could not be pinned.'}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-text-muted mt-2.5">
                  No recording is stored for this call (retention may have purged the audio).
                </p>
              )}
            </>
          )}

          {/* No quote to locate, but the call itself may still have audio to play. */}
          {!data && !isLoading && item.source_call_id && item.has_audio && (
            <div className="mt-1">
              <AudioPlayer callId={item.source_call_id} label={item.label} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
