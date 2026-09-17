import { useEffect, useRef, useState } from 'react';
import {
  previewScorecardCsv,
  readyItems,
  scorecardTemplateCsv,
  downloadCsv,
  CSV_COLUMNS,
  type ImportPreview,
  type ItemForm,
} from '../lib/scorecard-csv';

interface ScorecardImportDrawerProps {
  /** How many real checkpoints the scorecard has now — named in both choices. */
  existingCount: number;
  onApply: (items: ItemForm[], mode: 'replace' | 'append', branches: string[]) => void;
  onClose: () => void;
}

const primaryBtn =
  'px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-on-solid hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const secondaryBtn =
  'px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Bringing a QA manual in from a CSV, as its own step.
 *
 * Reading the file changes nothing. It shows every line with its own number and
 * its own check, says how many are ready and how many need fixing, and makes
 * "replace everything" versus "add to what's here" an explicit choice — the
 * whole point being that nothing happens until the button that names the count
 * is pressed.
 */
export function ScorecardImportDrawer({ existingCount, onApply, onClose }: ScorecardImportDrawerProps) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [readError, setReadError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const readFile = (file: File) => {
    setReading(true);
    setReadError('');
    const reader = new FileReader();
    reader.onerror = () => {
      setReadError('That file could not be read. Try saving it again as CSV.');
      setReading(false);
    };
    reader.onload = (event) => {
      setFileName(file.name);
      setPreview(previewScorecardCsv((event.target?.result as string) ?? ''));
      setReading(false);
    };
    reader.readAsText(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const ready = preview ? readyItems(preview) : [];
  const canApply = ready.length > 0;
  // With nothing here yet, "replace" and "add" are the same act, so there is no
  // choice to make and the button says the plain thing instead.
  const hasChoice = existingCount > 0;
  const applyLabel = !hasChoice
    ? `Import ${plural(ready.length, 'checkpoint', 'checkpoints')}`
    : mode === 'replace'
      ? `Replace with ${plural(ready.length, 'checkpoint', 'checkpoints')}`
      : `Add ${plural(ready.length, 'checkpoint', 'checkpoints')}`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="relative bg-card border-l border-border w-full max-w-2xl h-full overflow-y-auto shadow-lg">
        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="import-title" className="text-section-title text-text-primary">
              Import checkpoints from a CSV
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              Nothing changes until you press the button at the bottom.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close import"
            className="w-10 h-10 rounded-full hover:bg-sidebar-hover flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-text-secondary" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Choose or drop */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-card border-2 border-dashed p-6 text-center transition-colors ${
              dragging ? 'border-primary bg-primary-light' : 'border-border'
            }`}
          >
            <p className="text-table-cell text-text-secondary">
              Drop a CSV here, or choose one.
            </p>
            <input
              ref={fileInputRef}
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readFile(file);
                e.target.value = '';
              }}
            />
            <div className="flex flex-wrap items-center justify-center gap-3 mt-3">
              <button type="button" onClick={() => fileInputRef.current?.click()} className={secondaryBtn}>
                Choose a file
              </button>
              <button
                type="button"
                onClick={() => downloadCsv('callguard-scorecard-template.csv', scorecardTemplateCsv())}
                className="text-table-cell text-primary-ink font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
              >
                Download the template
              </button>
            </div>
            <p className="text-xs text-text-muted mt-3">
              Columns: {CSV_COLUMNS.join(', ')}. Only <code>label</code> is required.
            </p>
          </div>

          {reading && (
            <p className="text-table-cell text-text-muted" aria-live="polite">
              Reading {fileName || 'the file'}…
            </p>
          )}

          {readError && (
            <div role="alert" className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell">
              {readError}
            </div>
          )}

          {preview?.fatal && (
            <div role="alert" className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell">
              {preview.fatal}
            </div>
          )}

          {preview && !preview.fatal && (
            <>
              <div aria-live="polite">
                <p className="text-table-cell text-text-primary font-semibold">
                  {fileName}
                </p>
                <p className="text-table-cell text-text-secondary mt-0.5">
                  {plural(preview.readyCount, 'ready', 'ready')}
                  {preview.problemCount > 0 ? ` · ${preview.problemCount} need fixing` : ''}
                </p>
              </div>

              {hasChoice && (
              <fieldset className="space-y-2">
                <legend className="text-table-header uppercase text-text-muted mb-2">
                  What to do with the {plural(existingCount, 'checkpoint', 'checkpoints')} already here
                </legend>
                <label htmlFor="import-mode-replace" className="flex items-start gap-3 min-h-[32px] py-1 cursor-pointer">
                  <input
                    id="import-mode-replace"
                    type="radio"
                    name="import-mode"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                    className="w-5 h-5 mt-0.5 accent-primary shrink-0"
                  />
                  <span className="text-table-cell text-text-secondary">
                    <span className="block text-text-primary font-medium">
                      Replace all {existingCount}
                    </span>
                    The weights, severities, rubrics and remediation guidance on the current
                    checkpoints are lost. Sales already scored keep their results.
                  </span>
                </label>
                <label htmlFor="import-mode-append" className="flex items-start gap-3 min-h-[32px] py-1 cursor-pointer">
                  <input
                    id="import-mode-append"
                    type="radio"
                    name="import-mode"
                    checked={mode === 'append'}
                    onChange={() => setMode('append')}
                    className="w-5 h-5 mt-0.5 accent-primary shrink-0"
                  />
                  <span className="text-table-cell text-text-secondary">
                    <span className="block text-text-primary font-medium">
                      Add to the {existingCount} already here
                    </span>
                    The file&rsquo;s checkpoints go on the end. Nothing here is changed.
                  </span>
                </label>
              </fieldset>
              )}

              <div className="bg-card border border-border rounded-card overflow-hidden">
                <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className="text-left px-4 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border w-16">Line</th>
                        <th className="text-left px-4 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Checkpoint</th>
                        <th className="text-left px-4 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.line} className="border-b border-border-light last:border-0">
                          <td className="px-4 py-3 text-table-cell text-text-muted tabular-nums align-top">{row.line}</td>
                          <td className="px-4 py-3 text-table-cell text-text-cell align-top">
                            {row.item.label || <span className="text-text-muted italic">—</span>}
                            {row.item.section && (
                              <span className="block text-xs text-text-muted mt-0.5">{row.item.section}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-table-cell align-top">
                            {row.ready ? (
                              <span className="inline-flex items-center gap-1.5 text-pass">
                                <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>{row.notes.join(' ')}</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-start gap-1.5 text-fail">
                                <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <circle cx="12" cy="12" r="9" />
                                  <line x1="12" y1="8" x2="12" y2="13" />
                                  <line x1="12" y1="16" x2="12" y2="16" />
                                </svg>
                                <span>{row.notes.join(' ')}</span>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {preview.problemCount > 0 && (
                <p className="text-xs text-text-muted">
                  Lines that need fixing are left out. Correct them in your spreadsheet and import again.
                </p>
              )}
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-card border-t border-border px-5 py-4 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => preview && onApply(ready, mode, preview.branches)}
            className={primaryBtn}
          >
            {canApply ? applyLabel : 'Nothing to import yet'}
          </button>
        </div>
      </div>
    </div>
  );
}
