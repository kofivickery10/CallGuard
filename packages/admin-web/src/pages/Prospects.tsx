import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useDialog } from '../components/DialogProvider';

// CallGuard's own sales pipeline (migration 102): UK protection/mortgage
// intermediaries shaped like Trust Point, the existing client. This is not a
// CRM — firm, status, note, dates. No activity timelines, task reminders,
// email sequences or multi-user assignment.
//
// THE CTPS CONTROL
// Cold-calling a UK business without first screening it against the
// Corporate Telephone Preference Service breaches PECR — a specific
// embarrassment for a company selling FCA compliance tooling. ctps_screened_at
// is the record of that check. Wherever a phone number could be dialled from
// this page, it is gated on that field: NULL renders an explicit "not
// screened" state with no tel: link and no call affordance, never a colour-
// only cue.

const PROSPECT_STATUSES = ['new', 'qualified', 'contacted', 'engaged', 'won', 'lost'] as const;
const PROSPECT_SOURCES = ['directory', 'vendor_case_study', 'referral', 'manual'] as const;
type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
type ProspectSource = (typeof PROSPECT_SOURCES)[number];

const STATUS_LABELS: Record<ProspectStatus, string> = {
  new: 'New',
  qualified: 'Qualified',
  contacted: 'Contacted',
  engaged: 'Engaged',
  won: 'Won',
  lost: 'Lost',
};

const STATUS_STYLES: Record<ProspectStatus, string> = {
  new: 'bg-processing-bg text-processing',
  qualified: 'bg-review-bg text-review',
  contacted: 'bg-review-bg text-review',
  engaged: 'bg-processing-bg text-processing',
  won: 'bg-pass-bg text-pass',
  lost: 'bg-fail-bg text-fail',
};

const SOURCE_LABELS: Record<ProspectSource, string> = {
  directory: 'Directory',
  vendor_case_study: 'Vendor case study',
  referral: 'Referral',
  manual: 'Manual',
};

interface Prospect {
  id: string;
  firm_name: string;
  frn: string | null;
  fca_status: string | null;
  permissions: string[];
  adviser_count_band: string | null;
  source: string;
  fit_score: number | null;
  status: string;
  note: string | null;
  website: string | null;
  main_phone: string | null;
  registered_address: string | null;
  last_contacted_at: string | null;
  ctps_screened_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ImportResult {
  imported: number;
  updated: number;
  skipped: { row: number; reason: string }[];
}

function ShieldIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9.5 12l1.8 1.8L14.5 10" />
    </svg>
  );
}

function AlertIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4l9 16H3l9-16z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function PhoneIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2C10.5 21 3 13.5 3 6a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function UploadIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function DownloadIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </svg>
  );
}

const inputCls =
  'w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary disabled:opacity-60 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const labelCls = 'block text-xs font-medium text-text-muted mb-1';
const primaryBtn =
  'px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const secondaryBtn =
  'px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

function skeletonBar(width: string) {
  return (
    <div
      className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
      style={{
        backgroundImage:
          'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
        width,
      }}
    />
  );
}

const BLANK_FORM = {
  firm_name: '',
  frn: '',
  fca_status: '',
  permissions: '',
  adviser_count_band: '',
  source: 'manual' as ProspectSource,
  fit_score: '',
  status: 'new' as ProspectStatus,
  note: '',
  website: '',
  main_phone: '',
  registered_address: '',
  last_contacted_at: '',
  ctps_screened_at: '',
};
type ProspectForm = typeof BLANK_FORM;

function toFormState(p: Prospect): ProspectForm {
  return {
    firm_name: p.firm_name,
    frn: p.frn ?? '',
    fca_status: p.fca_status ?? '',
    permissions: (p.permissions ?? []).join('; '),
    adviser_count_band: p.adviser_count_band ?? '',
    source: (p.source as ProspectSource) ?? 'manual',
    fit_score: p.fit_score == null ? '' : String(p.fit_score),
    status: (p.status as ProspectStatus) ?? 'new',
    note: p.note ?? '',
    website: p.website ?? '',
    main_phone: p.main_phone ?? '',
    registered_address: p.registered_address ?? '',
    last_contacted_at: p.last_contacted_at ? p.last_contacted_at.slice(0, 10) : '',
    ctps_screened_at: p.ctps_screened_at ?? '',
  };
}

