import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { SeverityBadge, StatusBadge } from '../components/BreachBadges';
import { ItemResultBadge } from '../components/ItemResultBadge';
import { ReconciliationBadge, AmendmentBadge } from '../components/ReconciliationBadge';
import { formatDuration, formatPhone } from '../lib/format';
import { BREACH_CAVEAT_LABELS } from '@callguard/shared';
import type { ClaimsDefenceResponse } from '@callguard/shared';

// ============================================================
// Small shared pieces (mirrors BoardPack.tsx's local helpers — no shared
// Skeleton/Panel/ErrorBanner component yet, see DESIGN_SYSTEM.md §9).
// ============================================================

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded bg-[length:800px_100%] animate-skeleton-shimmer ${className}`}
      style={{
        backgroundImage:
          'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
      }}
    />
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
      {children}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-card overflow-hidden print:break-inside-avoid print:border-black/20">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-section-title text-text-primary">{title}</h3>
        {subtitle && <p className="text-xs text-text-subtle mt-0.5 leading-relaxed">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="print:break-inside-avoid">
      <div className="text-card-label uppercase text-text-muted">{label}</div>
      <div className="text-table-cell text-text-primary font-medium mt-1">{value}</div>
    </div>
  );
}

const TH = 'text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border';
const TD = 'px-5 py-3.5 text-table-cell text-text-cell';
const ROW = 'border-b border-border-light last:border-0 print:break-inside-avoid';

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-8 text-center text-text-muted text-table-cell">
        {children}
      </td>
    </tr>
  );
}

function EmptyBlock({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-8 text-center text-text-muted text-table-cell">{children}</div>;
}

function fmtScore(n: number | null): string {
  return n == null ? '--' : `${n.toFixed(1)}%`;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '--';
}

function fmtDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('en-GB') : '--';
}

function humanizeStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function evidenceLink(sourceCallId: string | null, sourceTimestamp: number | null): string | null {
  if (!sourceCallId) return null;
  return `/calls/${sourceCallId}${sourceTimestamp != null ? `?t=${Math.floor(sourceTimestamp)}` : ''}`;
}

// ============================================================
// Page
// ============================================================

/**
 * Per-sale evidence pack for a declined claim or a customer complaint: what
 * was said on the call, set against what was submitted, the AI's checkpoint
 * verdicts, the findings on top of them, and every human ruling. Audience is
 * a compliance officer, an insurer, or the Financial Ombudsman — this
 * document leaves the building.
 *
 * Print/PDF treatment mirrors BoardPack.tsx: a print-only header/footer and
 * print: utility classes throughout, rather than a separate server-rendered
 * document, because the on-screen chrome (nav, actions) must never appear in
 * the exported PDF.
 */
export function ClaimsDefence() {
  const { id } = useParams<{ id: string }>();

  const { data: p, isLoading, isError } = useQuery({
    queryKey: ['claims-defence', id],
    queryFn: () => api.get<ClaimsDefenceResponse>(`/journeys/${id}/claims-defence`),
    enabled: !!id,
  });

  const loading = isLoading;
  const handlePrint = () => window.print();

  return (
    <div>
      {/* ── Print-only header: customer, sale date, generated date, and a
          confidentiality line — visible only when this page is printed or
          saved as PDF, consistent with the breaches report's and board
          pack's wording, so the on-screen chrome never appears in the PDF. */}
      <div className="hidden print:block mb-6 pb-4 border-b-2 border-black/60 text-center">
        <div className="text-2xl font-bold text-text-primary">{p?.header.customer_name ?? 'Customer'}</div>
        <div className="text-sm text-text-secondary mt-1">CallGuard AI — Claims Defence Evidence Pack</div>
        <div className="text-sm text-text-secondary">Sale date: {p ? fmtDate(p.header.sale_date) : ''}</div>
        <div className="inline-block mt-3 px-3 py-1 border border-black/40 text-xs font-semibold uppercase tracking-wider">
          Confidential — insurer / Financial Ombudsman Service / compliance use
        </div>
        <div className="text-xs text-text-muted mt-2">
          Generated {p ? fmtDateTime(p.generated_at) : new Date().toLocaleString('en-GB')}
        </div>
      </div>

      {/* ── Screen header + actions (hidden on print) ───────────────────── */}
      <div className="print:hidden flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Claims-defence pack</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            What was said on this sale's calls, set against what was submitted to the insurer —
            evidence for a declined claim or a complaint.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/journeys/${id}`}
            className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold border border-border text-text-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Back to sale
          </Link>
          <button
            onClick={handlePrint}
            disabled={!p}
            aria-label="Print or save this claims-defence pack as a PDF"
            className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Print / Save as PDF
          </button>
        </div>
      </div>

      {isError && (
        <div className="print:hidden mb-5">
          <ErrorBanner>Could not load the claims-defence pack for this sale.</ErrorBanner>
        </div>
      )}

      <div className="space-y-6">
        {/* ── 1. Case summary (header) ────────────────────────────────── */}
        <Panel title="Case summary">
          {loading ? (
            <div className="p-5"><Skeleton className="h-20 w-full" /></div>
          ) : !p ? (
            <EmptyBlock>Nothing to show.</EmptyBlock>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-5 p-5">
              <Field label="Customer" value={p.header.customer_name ?? (p.header.customer_phone ? formatPhone(p.header.customer_phone) : '--')} />
              <Field label="Sale date" value={fmtDate(p.header.sale_date)} />
              <Field label="Adviser" value={p.header.adviser_name ?? '--'} />
              <Field
                label="Scorecard"
                value={p.header.scorecard_name ? `${p.header.scorecard_name} (v${p.header.scorecard_version})` : `v${p.header.scorecard_version}`}
              />
              <Field label="Status" value={humanizeStatus(p.header.status)} />
              <Field label="Overall score" value={fmtScore(p.header.overall_score)} />
              <Field
                label="Result"
                value={p.header.pass == null ? '--' : p.header.pass ? 'Pass' : 'Fail'}
              />
            </div>
          )}
        </Panel>

        {/* ── 2. Evidence basis ───────────────────────────────────────── */}
        <Panel title="Evidence basis" subtitle="The calls this verdict rests on.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr>
                  <th className={TH}>Date</th>
                  <th className={TH}>Role</th>
                  <th className={TH}>Duration</th>
                  <th className={TH}>Adviser</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={4} className="px-5 py-8"><Skeleton className="h-10 w-full" /></td></tr>
                ) : !p?.evidence_basis.length ? (
                  <EmptyRow colSpan={4}>No calls linked to this sale.</EmptyRow>
                ) : (
                  p.evidence_basis.map((c) => (
                    <tr key={c.id} className={ROW}>
                      <td className={TD}>{fmtDate(c.call_date)}</td>
                      <td className={TD}>
                        {c.role === 'wrap_up' ? (
                          <span className="text-pass font-semibold">Wrap-up</span>
                        ) : (
                          <span className="text-text-secondary">Context</span>
                        )}
                      </td>
                      <td className={`${TD} font-mono`}>{formatDuration(c.duration_seconds)}</td>
                      <td className={TD}>{c.agent_name ?? '--'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ── 3. Checkpoint results ───────────────────────────────────── */}
        <Panel
          title={`Checkpoint results${p ? ` (${p.checkpoints.length})` : ''}`}
          subtitle="Every checkpoint on the scorecard, including N/A and manual-review items — an omitted checkpoint would look like something hidden."
        >
          {loading ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : !p?.checkpoints.length ? (
            <EmptyBlock>No checkpoints have been scored on this sale.</EmptyBlock>
          ) : (
            <div>
              {p.checkpoints.map((item) => {
                const href = evidenceLink(item.source_call_id, item.source_timestamp);
                return (
                  <div key={item.id} className="border-b border-border-light last:border-0 px-5 py-3.5 print:break-inside-avoid">
                    <div className="flex justify-between items-start gap-4">
                      <div className="min-w-0 flex-1">
                        {item.section && (
                          <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-0.5">
                            {item.section}
                          </div>
                        )}
                        <div className="text-table-cell text-text-secondary">{item.label}</div>
                        {item.evidence && (
                          <blockquote className="text-xs text-text-muted italic border-l-2 border-border pl-2.5 mt-1.5 leading-relaxed">
                            {item.evidence}
                            {href && (
                              <Link to={href} className="not-italic ml-2 text-primary hover:underline print:hidden">
                                hear it in the call →
                              </Link>
                            )}
                          </blockquote>
                        )}
                        {item.reasoning && (
                          <p className="text-xs text-text-muted mt-1.5 leading-relaxed">{item.reasoning}</p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                        <ItemResultBadge result={item.result} />
                        {item.confidence != null && (
                          <span className="text-[11px] text-text-muted">
                            {(Number(item.confidence) * 100).toFixed(0)}% confidence
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* ── 4. Findings ─────────────────────────────────────────────── */}
        <Panel
          title={`Findings${p ? ` (${p.findings.length})` : ''}`}
          subtitle="Every finding on this sale, with why it may not be fully settled and who, if anyone, has confirmed it."
        >
          {loading ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : !p?.findings.length ? (
            <EmptyBlock>No findings on this sale.</EmptyBlock>
          ) : (
            <div>
              {p.findings.map((f) => (
                <div key={f.id} className="border-b border-border-light last:border-0 px-5 py-3.5 print:break-inside-avoid">
                  <div className="flex justify-between items-start gap-4 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="text-table-cell text-text-primary font-medium">{f.scorecard_item_label}</div>
                      <div className="text-xs text-text-muted mt-1">Detected {fmtDate(f.detected_at)}</div>
                      {f.confirmed_at ? (
                        <div className="text-xs text-pass mt-1.5">
                          Confirmed by {f.confirmed_by_name ?? 'a reviewer'} on {fmtDate(f.confirmed_at)}
                        </div>
                      ) : (
                        <div className="text-xs text-text-muted mt-1.5">Not yet confirmed by a person</div>
                      )}
                      {f.evidence_caveats.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5 list-disc list-outside ml-4">
                          {f.evidence_caveats.map((c) => (
                            <li key={c} className="text-xs text-review leading-relaxed">
                              {BREACH_CAVEAT_LABELS[c] ?? c}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                      <SeverityBadge severity={f.severity} />
                      <StatusBadge status={f.status} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* ── 5. Said versus submitted ────────────────────────────────── */}
        <Panel
          title="Said versus submitted"
          subtitle="What the customer said on the call, against what the insurer's application recorded."
        >
          {loading ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : !p?.reconciliation ? (
            <EmptyBlock>
              This sale has no reconciliation run — no application document has been matched to it,
              or the reconciliation module is not in use for this organisation.
            </EmptyBlock>
          ) : !p.reconciliation.items.length ? (
            <EmptyBlock>No questions were found on the application document.</EmptyBlock>
          ) : (
            <div>
              <div className="px-5 py-2.5 bg-table-header text-xs text-text-muted">
                Parsed {p.reconciliation.extraction_method === 'profile' ? 'deterministically from a stored document profile' : 'by direct model reading (provisional, no stored profile for this document yet)'}
                {p.reconciliation.completed_at ? ` · completed ${fmtDate(p.reconciliation.completed_at)}` : ''}.
              </div>
              {p.reconciliation.items.map((item) => {
                const href = evidenceLink(item.source_call_id, item.source_timestamp);
                return (
                  <div key={item.id} className="px-5 py-3.5 border-b border-border-light last:border-0 print:break-inside-avoid">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="text-table-cell text-text-primary font-medium">{item.question}</div>
                        <div className="mt-1.5 flex flex-col gap-1 text-table-cell">
                          <div className="text-text-secondary">
                            Application:{' '}
                            {item.application_answer ? (
                              <strong className="text-text-primary">{item.application_answer}</strong>
                            ) : (
                              <span className="text-text-muted italic">no answer recorded</span>
                            )}
                          </div>
                          <div className="text-text-secondary">
                            On the call:{' '}
                            {item.call_answer ? (
                              <strong className="text-text-primary">{item.call_answer}</strong>
                            ) : item.call_answer_redacted ? (
                              <span className="text-text-muted italic">answered — value not stored (personal data)</span>
                            ) : (
                              <span className="text-text-muted italic">not found</span>
                            )}
                          </div>
                        </div>

                        {/* The insurer's own audit trail, given real prominence: an
                            answer amended on their portal after the call is a
                            defence signal that comes from their document, not
                            from this system's model. */}
                        {item.answer_amended && (
                          <div
                            className={`mt-2 px-3 py-2 rounded-btn text-xs leading-relaxed ${
                              item.amendment_type === 'disclosure_withdrawn' ? 'bg-fail-bg text-fail' : 'bg-review-bg text-review'
                            }`}
                          >
                            <span className="font-semibold">This answer was amended on the insurer's own application after it was first entered.</span>{' '}
                            {item.revisions.length > 0 && (
                              <span>
                                {item.revisions.map((r, i) => (
                                  <span key={i}>
                                    &ldquo;{r.value}&rdquo;
                                    {r.timestamp ? ` (${r.timestamp})` : ''}
                                    {' → '}
                                  </span>
                                ))}
                                &ldquo;{item.application_answer ?? '—'}&rdquo;
                              </span>
                            )}
                          </div>
                        )}

                        {item.evidence && (
                          <blockquote className="text-xs text-text-muted italic border-l-2 border-border pl-2.5 mt-1.5 leading-relaxed">
                            {item.evidence}
                            {href && (
                              <Link to={href} className="not-italic ml-2 text-primary hover:underline print:hidden">
                                hear it in the call →
                              </Link>
                            )}
                          </blockquote>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                        <ReconciliationBadge outcome={item.outcome} />
                        {item.amendment_type && <AmendmentBadge type={item.amendment_type} />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* ── 6. Human review trail ───────────────────────────────────── */}
        <Panel
          title="Human review trail"
          subtitle="Every checkpoint a person ruled on, distinguishing the AI declining to decide from a person overturning a confident AI verdict."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className={TH}>Checkpoint</th>
                  <th className={TH}>Who</th>
                  <th className={TH}>When</th>
                  <th className={TH}>AI verdict</th>
                  <th className={TH}>Human verdict</th>
                  <th className={TH}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="px-5 py-8"><Skeleton className="h-10 w-full" /></td></tr>
                ) : !p?.human_review.length ? (
                  <EmptyRow colSpan={6}>No person has ruled on any checkpoint for this sale.</EmptyRow>
                ) : (
                  p.human_review.map((c) => (
                    <tr key={c.id} className={ROW}>
                      <td className={TD}>{c.scorecard_item_label}</td>
                      <td className={TD}>{c.corrected_by_name ?? '--'}</td>
                      <td className={`${TD} text-text-muted`}>{fmtDate(c.created_at)}</td>
                      <td className={TD}>
                        {c.original_pass == null ? (
                          <span className="text-review">Could not decide</span>
                        ) : c.original_pass ? (
                          <span className="text-pass">Pass</span>
                        ) : (
                          <span className="text-fail">Fail</span>
                        )}
                      </td>
                      <td className={TD}>{c.corrected_pass ? <span className="text-pass">Pass</span> : <span className="text-fail">Fail</span>}</td>
                      <td className={`${TD} text-text-muted`}>{c.reason ?? '--'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ── 7. Limitations ──────────────────────────────────────────── */}
        <Panel title="Limitations" subtitle="Read alongside the sections above, not as small print.">
          {loading ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : (
            <ul className="px-5 py-4 space-y-3 text-table-cell text-text-cell leading-relaxed list-disc list-outside ml-4">
              {p?.limitations.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
        </Panel>
      </div>

      {/* ── Print-only footer ───────────────────────────────────────────── */}
      <div className="hidden print:block mt-8 pt-3 border-t border-black/30 text-xs text-text-muted text-center">
        Generated by CallGuard AI on {p ? fmtDateTime(p.generated_at) : new Date().toLocaleString('en-GB')}.
        This document is confidential and intended solely for the recipient's use in assessing this claim or complaint.
      </div>

      {/* Print layout: A4, sensible margins, repeating table headers, and no
          orphaned card/row/table fragments across a page break. */}
      <style>{`
        @media print {
          @page { size: A4; margin: 15mm 12mm; }
          thead { display: table-header-group; }
          tr { break-inside: avoid; }
        }
      `}</style>

      <div className="print:hidden mt-6 text-xs text-text-muted">
        <Link
          to={`/journeys/${id}`}
          className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-btn"
        >
          Back to sale
        </Link>
      </div>
    </div>
  );
}
