import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface AuditEvent {
  id: string;
  organization_id: string;
  org_name: string | null;
  user_email: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  ip_address: string | null;
  created_at: string;
}

const PAGE_SIZE = 100;

// Actions that touch billing, access or tenant lifecycle — worth highlighting.
const SENSITIVE = new Set([
  'tenant.impersonate', 'tenant.create', 'tenant.status_change',
  'tenant.seat_price', 'tenant.feature_override', 'plan.change',
  'api_key.create', 'api_key.revoke', 'user.delete', 'user.role_change',
]);

export default function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback((reset: boolean) => {
    const nextOffset = reset ? 0 : offset;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
    if (action) params.set('action_type', action);
    if (from) params.set('from', from);
    // Send the plain date — the API treats `to` as a whole inclusive day
    // (exclusive bound at the next day's start), so no client-side time
    // needs appending here.
    if (to) params.set('to', to);
    setLoading(true);
    api.get<{ events: AuditEvent[] }>(`/superadmin/audit?${params.toString()}`)
      .then((r) => {
        setEvents((prev) => (reset ? r.events : [...prev, ...r.events]));
        setHasMore(r.events.length === PAGE_SIZE);
        setOffset(nextOffset + r.events.length);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [action, from, to, offset]);

  // Reload from the top whenever a filter changes.
  useEffect(() => { load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [action, from, to]);

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold text-text-primary">Audit Log</h1>
      <p className="text-page-sub text-text-subtle">Every recorded action across all tenants, newest first.</p>

      <div className="flex flex-wrap gap-3 items-end bg-card border border-border rounded-card p-4">
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Action</label>
          <input
            type="text"
            value={action}
            onChange={(e) => setAction(e.target.value.trim())}
            placeholder="e.g. plan.change"
            className="border border-border rounded-btn px-3 py-2 text-sm w-52"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-border rounded-btn px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-border rounded-btn px-3 py-2 text-sm" />
        </div>
        {(action || from || to) && (
          <button onClick={() => { setAction(''); setFrom(''); setTo(''); }} className="text-sm text-primary hover:underline pb-2">Clear</button>
        )}
      </div>

      {error && <p className="text-fail text-sm">{error}</p>}

      <div className="bg-card rounded-card border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-table-header border-b border-border">
            <tr>
              {['When', 'Tenant', 'Actor', 'Action', 'Detail', 'IP'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-table-header uppercase text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.map((e) => (
              <tr key={e.id} className="hover:bg-sidebar-hover align-top">
                <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{new Date(e.created_at).toLocaleString('en-GB')}</td>
                <td className="px-4 py-2.5">
                  {e.org_name
                    ? <Link to={`/tenants/${e.organization_id}`} className="text-primary hover:underline">{e.org_name}</Link>
                    : <span className="text-text-muted">—</span>}
                </td>
                <td className="px-4 py-2.5 text-text-secondary">{e.user_email ?? 'system'}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-badge px-2 py-0.5 rounded font-mono ${SENSITIVE.has(e.action_type) ? 'bg-review-bg text-review' : 'bg-border-light text-text-secondary'}`}>
                    {e.action_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-text-secondary">{e.summary ?? '—'}</td>
                <td className="px-4 py-2.5 text-text-muted font-mono text-xs">{e.ip_address ?? '—'}</td>
              </tr>
            ))}
            {events.length === 0 && !loading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">No events</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="text-center">
          <button onClick={() => load(false)} disabled={loading} className="border border-border text-text-secondary px-4 py-2 rounded-btn text-sm hover:bg-sidebar-hover disabled:opacity-60">
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
