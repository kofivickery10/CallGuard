import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

interface SearchResults {
  tenants: { id: string; name: string; plan: string; status: string }[];
  users: { id: string; name: string; email: string; role: string; organization_id: string; org_name: string | null }[];
  customers: { id: string; name: string | null; phone_normalized: string; organization_id: string; org_name: string | null }[];
  calls: { id: string; external_id: string | null; customer_phone: string | null; status: string; organization_id: string; org_name: string | null }[];
}

const EMPTY: SearchResults = { tenants: [], users: [], customers: [], calls: [] };

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setResults(EMPTY); return; }
    setLoading(true);
    api.get<SearchResults>(`/superadmin/search?q=${encodeURIComponent(q)}`)
      .then(setResults)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [q]);

  const submit = (e: React.FormEvent) => { e.preventDefault(); setParams(input.trim() ? { q: input.trim() } : {}); };

  const total = results.tenants.length + results.users.length + results.customers.length + results.calls.length;

  return (
    <div className="p-6 space-y-5">
      <h1 className="text-xl font-bold text-text-primary">Search</h1>
      <form onSubmit={submit} className="flex gap-2 max-w-xl">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tenant name, email, phone, call id…"
          className="flex-1 border border-border rounded-btn px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button type="submit" className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover">Search</button>
      </form>

      {error && <p className="text-fail text-sm">{error}</p>}
      {loading && <p className="text-text-muted text-sm">Searching…</p>}
      {!loading && q.trim().length >= 2 && total === 0 && <p className="text-text-muted text-sm">No matches for “{q}”.</p>}

      {results.tenants.length > 0 && (
        <Section title="Tenants">
          {results.tenants.map((t) => (
            <Link key={t.id} to={`/tenants/${t.id}`} className="block px-4 py-2.5 hover:bg-sidebar-hover">
              <span className="font-medium text-text-primary">{t.name}</span>
              <span className="ml-2 text-xs text-text-muted capitalize">{t.plan} · {t.status}</span>
            </Link>
          ))}
        </Section>
      )}

      {results.users.length > 0 && (
        <Section title="Users">
          {results.users.map((u) => (
            <Link key={u.id} to={`/tenants/${u.organization_id}`} className="block px-4 py-2.5 hover:bg-sidebar-hover">
              <span className="font-medium text-text-primary">{u.email}</span>
              <span className="ml-2 text-xs text-text-muted capitalize">{u.role} · {u.org_name ?? '—'}</span>
            </Link>
          ))}
        </Section>
      )}

      {results.customers.length > 0 && (
        <Section title="Customers">
          {results.customers.map((c) => (
            <Link key={c.id} to={`/tenants/${c.organization_id}`} className="block px-4 py-2.5 hover:bg-sidebar-hover">
              <span className="font-medium text-text-primary">{c.name || c.phone_normalized}</span>
              <span className="ml-2 text-xs text-text-muted">{c.phone_normalized} · {c.org_name ?? '—'}</span>
            </Link>
          ))}
        </Section>
      )}

      {results.calls.length > 0 && (
        <Section title="Calls">
          {results.calls.map((c) => (
            <Link key={c.id} to={`/tenants/${c.organization_id}`} className="block px-4 py-2.5 hover:bg-sidebar-hover">
              <span className="font-medium text-text-primary font-mono text-xs">{c.external_id || c.id}</span>
              <span className="ml-2 text-xs text-text-muted">{c.customer_phone ?? '—'} · {c.status} · {c.org_name ?? '—'}</span>
            </Link>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-card border border-border overflow-hidden">
      <div className="px-4 py-2 bg-table-header border-b border-border text-table-header uppercase text-text-muted">{title}</div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}
