import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parseCsv } from '@callguard/shared';
import { api } from '../api/client';

interface ScorecardSummary {
  id: string;
  name: string;
  is_active: boolean;
}

interface PreviewRow {
  /** The line in the operator's own file. */
  line: number;
  audio_url: string;
  agent_name: string;
  customer_phone: string;
  call_date: string;
  external_id: string;
  tags: string;
  scorecard: string;
  scorecard_id: string | null;
  /** Null when the row is ready to send. */
  problem: string | null;
}

interface BulkImportResult {
  total: number;
  accepted: number;
  skipped: number;
  errors: { row: number; audio_url: string; error: string }[];
}

const MAX_ROWS = 200;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Turn CSV text into the rows the preview table shows, checking each one.
 *
 * Every check is the operator's own wording, and every row keeps the line
 * number it came from — a batch of 40 recordings where two are wrong is only
 * fixable if the page says which two.
 *
 * Scorecards are matched by NAME, case-insensitively (an existing file's
 * scorecard_id column still works). Nobody has the UUID of a scorecard to
 * hand, and the old CSV silently used the active scorecard when the id didn't
 * match anything.
 */
export function buildPreview(csvText: string, scorecards: ScorecardSummary[]): {
  rows: PreviewRow[];
  fileProblem: string | null;
} {
  const parsed = parseCsv(csvText);
  if (parsed.rows.length === 0) {
    return {
      rows: [],
      fileProblem: parsed.headers.length
        ? 'That file has a header row but no calls under it.'
        : 'That file is empty.',
    };
  }
  if (!parsed.headers.includes('audio_url')) {
    return {
      rows: [],
      fileProblem:
        'The header row has no audio_url column, so there is nothing to import. The first line must name the columns.',
    };
  }

  const byName = new Map(scorecards.map((s) => [s.name.trim().toLowerCase(), s]));
  const byId = new Map(scorecards.map((s) => [s.id, s]));
  const seenExternalIds = new Map<string, number>();

  const rows = parsed.rows.map((row) => {
    const v = row.values;
    const scorecard = v.scorecard || v.scorecard_name || v.scorecard_id || '';
    const matched = byName.get(scorecard.trim().toLowerCase()) ?? byId.get(scorecard.trim());
    const externalId = v.external_id ?? '';

    let problem: string | null = null;
    if (!v.audio_url) {
      problem = 'No recording link';
    } else if (!/^https:\/\//i.test(v.audio_url)) {
      problem = 'The link must start with https://';
    } else if (v.call_date && !isIsoDate(v.call_date)) {
      problem = 'The date must be written as YYYY-MM-DD';
    } else if (scorecard && !matched) {
      problem = `No scorecard called "${scorecard}"`;
    } else if (externalId && seenExternalIds.has(externalId)) {
      problem = `Repeats the id on line ${seenExternalIds.get(externalId)}`;
    }

    if (externalId && !seenExternalIds.has(externalId)) seenExternalIds.set(externalId, row.line);

    return {
      line: row.line,
      audio_url: v.audio_url ?? '',
      agent_name: v.agent_name ?? '',
      customer_phone: v.customer_phone ?? '',
      call_date: v.call_date ?? '',
      external_id: externalId,
      tags: v.tags ?? '',
      scorecard,
      scorecard_id: matched?.id ?? null,
      problem,
    };
  });

  return {
    rows,
    fileProblem:
      rows.length > MAX_ROWS
        ? `That file has ${rows.length} rows. Import up to ${MAX_ROWS} at a time.`
        : null,
  };
}

/**
 * Bulk import, as a drawer over the Upload page rather than a panel inside it:
 * it is an admin's occasional migration job, not part of uploading one call.
 *
 * Nothing is sent until the operator presses the button naming the count. Until
 * then the CSV is only parsed and checked in the browser (DESIGN_SYSTEM §4:
 * dialog role, focus trap, Escape, focus returned to the trigger).
 */
