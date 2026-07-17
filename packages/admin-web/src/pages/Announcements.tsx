import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

interface Announcement {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  created_by_email: string | null;
}

const LEVEL_STYLES: Record<string, string> = {
  info:     'bg-processing-bg text-processing',
  warning:  'bg-review-bg text-review',
  critical: 'bg-fail-bg text-fail',
};

interface FormState {
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  active: boolean;
  starts_at: string;
  ends_at: string;
}
const BLANK: FormState = { title: '', body: '', level: 'info', active: true, starts_at: '', ends_at: '' };

// <input type="datetime-local"> values are local wall-clock time with no
// timezone, while the API stores/returns UTC timestamptz. Slicing the UTC
// ISO string directly into the input (or sending the input value straight
// back) reads/writes the wrong instant whenever local time != UTC — i.e.
// every day during BST. These convert explicitly at the boundary.
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(local: string): string | null {
  if (!local) return null;
  return new Date(local).toISOString();
}

export default function Announcements() {
  const [list, setList] = useState<Announcement[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState<typeof BLANK>(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get<{ announcements: Announcement[] }>('/superadmin/announcements')
      .then((r) => setList(r.announcements))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const reset = () => { setForm(BLANK); setEditingId(null); };

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) { setError('Title and message are required'); return; }
    if (form.starts_at && form.ends_at && new Date(form.starts_at) >= new Date(form.ends_at)) {
      setError('End time must be after the start time');
      return;
    }
    setSaving(true); setError('');
    const payload = {
      title: form.title,
      body: form.body,
      level: form.level,
      active: form.active,
      starts_at: fromLocalInputValue(form.starts_at),
      ends_at: fromLocalInputValue(form.ends_at),
    };
    try {
      if (editingId) await api.put(`/superadmin/announcements/${editingId}`, payload);
      else await api.post('/superadmin/announcements', payload);
      reset();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const edit = (a: Announcement) => {
    setEditingId(a.id);
    setForm({
      title: a.title,
      body: a.body,
      level: a.level,
      active: a.active,
      starts_at: a.starts_at ? toLocalInputValue(a.starts_at) : '',
      ends_at: a.ends_at ? toLocalInputValue(a.ends_at) : '',
    });
  };

  const toggleActive = async (a: Announcement) => {
    try {
      // The API always writes starts_at/ends_at from the request body (it
      // can't tell "field omitted" from "field explicitly cleared" apart from
      // COALESCE, and the editor needs to be able to clear a schedule) — so a
      // partial { active } payload would silently wipe the schedule. Send the
      // full record back with only `active` flipped.
      await api.put(`/superadmin/announcements/${a.id}`, {
        title: a.title,
        body: a.body,
        level: a.level,
        active: !a.active,
        starts_at: a.starts_at,
        ends_at: a.ends_at,
      });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-page-title text-text-primary">Announcements</h2>
        <p className="text-page-sub text-text-subtle">Banners shown across every tenant app while active and in date.</p>
      </div>

      {error && <p className="text-fail text-sm">{error}</p>}

      {/* Editor */}
      <div className="bg-card rounded-card border border-border p-4 space-y-3 max-w-2xl">
        <h2 className="text-sm font-semibold text-text-primary">{editingId ? 'Edit announcement' : 'New announcement'}</h2>
        <input
          type="text"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="Title"
          className="w-full border border-border rounded-btn px-3 py-2 text-sm"
        />
        <textarea
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          placeholder="Message shown to tenants"
          rows={3}
          className="w-full border border-border rounded-btn px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Level</label>
            <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as typeof form.level })} className="border border-border rounded-btn px-3 py-2 text-sm">
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Starts (optional)</label>
            <input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} className="border border-border rounded-btn px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Ends (optional)</label>
            <input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} className="border border-border rounded-btn px-3 py-2 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary pb-2">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active
          </label>
        </div>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving} className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover disabled:opacity-60">
            {editingId ? 'Save changes' : 'Publish'}
          </button>
          {editingId && <button onClick={reset} className="border border-border text-text-secondary px-4 py-2 rounded-btn text-sm hover:bg-sidebar-hover">Cancel</button>}
        </div>
      </div>

      {/* List */}
      <div className="space-y-2">
        {list.map((a) => (
          <div key={a.id} className="bg-card rounded-card border border-border p-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-badge px-2 py-0.5 rounded uppercase ${LEVEL_STYLES[a.level]}`}>{a.level}</span>
                <span className="font-semibold text-text-primary">{a.title}</span>
                {!a.active && <span className="text-badge px-2 py-0.5 rounded bg-border-light text-text-muted uppercase">Inactive</span>}
              </div>
              <p className="text-sm text-text-secondary">{a.body}</p>
              <p className="text-xs text-text-muted mt-1">
                {a.starts_at ? `From ${new Date(a.starts_at).toLocaleString('en-GB')} ` : ''}
                {a.ends_at ? `until ${new Date(a.ends_at).toLocaleString('en-GB')}` : ''}
                {a.created_by_email ? ` · by ${a.created_by_email}` : ''}
              </p>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              <button onClick={() => edit(a)} className="text-xs text-primary hover:underline">Edit</button>
              <button onClick={() => toggleActive(a)} className="text-xs text-text-muted hover:text-text-secondary">
                {a.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        ))}
        {list.length === 0 && <p className="text-sm text-text-muted">No announcements yet.</p>}
      </div>
    </div>
  );
}
