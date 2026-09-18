import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { WithRedactions } from './EvidenceExcerpt';
import type { SaleSearchResponse } from '@callguard/shared';

interface SaleTranscriptSearchProps {
  journeyId: string;
  /** Calls in the sale that have a transcript — the ones a search can reach. */
  searchableCalls: number;
  /** …and the ones it cannot, because they have no words yet. */
  unsearchableCalls: number;
}

// The same floor the call page's find-in-transcript uses, and the same one the
// endpoint enforces: below it a term matches most lines of most calls.
const MIN_TERM = 2;
// Long enough not to fire on every keystroke, short enough that Enter almost
// always steps results that are already there.
const DEBOUNCE_MS = 400;

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

/**
 * Find a word anywhere in a sale: one box, every call at once.
 *
 * "Was 'warranty' said anywhere on this sale?" is a question about the sale,
 * but until now it could only be asked of one call at a time — open a call,
 * search it, go back, remember the answer, repeat. The sale is the compliance
 * unit, so the search is on the sale.
 *
 * It borrows the call page's find-in-transcript wholesale (CallTranscript.tsx):
 * the same box, the same "4 of 17" counter, Enter and Shift+Enter to step, and
 * the same marked term rendered through WithRedactions. What differs is that
 * the matching lines come from the server (GET /journeys/:id/transcript-search)
 * rather than from a transcript already in the browser — see that route for why.
 */
