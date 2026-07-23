import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Product } from '@callguard/shared';

const inputClass =
  'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors';
const labelClass = 'block text-xs text-text-muted mb-1';

// A single add/edit row. Kept inline (no modal) — products are a short list
// with two fields, so an inline form is faster than a dialog.
function ProductForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: Product;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [externalKey, setExternalKey] = useState(initial?.external_key ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = { name: name.trim(), external_key: externalKey.trim() || null };
      if (initial) {
        await api.put(`/products/${initial.id}`, body);
      } else {
        await api.post('/products', body);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-card p-5 space-y-4">
      {error && (
        <div className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell">{error}</div>
      )}
      <div className="flex gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className={labelClass}>Product name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Income Protection"
            className={inputClass}
            autoFocus
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className={labelClass}>
            CRM value <span className="text-text-muted">(optional — the value your CRM stores for this product)</span>
          </label>
          <input
            type="text"
            value={externalKey}
            onChange={(e) => setExternalKey(e.target.value)}
            placeholder="e.g. IP"
            className={inputClass}
          />
        </div>
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Add product'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-[18px] py-[9px] rounded-btn text-text-cell font-semibold border border-border hover:bg-sidebar-hover text-table-cell transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function Products() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ data: Product[] }>('/products'),
  });

  const products = data?.data ?? [];
  const active = products.filter((p) => p.is_active);
  const retired = products.filter((p) => !p.is_active);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const retire = async (id: string) => {
    if (!window.confirm('Retire this product? It stays on past sales and scorecards but can no longer be selected.')) {
      return;
    }
    await api.delete(`/products/${id}`);
    invalidate();
  };

  const reactivate = async (p: Product) => {
    await api.put(`/products/${p.id}`, { is_active: true });
    invalidate();
  };

  return (
    <div className="max-w-3xl">
      <button
        onClick={() => navigate('/settings')}
        className="text-table-cell text-text-muted hover:text-text-primary mb-5 inline-block transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
      >
        &larr; Back to Settings
      </button>

      <div className="mb-7 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-page-title text-text-primary">Products</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            The products you sell. Scorecard criteria can be scoped to specific products, so a criterion
            that doesn't apply to a sale is marked N/A instead of failing.
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setEditing(null);
            }}
            className="bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 shrink-0"
          >
            + Add product
          </button>
        )}
      </div>

      <div className="space-y-3">
        {adding && (
          <ProductForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              invalidate();
            }}
          />
        )}

        {isLoading ? (
          <div className="bg-card border border-border rounded-card p-10 text-center text-table-cell text-text-muted">
            Loading products…
          </div>
        ) : isError ? (
          <div className="bg-fail-bg text-fail rounded-card p-5 text-table-cell">
            Couldn't load products.{' '}
            <button type="button" onClick={() => refetch()} className="underline font-semibold">
              Retry
            </button>
          </div>
        ) : products.length === 0 && !adding ? (
          <div className="bg-card border border-border rounded-card p-10 text-center">
            <p className="text-table-cell text-text-muted">No products yet.</p>
            <p className="text-xs text-text-muted mt-1">
              Add the products you sell to start scoping scorecard criteria to them.
            </p>
          </div>
        ) : (
          <>
            {active.map((p) =>
              editing === p.id ? (
                <ProductForm
                  key={p.id}
                  initial={p}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    invalidate();
                  }}
                />
              ) : (
                <div
                  key={p.id}
                  className="bg-card border border-border rounded-card p-4 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-table-cell font-medium text-text-primary truncate">{p.name}</div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {p.external_key ? (
                        <>CRM value: <span className="text-text-secondary">{p.external_key}</span></>
                      ) : (
                        <span className="italic">No CRM value — matched by the transcript fallback only</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(p.id);
                        setAdding(false);
                      }}
                      className="text-table-cell text-primary font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => retire(p.id)}
                      className="text-table-cell text-text-muted hover:text-fail font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      Retire
                    </button>
                  </div>
                </div>
              )
            )}

            {retired.length > 0 && (
              <div className="pt-4">
                <h3 className="text-nav-label uppercase text-text-muted mb-2">Retired</h3>
                <div className="space-y-2">
                  {retired.map((p) => (
                    <div
                      key={p.id}
                      className="bg-card border border-border rounded-card p-4 flex items-center justify-between gap-4 opacity-70"
                    >
                      <div className="min-w-0">
                        <div className="text-table-cell font-medium text-text-secondary truncate">{p.name}</div>
                        {p.external_key && (
                          <div className="text-xs text-text-muted mt-0.5">CRM value: {p.external_key}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => reactivate(p)}
                        className="text-table-cell text-primary font-semibold hover:underline shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                      >
                        Reactivate
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