export function BulkImportDrawer({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  const [csvText, setCsvText] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BulkImportResult | null>(null);

  const { data: scorecards, isError: scorecardsError } = useQuery({
    queryKey: ['scorecards'],
    queryFn: () => api.get<{ data: ScorecardSummary[] }>('/scorecards'),
  });

  // Remember who opened the drawer, and put focus back there when it closes.
  useEffect(() => {
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => (openerRef.current as HTMLElement | null)?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
      ) ?? []
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onDrop = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setReadError('');
    setResult(null);
    setError('');
    try {
      setCsvText(await file.text());
    } catch {
      setReadError(`Couldn't read ${file.name}. Open it and paste the rows below instead.`);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    onDropRejected: () =>
      setReadError('That file is not a CSV. Export your list as CSV, or paste the rows below.'),
    noClick: true,
    noKeyboard: true,
    multiple: false,
    accept: { 'text/csv': ['.csv'], 'text/plain': ['.csv', '.txt'] },
  });

  const { rows, fileProblem } = useMemo(
    () => (csvText.trim() ? buildPreview(csvText, scorecards?.data ?? []) : { rows: [], fileProblem: null }),
    [csvText, scorecards]
  );
  const ready = rows.filter((r) => !r.problem);
  const needFixing = rows.length - ready.length;

  const handleImport = async () => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const payload = ready.map((r) => ({
        row: r.line,
        audio_url: r.audio_url,
        agent_name: r.agent_name || undefined,
        customer_phone: r.customer_phone || undefined,
        call_date: r.call_date || undefined,
        external_id: r.external_id || undefined,
        tags: r.tags || undefined,
        scorecard_id: r.scorecard_id || undefined,
      }));
      const imported = await api.post<BulkImportResult>('/calls/bulk-import', { rows: payload });
      setResult(imported);
      setCsvText('');
      queryClient.invalidateQueries({ queryKey: ['calls'] });
      queryClient.invalidateQueries({ queryKey: ['my-uploads'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-import-title"
        onKeyDown={onKeyDown}
        className="w-full sm:w-[760px] bg-card border-l border-border shadow-lg flex flex-col"
      >
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-4">
          <div>
            <h3 id="bulk-import-title" className="text-section-title text-text-primary">
              Import many recordings
            </h3>
            <p className="text-table-cell text-text-secondary mt-1">
              For recordings you already hold elsewhere. Each row needs a link CallGuard can
              download, and up to {MAX_ROWS} rows go in at a time.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close bulk import"
            className="w-10 h-10 shrink-0 rounded-full hover:bg-sidebar-hover flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <svg
              className="w-5 h-5 stroke-text-secondary"
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div {...getRootProps()}>
            <input {...getInputProps()} />
            <div
              className={`rounded-card border-2 border-dashed p-6 text-center transition-colors ${
                isDragActive ? 'border-primary bg-primary-light' : 'border-border bg-primary-light/50'
              }`}
            >
              <button
                type="button"
                onClick={open}
                aria-label="Choose a CSV of recordings"
                aria-describedby="bulk-import-columns"
                className="min-h-[44px] px-[18px] py-[9px] rounded-btn bg-primary-ink text-on-solid text-table-cell font-semibold hover:bg-primary-ink-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <span className="hidden sm:inline">Drop a CSV here, or choose one</span>
                <span className="sm:hidden">Choose a CSV</span>
              </button>
              <p id="bulk-import-columns" className="text-xs text-text-muted mt-3">
                One row per call. The header row must include <code>audio_url</code>;{' '}
                <code>agent_name</code>, <code>customer_phone</code>, <code>call_date</code>{' '}
                (YYYY-MM-DD), <code>external_id</code>, <code>tags</code> and <code>scorecard</code>{' '}
                (by name) are optional.
              </p>
            </div>
          </div>

          {readError && (
            <p role="alert" className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
              {readError}
            </p>
          )}

          <div>
            <label
              htmlFor="bulk-import-csv"
              className="block text-xs font-medium text-text-muted mb-1"
            >
              Or paste the rows
            </label>
            <textarea
              id="bulk-import-csv"
              value={csvText}
              onChange={(e) => {
                setCsvText(e.target.value);
                setResult(null);
                setError('');
                setReadError('');
              }}
              rows={6}
              spellCheck={false}
              placeholder={
                'audio_url,agent_name,customer_phone,call_date,external_id,scorecard\n' +
                'https://your-archive.example.com/call-001.mp3,Marcus Webb,+44 7468 432 368,2026-04-29,crm-12345,Protection sale\n' +
                'https://your-archive.example.com/call-002.mp3,Tina Lee,+44 7468 432 368,2026-04-30,crm-12346,'
              }
              className="w-full px-3 py-2 rounded-btn border border-border bg-page text-xs font-mono text-text-primary placeholder:text-text-muted focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </div>

          {scorecardsError && (
            <p className="bg-review-bg text-review px-3 py-2 rounded-btn text-table-cell">
              Couldn't load your scorecards, so a scorecard named in the file can't be checked.
              Leave that column empty and every call is scored against the active scorecard.
            </p>
          )}

          {fileProblem && (
            <p role="alert" className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
              {fileProblem}
            </p>
          )}

          {rows.length > 0 && !fileProblem && (
            <div>
              <p className="text-table-cell text-text-secondary mb-2">
                <span className="font-semibold text-text-primary">{ready.length} ready</span>
                {needFixing > 0 && (
                  <>
                    {' · '}
                    <span className="font-semibold text-fail">{needFixing} need fixing</span>
                  </>
                )}
              </p>
              <div className="border border-border rounded-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr>
                        {['Line', 'Recording', 'Adviser', 'Customer phone', 'Date', 'Check'].map((h) => (
                          <th
                            key={h}
                            className="text-left px-3 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.line} className="border-b border-border-light last:border-0">
                          <td className="px-3 py-2.5 text-table-cell text-text-muted tabular-nums">
                            {row.line}
                          </td>
                          <td className="px-3 py-2.5 text-table-cell text-text-cell">
                            <span className="block max-w-[220px] truncate" title={row.audio_url}>
                              {row.audio_url || '--'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-table-cell text-text-cell">
                            {row.agent_name || '--'}
                          </td>
                          <td className="px-3 py-2.5 text-table-cell text-text-cell whitespace-nowrap">
                            {row.customer_phone || '--'}
                          </td>
                          <td className="px-3 py-2.5 text-table-cell text-text-cell whitespace-nowrap">
                            {row.call_date || '--'}
                          </td>
                          <td className="px-3 py-2.5 text-table-cell">
                            {row.problem ? (
                              <span className="text-fail">{row.problem}</span>
                            ) : (
                              <span className="text-pass">Ready</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
              {error}
            </p>
          )}

          {result && (
            <div
              role="status"
              className="bg-primary-light border border-border rounded-card p-4 text-table-cell text-text-secondary"
            >
              <p className="font-semibold text-text-primary">
                {result.accepted === 1 ? '1 call queued' : `${result.accepted} calls queued`}
              </p>
              <p className="mt-1">
                Imports run in the background. The calls are in Calls now, and each moves into
                Processing as its recording is fetched.
              </p>
              {result.skipped > 0 && (
                <p className="mt-1">
                  {result.skipped === 1 ? '1 row was' : `${result.skipped} rows were`} skipped —
                  already on file under the same id.
                </p>
              )}
              {result.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-fail">
                  {result.errors.map((e) => (
                    <li key={e.row}>
                      Line {e.row}: {e.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-text-muted">
            {needFixing > 0
              ? `${needFixing === 1 ? '1 row' : `${needFixing} rows`} will be skipped until fixed.`
              : 'Nothing is sent until you press Import.'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-[18px] py-[9px] min-h-[44px] sm:min-h-0 rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={busy || ready.length === 0 || !!fileProblem}
              className="px-[18px] py-[9px] min-h-[44px] sm:min-h-0 rounded-btn text-table-cell font-semibold bg-primary-ink text-on-solid hover:bg-primary-ink-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {busy
                ? 'Queueing…'
                : ready.length === 0
                  ? 'Import'
                  : ready.length === 1
                    ? 'Import 1 call'
                    : `Import ${ready.length} calls`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
