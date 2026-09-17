import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioPlayer } from './AudioPlayer';
import { WithRedactions } from './EvidenceExcerpt';
import { formatClock } from '../lib/format';
import type { ItemResult } from '@callguard/shared';

export interface TranscriptMarker {
  /** The item score row the checkpoint lives on, for selecting it. */
  itemScoreId: string;
  label: string;
  result: ItemResult;
}

interface CallTranscriptProps {
  callId: string;
  transcript: string;
  /**
   * Start second of each transcript line, in line order, from
   * GET /calls/:id/positions. Null where the line couldn't be placed in the
   * recording — the transcript is cleaned up after transcription, so some
   * lines no longer match the timed original.
   */
  lineTimes: (number | null)[];
  /** Checkpoints decided on a line, keyed by line index. */
  markers: Map<number, TranscriptMarker[]>;
  /** The line the open checkpoint was decided on, highlighted and scrolled to. */
  highlightIndex: number | null;
  /** Where the recording is cued, and the sentence explaining why. */
  cue: { seconds: number | null; note: string } | null;
  onCue: (seconds: number, note: string) => void;
  onSelectMarker: (itemScoreId: string) => void;
  hasAudio: boolean;
  durationSeconds: number | null;
  label: string;
  className?: string;
}

/**
 * The call's transcript, docked beside its checkpoints.
 *
 * The page's one job is checking a verdict against what was said, so the
 * transcript is not a second document to go and find: opening a checkpoint
 * brings its line here and cues the recording to it, and the markers down the
 * side go the other way — from a line back to the checkpoint decided on it.
 */