export function SaleTranscriptSearch({
  journeyId,
  searchableCalls,
  unsearchableCalls,
}: SaleTranscriptSearchProps) {
  const [query, setQuery] = useState('');
  // What was actually asked of the server. Trails `query` by the debounce.
  const [term, setTerm] = useState('');
  const [matchAt, setMatchAt] = useState(0);
  const matchRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_TERM) {
      setTerm('');
      return;
    }
    const timer = setTimeout(() => setTerm(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['journey-transcript-search', journeyId, term],
    queryFn: () =>
      api.get<SaleSearchResponse>(
        `/journeys/${journeyId}/transcript-search?q=${encodeURIComponent(term)}`
      ),
    // Nothing is fetched until someone searches: a reviewer who never uses this
    // box never loads a transcript, and the sale page is no slower for them.
    enabled: term.length >= MIN_TERM,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Every hit in the sale, in the order they were said — the list the "4 of 17"
  // counter and the stepper walk.
  const flat = useMemo(
    () =>
      (data?.calls ?? []).flatMap((call) =>
        call.matches.map((m) => ({ key: `${call.call_id}:${m.line_index}` }))
      ),
    [data]
  );

  const scrollToMatch = (index: number) => {
    const key = flat[index]?.key;
    if (!key) return;
    matchRefs.current.get(key)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // A new result set lands on its first hit; Enter walks the rest.
  useEffect(() => {
    setMatchAt(0);
    if (flat.length > 0) requestAnimationFrame(() => scrollToMatch(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const stepMatch = (back: boolean) => {
    if (flat.length === 0) return;
    const next = (matchAt + (back ? flat.length - 1 : 1)) % flat.length;
    setMatchAt(next);
    scrollToMatch(next);
  };

  const highlight = (text: string) => {
    if (!data?.query) return <WithRedactions text={text} />;
    const needle = data.query.toLowerCase();
    const parts = text.split(new RegExp(`(${data.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
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

  const searching = term.length >= MIN_TERM;
  const counter = !searching
    ? null
    : isFetching
      ? 'Searching…'
      : isError || data?.restricted
        ? null
        : flat.length > 0
          ? `${matchAt + 1} of ${flat.length}`
          : 'None';

  // Runs across the whole sale as the groups render, so a match's number in the
  // "4 of 17" counter is its number in the list a reader is looking at.
  let matchNumber = -1;

  return (
    <section
      className="bg-card border border-border rounded-card overflow-hidden"
      aria-label="Search this sale's calls"
    >
      <div className="px-5 py-4 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {/* On a phone the heading takes its own line, so the box and its
              stepper get the full width rather than being squeezed into what
              is left of one. */}
          <h3 className="text-section-title text-text-primary w-full sm:w-auto sm:mr-auto">
            Search the calls
          </h3>
          <label className="flex items-center gap-2 min-w-0 flex-1 sm:flex-none sm:w-72 px-2.5 min-h-[32px] rounded-btn border border-border focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
            <SearchIcon className="w-4 h-4 text-text-secondary flex-none" />
            <span className="sr-only">Search every call in this sale</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                // Enter before the debounce has fired asks straight away;
                // afterwards it steps, exactly as it does on the call page.
                if (trimmed.length >= MIN_TERM && trimmed !== term) setTerm(trimmed);
                else stepMatch(e.shiftKey);
              }}
              disabled={searchableCalls === 0}
              placeholder="Search every call in this sale"
              className="min-w-0 flex-1 bg-transparent text-table-cell outline-none disabled:opacity-50 placeholder:text-text-muted"
            />
            {counter && (
              <span className="text-xs text-text-secondary tabular-nums whitespace-nowrap" aria-live="polite">
                {counter}
              </span>
            )}
          </label>
          {flat.length > 1 && (
            <span className="flex items-center gap-1">
              {[
                { back: true, label: 'Previous match', path: 'M15 18l-6-6 6-6' },
                { back: false, label: 'Next match', path: 'M9 18l6-6-6-6' },
              ].map((b) => (
                <button
                  key={b.label}
                  type="button"
                  onClick={() => stepMatch(b.back)}
                  aria-label={b.label}
                  className="w-8 h-8 rounded-btn flex items-center justify-center text-text-secondary hover:bg-sidebar-hover hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={b.path} />
                  </svg>
                </button>
              ))}
            </span>
          )}
        </div>

        {/* What this search cannot reach. Permanent, because both facts are
            true before anyone types: a call still being transcribed has no
            words yet, and personal data was taken out of every transcript
            before it was stored. Either would otherwise read as a bug the
            first time a search that should have matched came back empty. */}
        <p className="text-xs text-text-secondary">
          {searchableCalls === 0
            ? 'No call in this sale has been transcribed yet, so there is nothing to search. '
            : unsearchableCalls > 0
              ? `${plural(searchableCalls, 'call')} of ${searchableCalls + unsearchableCalls} can be searched — the ${
                  unsearchableCalls === 1 ? 'other has' : 'others have'
                } no transcript yet. `
              : ''}
          Personal details are removed before a transcript is stored and appear as tags such as
          [NAME_GIVEN_1], so a name, date of birth or card number will not match.
        </p>
      </div>

      {searching && (
        <div className="border-t border-border max-h-[28rem] overflow-y-auto">
          {isFetching && (
            <div className="px-5 py-4 space-y-2" aria-busy="true" aria-label="Searching this sale">
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

          {!isFetching && isError && (
            <div className="px-5 py-4">
              <p className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
                The calls could not be searched just now. Try again in a moment.
              </p>
            </div>
          )}

          {/* Withheld, not empty — the same distinction the evidence excerpt
              draws, and for the same reason: "no matches" would be a false
              answer to the question that was asked. */}
          {!isFetching && !isError && data?.restricted && (
            <p className="px-5 py-8 text-center text-table-cell text-text-secondary">
              Your firm keeps some personal details in its transcripts, so searching them is open to
              administrators only.
            </p>
          )}

          {!isFetching && !isError && data && !data.restricted && flat.length === 0 && (
            <p className="px-5 py-8 text-center text-table-cell text-text-secondary">
              No matches in this sale for “{data.query}”.
            </p>
          )}

          {!isFetching && !isError && data && !data.restricted && data.truncated && (
            <p className="px-5 pt-3 text-xs text-text-secondary">
              The first {data.total_matches} matches are listed. Search for more of the phrase to
              narrow them.
            </p>
          )}

          {!isFetching &&
            !isError &&
            data &&
            !data.restricted &&
            data.calls.map((call) => (
              <div key={call.call_id} className="px-5 py-3 border-b border-border-light last:border-0">
                <h4 className="text-card-label uppercase text-text-secondary">
                  Call {call.call_number} of {data.searched_calls}
                  <span className="normal-case"> · {dayMonth(call.call_date)}</span>
                  {call.agent_name && <span className="normal-case"> · {call.agent_name}</span>}
                  <span className="normal-case"> · {plural(call.match_count, 'match', 'matches')}</span>
                </h4>

                <ol className="mt-2 space-y-2">
                  {call.matches.map((match) => {
                    matchNumber += 1;
                    const at = matchNumber;
                    const key = `${call.call_id}:${match.line_index}`;
                    const active = at === matchAt;
                    return (
                      <li key={key}>
                        <Link
                          to={`/calls/${call.call_id}?q=${encodeURIComponent(data.query)}&line=${match.line_index}`}
                          ref={(el) => {
                            matchRefs.current.set(key, el);
                          }}
                          onClick={() => setMatchAt(at)}
                          aria-label={`Open call ${call.call_number} at this line`}
                          className={`block rounded-btn border px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                            active
                              ? 'border-primary bg-primary-light'
                              : 'border-border-light hover:bg-table-header'
                          }`}
                        >
                          {match.lines.map((line) => (
                            <span
                              key={line.index}
                              className={`block text-table-cell leading-relaxed ${
                                line.is_match ? 'text-text-primary' : 'text-text-secondary'
                              }`}
                            >
                              {line.speaker && (
                                <span
                                  className={`font-semibold mr-1.5 ${
                                    line.speaker === 'Agent' ? 'text-speaker-agent' : 'text-speaker-customer'
                                  }`}
                                >
                                  {line.speaker === 'Agent' ? 'Adviser:' : 'Customer:'}
                                </span>
                              )}
                              {line.is_match ? highlight(line.text) : <WithRedactions text={line.text} />}
                            </span>
                          ))}
                          {active && <span className="sr-only"> (the match you are on)</span>}
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