function formToPayload(f: ProspectForm) {
  return {
    firm_name: f.firm_name.trim(),
    frn: f.frn.trim() || null,
    fca_status: f.fca_status.trim() || null,
    permissions: f.permissions.split(';').map((p) => p.trim()).filter(Boolean),
    adviser_count_band: f.adviser_count_band.trim() || null,
    source: f.source,
    fit_score: f.fit_score.trim() === '' ? null : Number(f.fit_score),
    status: f.status,
    note: f.note.trim() || null,
    website: f.website.trim() || null,
    main_phone: f.main_phone.trim() || null,
    registered_address: f.registered_address.trim() || null,
    last_contacted_at: f.last_contacted_at || null,
    ctps_screened_at: f.ctps_screened_at || null,
  };
}

export default function Prospects() {
  const { confirm, notify } = useDialog();
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [statusSaving, setStatusSaving] = useState<string | null>(null);
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Prospect | null>(null);
  const [form, setForm] = useState<ProspectForm>(BLANK_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError('');
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (search.trim()) params.set('q', search.trim());
    const qs = params.toString();
    api.get<{ prospects: Prospect[] }>(`/superadmin/prospects${qs ? `?${qs}` : ''}`)
      .then((r) => setProspects(r.prospects))
      .catch((e: Error) => setError(e.message));
  }, [statusFilter, search]);

  useEffect(() => { load(); }, [load]);

  const changeStatus = async (p: Prospect, status: string) => {
    setStatusSaving(p.id);
    try {
      const updated = await api.put<Prospect>(`/superadmin/prospects/${p.id}`, { status });
      setProspects((prev) => prev?.map((x) => (x.id === p.id ? updated : x)) ?? prev);
    } catch (e) {
      await notify(e instanceof Error ? e.message : 'Failed to update status');
    } finally {
      setStatusSaving(null);
    }
  };

  const startNoteEdit = (p: Prospect) => {
    setNoteEditingId(p.id);
    setNoteDraft(p.note ?? '');
  };

  const saveNote = async (p: Prospect) => {
    setNoteSaving(true);
    try {
      const updated = await api.put<Prospect>(`/superadmin/prospects/${p.id}`, { note: noteDraft.trim() || null });
      setProspects((prev) => prev?.map((x) => (x.id === p.id ? updated : x)) ?? prev);
      setNoteEditingId(null);
    } catch (e) {
      await notify(e instanceof Error ? e.message : 'Failed to save note');
    } finally {
      setNoteSaving(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(BLANK_FORM);
    setFormError('');
    setModalOpen(true);
  };

  const openEdit = (p: Prospect) => {
    setEditing(p);
    setForm(toFormState(p));
    setFormError('');
    setModalOpen(true);
  };

  const saveProspect = async () => {
    if (!form.firm_name.trim()) { setFormError('Firm name is required'); return; }
    setSaving(true); setFormError('');
    try {
      const payload = formToPayload(form);
      if (editing) {
        const updated = await api.put<Prospect>(`/superadmin/prospects/${editing.id}`, payload);
        setProspects((prev) => prev?.map((x) => (x.id === editing.id ? updated : x)) ?? prev);
      } else {
        const created = await api.post<Prospect>('/superadmin/prospects', payload);
        setProspects((prev) => (prev ? [created, ...prev] : [created]));
      }
      setModalOpen(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to save prospect');
    } finally {
      setSaving(false);
    }
  };

  const deleteProspect = async (p: Prospect) => {
    if (!(await confirm(`Remove "${p.firm_name}" from the pipeline? This cannot be undone.`, { danger: true }))) return;
    try {
      await api.delete(`/superadmin/prospects/${p.id}`);
      setProspects((prev) => prev?.filter((x) => x.id !== p.id) ?? prev);
    } catch (e) {
      await notify(e instanceof Error ? e.message : 'Failed to delete prospect');
    }
  };

  const triggerImport = () => fileInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true); setImportResult(null);
    try {
      const csv = await file.text();
      const result = await api.post<ImportResult>('/superadmin/prospects/import', { csv });
      setImportResult(result);
      load();
    } catch (err) {
      await notify(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const qs = params.toString();
      await api.download(
        `/superadmin/prospects/export.csv${qs ? `?${qs}` : ''}`,
        `callguard-prospects-${new Date().toISOString().slice(0, 10)}.csv`
      );
    } catch (e) {
      await notify(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const rows = prospects ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between mb-1 gap-3 flex-wrap">
        <div>
          <h2 className="text-page-title text-text-primary">Prospects</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            CallGuard's own sales pipeline — UK protection and mortgage intermediaries. Not a CRM.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleImportFile}
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            onClick={triggerImport}
            disabled={importing}
            aria-label="Import prospects from CSV"
            className={`${secondaryBtn} inline-flex items-center gap-1.5`}
          >
            <UploadIcon />
            {importing ? 'Importing…' : 'Import CSV'}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            aria-label="Export prospects to CSV"
            className={`${secondaryBtn} inline-flex items-center gap-1.5`}
          >
            <DownloadIcon />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button type="button" onClick={openCreate} className={primaryBtn}>
            + New prospect
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-card border border-border rounded-card p-4 grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-3">
        <div>
          <label htmlFor="prospect-status-filter" className={labelCls}>Status</label>
          <select
            id="prospect-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={inputCls}
          >
            <option value="">All statuses</option>
            {PROSPECT_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="prospect-search" className={labelCls}>Search</label>
          <input
            id="prospect-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Firm name, FRN or website…"
            className={inputCls}
          />
        </div>
      </div>

      {error && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-sm" role="alert">{error}</div>
      )}

      {/* Table */}
      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead>
              <tr>
                {['Firm', 'FRN', 'Status', 'Fit', 'Source', 'Phone / CTPS', 'Last contacted', 'Note', ''].map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prospects === null &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-border-light last:border-0">
                    {Array.from({ length: 9 }).map((__, j) => (
                      <td key={j} className="px-5 py-3.5">{skeletonBar(j === 0 ? '70%' : '50%')}</td>
                    ))}
                  </tr>
                ))}

              {prospects !== null && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-text-muted text-table-cell">
                    {prospects.length === 0 && !statusFilter && !search
                      ? 'No prospects yet — add one, or import a CSV.'
                      : 'No prospects match your filters.'}
                  </td>
                </tr>
              )}

              {rows.map((p) => {
                const screened = !!p.ctps_screened_at;
                return (
                  <tr key={p.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0 align-top">
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-text-primary">{p.firm_name}</div>
                      {p.fca_status && <div className="text-xs text-text-muted mt-0.5">{p.fca_status}</div>}
                      {p.website && (
                        <a
                          href={p.website.startsWith('http') ? p.website : `https://${p.website}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-xs text-primary hover:underline"
                        >
                          {p.website}
                        </a>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-table-cell text-text-cell font-mono">{p.frn || '—'}</td>
                    <td className="px-5 py-3.5">
                      <select
                        aria-label={`Pipeline status for ${p.firm_name}`}
                        value={p.status}
                        disabled={statusSaving === p.id}
                        onChange={(e) => changeStatus(p, e.target.value)}
                        className={`text-badge font-semibold px-2 py-1 rounded-btn border border-border disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${STATUS_STYLES[p.status as ProspectStatus] ?? ''}`}
                      >
                        {PROSPECT_STATUSES.map((s) => (
                          <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-5 py-3.5 text-table-cell text-text-cell">{p.fit_score ?? '—'}</td>
                    <td className="px-5 py-3.5 text-table-cell text-text-secondary">
                      {SOURCE_LABELS[p.source as ProspectSource] ?? p.source}
                    </td>
                    <td className="px-5 py-3.5">
                      {p.main_phone ? (
                        screened ? (
                          <a
                            href={`tel:${p.main_phone.replace(/\s+/g, '')}`}
                            className="inline-flex items-center gap-1.5 text-primary hover:underline text-table-cell"
                            aria-label={`Call ${p.firm_name} on ${p.main_phone} — CTPS screened`}
                          >
                            <PhoneIcon className="w-3.5 h-3.5" />
                            {p.main_phone}
                          </a>
                        ) : (
                          <span className="text-table-cell text-text-cell">{p.main_phone}</span>
                        )
                      ) : (
                        <span className="text-table-cell text-text-muted">No number on file</span>
                      )}
                      <div className={`mt-1 inline-flex items-center gap-1 text-badge font-semibold px-2 py-[3px] rounded-full ${screened ? 'bg-pass-bg text-pass' : 'bg-review-bg text-review'}`}>
                        {screened ? <ShieldIcon className="w-3 h-3" /> : <AlertIcon className="w-3 h-3" />}
                        {screened
                          ? `CTPS screened ${new Date(p.ctps_screened_at!).toLocaleDateString('en-GB')}`
                          : 'Not screened — do not call (PECR)'}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-table-cell text-text-muted whitespace-nowrap">
                      {p.last_contacted_at ? new Date(p.last_contacted_at).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="px-5 py-3.5 min-w-[220px]">
                      {noteEditingId === p.id ? (
                        <div className="space-y-1.5">
                          <label htmlFor={`note-${p.id}`} className="sr-only">Note for {p.firm_name}</label>
                          <textarea
                            id={`note-${p.id}`}
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            rows={2}
                            autoFocus
                            disabled={noteSaving}
                            className={inputCls}
                          />
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => saveNote(p)}
                              disabled={noteSaving}
                              className="px-2.5 py-1 rounded-btn text-xs font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                              {noteSaving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setNoteEditingId(null)}
                              disabled={noteSaving}
                              className="px-2.5 py-1 rounded-btn text-xs font-semibold border border-border text-text-secondary hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startNoteEdit(p)}
                          aria-label={p.note ? `Edit note for ${p.firm_name}` : `Add note for ${p.firm_name}`}
                          className="text-left text-table-cell text-text-secondary hover:text-text-primary rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 whitespace-pre-wrap"
                        >
                          {p.note || <span className="text-text-muted italic">Add note…</span>}
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => openEdit(p)} className="text-primary hover:underline text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteProspect(p)}
                          aria-label={`Delete ${p.firm_name}`}
                          className="text-fail hover:underline text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {prospects !== null && (
          <div className="px-5 py-2.5 border-t border-border text-xs text-text-muted">
            {rows.length} prospect{rows.length === 1 ? '' : 's'}
          </div>
        )}
      </div>

      {/* Create / edit modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prospect-modal-title"
          onKeyDown={(e) => { if (e.key === 'Escape') setModalOpen(false); }}
        >
          <div className="relative bg-card border border-border rounded-card shadow-lg w-full max-w-2xl p-6 space-y-4 my-8">
            <h3 id="prospect-modal-title" className="text-lg font-semibold text-text-primary">
              {editing ? `Edit ${editing.firm_name}` : 'New prospect'}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="pf-firm-name" className={labelCls}>Firm name *</label>
                <input id="pf-firm-name" type="text" autoFocus value={form.firm_name} onChange={(e) => setForm({ ...form, firm_name: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-frn" className={labelCls}>FRN</label>
                <input id="pf-frn" type="text" value={form.frn} onChange={(e) => setForm({ ...form, frn: e.target.value })} placeholder="e.g. 123456" className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-fca-status" className={labelCls}>FCA authorisation status</label>
                <input id="pf-fca-status" type="text" value={form.fca_status} onChange={(e) => setForm({ ...form, fca_status: e.target.value })} placeholder="e.g. Authorised" className={inputCls} />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="pf-permissions" className={labelCls}>Regulated permissions (semicolon-separated)</label>
                <input id="pf-permissions" type="text" value={form.permissions} onChange={(e) => setForm({ ...form, permissions: e.target.value })} placeholder="advising on investments; arranging deals" className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-adviser-band" className={labelCls}>Adviser count band</label>
                <input id="pf-adviser-band" type="text" value={form.adviser_count_band} onChange={(e) => setForm({ ...form, adviser_count_band: e.target.value })} placeholder="e.g. 6-20" className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-fit-score" className={labelCls}>Fit score (0-100)</label>
                <input id="pf-fit-score" type="number" min={0} max={100} value={form.fit_score} onChange={(e) => setForm({ ...form, fit_score: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-source" className={labelCls}>Source</label>
                <select id="pf-source" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as ProspectSource })} className={inputCls}>
                  {PROSPECT_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pf-status" className={labelCls}>Pipeline status</label>
                <select id="pf-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ProspectStatus })} className={inputCls}>
                  {PROSPECT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pf-website" className={labelCls}>Website</label>
                <input id="pf-website" type="text" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-phone" className={labelCls}>Switchboard number</label>
                <input id="pf-phone" type="text" value={form.main_phone} onChange={(e) => setForm({ ...form, main_phone: e.target.value })} placeholder="Company number — never a personal mobile" className={inputCls} />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="pf-address" className={labelCls}>Registered address</label>
                <input id="pf-address" type="text" value={form.registered_address} onChange={(e) => setForm({ ...form, registered_address: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-last-contacted" className={labelCls}>Last contacted</label>
                <input id="pf-last-contacted" type="date" value={form.last_contacted_at} onChange={(e) => setForm({ ...form, last_contacted_at: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label htmlFor="pf-ctps" className={labelCls}>
                  CTPS screened
                  <span className="block text-[11px] font-normal text-text-muted normal-case">
                    Set only once the switchboard number has actually been checked against the Corporate TPS.
                  </span>
                </label>
                <div className="flex gap-2">
                  <input
                    id="pf-ctps"
                    type="datetime-local"
                    value={form.ctps_screened_at ? form.ctps_screened_at.slice(0, 16) : ''}
                    onChange={(e) => setForm({ ...form, ctps_screened_at: e.target.value ? new Date(e.target.value).toISOString() : '' })}
                    className={inputCls}
                  />
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, ctps_screened_at: new Date().toISOString() })}
                    className="px-3 py-2 rounded-btn border border-border text-xs font-semibold text-text-secondary hover:bg-sidebar-hover whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    Now
                  </button>
                </div>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="pf-note" className={labelCls}>Note</label>
                <textarea id="pf-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={3} className={inputCls} />
              </div>
            </div>

            {formError && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-sm" role="alert">{formError}</div>}

            <div className="flex justify-end gap-3 pt-1">
              <button type="button" onClick={() => setModalOpen(false)} disabled={saving} className={secondaryBtn}>
                Cancel
              </button>
              <button type="button" onClick={saveProspect} disabled={saving || !form.firm_name.trim()} className={primaryBtn}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Add prospect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import result */}
      {importResult && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-result-title"
          onKeyDown={(e) => { if (e.key === 'Escape') setImportResult(null); }}
        >
          <div className="relative bg-card border border-border rounded-card shadow-lg w-full max-w-lg p-6 space-y-4 my-8">
            <h3 id="import-result-title" className="text-lg font-semibold text-text-primary">Import complete</h3>
            <div className="flex gap-4 text-sm">
              <span className="text-pass font-semibold">{importResult.imported} added</span>
              <span className="text-processing font-semibold">{importResult.updated} updated</span>
              <span className="text-review font-semibold">{importResult.skipped.length} skipped</span>
            </div>
            {importResult.skipped.length > 0 && (
              <div className="border border-border rounded-btn max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-table-header border-b border-border">
                    <tr>
                      <th className="text-left px-3 py-2 text-table-header uppercase text-text-muted">Row</th>
                      <th className="text-left px-3 py-2 text-table-header uppercase text-text-muted">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.skipped.map((s, i) => (
                      <tr key={i} className="border-b border-border-light last:border-0">
                        <td className="px-3 py-2 text-text-secondary align-top">{s.row}</td>
                        <td className="px-3 py-2 text-text-secondary">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end pt-1">
              <button type="button" onClick={() => setImportResult(null)} className={primaryBtn}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