export function CallTranscript({
  callId,
  transcript,
  lineTimes,
  markers,
  highlightIndex,
  cue,
  onCue,
  onSelectMarker,
  hasAudio,
  durationSeconds,
  label,
  className = '',
}: CallTranscriptProps) {
  const [query, setQuery] = useState('');
  const [matchAt, setMatchAt] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);

  const lines = useMemo(
    () =>
      transcript
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const isAgent = line.startsWith('Agent:');
          const isCustomer = line.startsWith('Customer:');
          const speaker = isAgent ? 'Agent' : isCustomer ? 'Customer' : null;
          return { speaker, text: speaker ? line.slice(speaker.length + 1).trim() : line };
        }),
    [transcript]
  );

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      needle.length > 1
        ? lines.reduce<number[]>((acc, line, i) => {
            if (line.text.toLowerCase().includes(needle)) acc.push(i);
            return acc;
          }, [])
        : [],
    [lines, needle]
  );

  const scrollTo = (index: number) => {
    const el = lineRefs.current[index];
    const body = bodyRef.current;
    if (!el || !body) return;
    // Inside the transcript's own scroller on desktop; on a phone the panel has
    // no scroller of its own and the page scrolls instead.
    if (body.scrollHeight > body.clientHeight + 4) {
      body.scrollTo({ top: el.offsetTop - body.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
    } else {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  // Follow the open checkpoint.
  useEffect(() => {
    if (highlightIndex != null) scrollTo(highlightIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIndex]);

  // A new search lands on its first hit; Enter walks the rest.
  useEffect(() => {
    setMatchAt(0);
    if (matches.length > 0 && matches[0] != null) scrollTo(matches[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle]);

  const stepMatch = (back: boolean) => {
    if (matches.length === 0) return;
    const next = (matchAt + (back ? matches.length - 1 : 1)) % matches.length;
    setMatchAt(next);
    const line = matches[next];
    if (line != null) scrollTo(line);
  };

  const highlight = (text: string) => {
    if (needle.length < 2) return <WithRedactions text={text} />;
    const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === needle ? (
            <mark key={i} className="bg-review-bg text-text-primary rounded-sm">
              {part}
            </mark>
          ) : (
            <WithRedactions key={i} text={part} />
          )
        )}
      </>
    );
  };

  return (
    <section
      aria-label="Transcript"
      className={`bg-card border border-border rounded-card overflow-hidden flex flex-col ${className}`}
    >
      <div className="px-5 py-4 border-b border-border space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-section-title text-text-primary">Transcript</h3>
          <label className="flex items-center gap-2 min-w-0 flex-1 sm:flex-none sm:w-60 px-2.5 min-h-[32px] rounded-btn border border-border focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
            <svg className="w-4 h-4 text-text-secondary flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <span className="sr-only">Search the transcript</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                stepMatch(e.shiftKey);
              }}
              placeholder="Search the transcript"
              className="min-w-0 flex-1 bg-transparent text-table-cell outline-none placeholder:text-text-muted"
            />
            {needle.length > 1 && (
              <span className="text-xs text-text-secondary tabular-nums whitespace-nowrap">
                {matches.length ? `${matchAt + 1} of ${matches.length}` : 'None'}
              </span>
            )}
          </label>
        </div>

        {hasAudio && (
          <AudioPlayer
            callId={callId}
            startAt={cue?.seconds ?? null}
            duration={durationSeconds}
            label={label}
          />
        )}
        <p className="text-xs text-text-secondary" aria-live="polite">
          {cue?.note ??
            (markers.size > 0
              ? 'Open a checkpoint to jump to where it was decided.'
              : 'No checkpoint on this sale was decided on a line of this call.')}
        </p>
      </div>

      <div ref={bodyRef} className="overflow-y-auto flex-1 min-h-0 py-2">
        {lines.map((line, i) => {
          const onThisLine = markers.get(i);
          const time = lineTimes[i] ?? null;
          const isHit = highlightIndex === i;
          return (
            <div
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              className={`grid grid-cols-[46px_minmax(0,1fr)_28px] gap-x-2 px-3 py-1.5 text-table-cell leading-relaxed ${
                isHit ? 'bg-review-bg text-text-primary' : 'text-text-cell'
              }`}
            >
              <span className="text-xs text-text-muted tabular-nums pt-0.5">
                {time == null ? (
                  ''
                ) : hasAudio ? (
                  <button
                    type="button"
                    onClick={() => onCue(time, `Playing from ${formatClock(time)}.`)}
                    aria-label={`Play from ${formatClock(time)}`}
                    className="hover:text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                  >
                    {formatClock(time)}
                  </button>
                ) : (
                  formatClock(time)
                )}
              </span>
              <span>
                {line.speaker && (
                  <span
                    className={`font-semibold mr-1.5 ${
                      line.speaker === 'Agent' ? 'text-speaker-agent' : 'text-speaker-customer'
                    }`}
                  >
                    {line.speaker === 'Agent' ? 'Adviser:' : 'Customer:'}
                  </span>
                )}
                {highlight(line.text)}
                {isHit && <span className="sr-only"> (the line this checkpoint was decided on)</span>}
              </span>
              <span className="flex flex-col items-center gap-1 pt-0.5">
                {onThisLine?.map((m) => (
                  <button
                    key={m.itemScoreId}
                    type="button"
                    onClick={() => onSelectMarker(m.itemScoreId)}
                    title={m.label}
                    aria-label={`${RESULT_WORDS[m.result]}: ${m.label}`}
                    className={`w-6 h-6 grid place-items-center rounded-btn hover:bg-table-header focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      MARKER_COLOURS[m.result]
                    }`}
                  >
                    <MarkerGlyph result={m.result} />
                  </button>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const RESULT_WORDS: Record<ItemResult, string> = {
  pass: 'Passed',
  fail: 'Failed',
  na: "Didn't apply",
  manual_review: 'Waiting for review',
};

const MARKER_COLOURS: Record<ItemResult, string> = {
  pass: 'text-pass',
  fail: 'text-fail',
  na: 'text-text-muted',
  manual_review: 'text-review',
};

function MarkerGlyph({ result }: { result: ItemResult }) {
  const path =
    result === 'pass'
      ? 'M5 12.5l4.5 4.5L19 7.5'
      : result === 'fail'
        ? 'M7 7l10 10M17 7L7 17'
        : result === 'na'
          ? 'M6 12h12'
          : 'M12 8v4.5l3 2';
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {result === 'manual_review' && <circle cx="12" cy="12" r="8" />}
      <path d={path} />
    </svg>
  );
}
