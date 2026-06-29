import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  ApiKey,
  ApiKeyWithPlaintext,
  SFTPSource,
  SFTPPollLog,
  ZohoConnection,
  ZohoModule,
  ZohoRegion,
} from '@callguard/shared';

export function Integrations() {
  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Integrations</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Connect external systems via API, SFTP or CRM
        </p>
      </div>

      <ApiKeysSection />
      <div className="h-8" />
      <SFTPSourcesSection />
      <div className="h-8" />
      <ZohoSection />
    </div>
  );
}

// ============================================================
// API Keys Section
// ============================================================

function ApiKeysSection() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<ApiKeyWithPlaintext | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const { data } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<{ data: ApiKey[] }>('/ingestion/api-keys'),
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      const created = await api.post<ApiKeyWithPlaintext>('/ingestion/api-keys', { name });
      setNewKey(created);
      setName('');
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Revoke this API key? Any system using it will stop working.')) return;
    await api.delete(`/ingestion/api-keys/${id}`);
    queryClient.invalidateQueries({ queryKey: ['api-keys'] });
  };

  const handleCloseModal = () => {
    setCreateOpen(false);
    setNewKey(null);
    setError('');
    setName('');
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[15px] font-semibold text-text-primary">API Keys</h3>
        <button
          onClick={() => setCreateOpen(true)}
          className="bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
        >
          Generate API Key
        </button>
      </div>

      {!data?.data.length ? (
        <div className="bg-card border border-dashed border-border rounded-card p-8 text-center">
          <p className="text-text-secondary font-semibold mb-1">No API keys yet</p>
          <p className="text-table-cell text-text-muted">
            Generate a key to let external systems POST calls to <code className="font-mono text-[12px] bg-table-header px-1.5 py-0.5 rounded">/api/ingestion/calls</code>
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr>
                {['Name', 'Key', 'Last Used', 'Created', 'Status', ''].map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((key) => (
                <tr key={key.id} className="border-b border-border-light last:border-0">
                  <td className="px-5 py-3.5 text-table-cell text-text-primary font-medium">{key.name}</td>
                  <td className="px-5 py-3.5 text-table-cell font-mono text-text-cell">{key.key_prefix}...</td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : <span className="text-text-muted">Never</span>}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {new Date(key.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3.5">
                    {key.revoked_at ? (
                      <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-fail-bg text-fail">Revoked</span>
                    ) : (
                      <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-pass-bg text-pass">Active</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    {!key.revoked_at && (
                      <button
                        onClick={() => handleRevoke(key.id)}
                        className="text-[12px] text-text-muted hover:text-fail"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Documentation */}
      <details className="mt-4 bg-card border border-border rounded-card p-5">
        <summary className="cursor-pointer text-table-cell font-semibold text-text-primary">
          API Usage Examples
        </summary>
        <div className="mt-4 space-y-4 text-table-cell">
          <div>
            <p className="text-text-secondary mb-2">POST a call via JSON (audio_url):</p>
            <pre className="bg-table-header border border-border-light rounded-btn p-3 font-mono text-[12px] overflow-x-auto">{`curl -X POST ${window.location.origin}/api/ingestion/calls \\
  -H "X-API-Key: cg_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "audio_url": "https://example.com/call.mp3",
    "agent_name": "John Smith",
    "customer_phone": "07123456789",
    "external_id": "TEL-12345"
  }'`}</pre>
          </div>
          <div>
            <p className="text-text-secondary mb-2">POST a call via multipart (file upload):</p>
            <pre className="bg-table-header border border-border-light rounded-btn p-3 font-mono text-[12px] overflow-x-auto">{`curl -X POST ${window.location.origin}/api/ingestion/calls \\
  -H "X-API-Key: cg_live_..." \\
  -F "audio=@call.mp3" \\
  -F "agent_name=John Smith" \\
  -F "external_id=TEL-12345"`}</pre>
          </div>
          <p className="text-[12px] text-text-muted">
            <strong>external_id</strong> makes ingestion idempotent - re-posting with the same value returns the existing call instead of duplicating.
          </p>
        </div>
      </details>

      {/* Create modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={handleCloseModal} />
          <div className="relative bg-card border border-border rounded-card w-full max-w-lg p-6 shadow-lg">
            {newKey ? (
              <div>
                <h3 className="text-[15px] font-semibold text-text-primary mb-1">API Key Created</h3>
                <div className="bg-review-bg border border-review/20 text-review px-3 py-2 rounded-btn text-table-cell mb-4">
                  Copy this key now - you won't be able to see it again.
                </div>
                <div className="bg-table-header rounded-btn p-3 font-mono text-table-cell break-all mb-4">
                  {newKey.plaintext_key}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => navigator.clipboard.writeText(newKey.plaintext_key)}
                    className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors"
                  >
                    Copy
                  </button>
                  <button
                    onClick={handleCloseModal}
                    className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreate}>
                <h3 className="text-[15px] font-semibold text-text-primary mb-1">Generate API Key</h3>
                <p className="text-table-cell text-text-subtle mb-4">
                  Give this key a name so you can identify it later (e.g. "RingCentral", "Twilio webhook").
                </p>
                {error && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>}
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Key name"
                  className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors"
                  required
                />
                <div className="flex gap-2 mt-4">
                  <button type="button" onClick={handleCloseModal} className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={creating} className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
                    {creating ? 'Generating...' : 'Generate'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// SFTP Sources Section
// ============================================================

interface SFTPFormState {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'privatekey';
  password: string;
  private_key: string;
  remote_path: string;
  file_pattern: string;
  filename_template: string;
  poll_interval_minutes: number;
  is_active: boolean;
}

const emptyForm: SFTPFormState = {
  name: '',
  host: '',
  port: 22,
  username: '',
  auth_method: 'password',
  password: '',
  private_key: '',
  remote_path: '/',
  file_pattern: '*.mp3',
  filename_template: '',
  poll_interval_minutes: 15,
  is_active: true,
};

function SFTPSourcesSection() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<SFTPFormState | null>(null);
  const [logsForId, setLogsForId] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['sftp-sources'],
    queryFn: () => api.get<{ data: SFTPSource[] }>('/ingestion/sftp-sources'),
  });

  const handlePollNow = async (id: string) => {
    await api.post(`/ingestion/sftp-sources/${id}/poll-now`);
    alert('Poll queued');
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this SFTP source? Polling will stop immediately.')) return;
    await api.delete(`/ingestion/sftp-sources/${id}`);
    queryClient.invalidateQueries({ queryKey: ['sftp-sources'] });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[15px] font-semibold text-text-primary">SFTP Sources</h3>
        <button
          onClick={() => setEditing(emptyForm)}
          className="bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
        >
          Add SFTP Source
        </button>
      </div>

      {!data?.data.length ? (
        <div className="bg-card border border-dashed border-border rounded-card p-8 text-center">
          <p className="text-text-secondary font-semibold mb-1">No SFTP sources yet</p>
          <p className="text-table-cell text-text-muted">
            Add your dialler/recording system's SFTP server and we'll poll it for new recordings automatically.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr>
                {['Name', 'Host', 'Path', 'Last Polled', 'Status', ''].map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((src) => (
                <tr key={src.id} className="border-b border-border-light last:border-0">
                  <td className="px-5 py-3.5 text-table-cell text-text-primary font-medium">{src.name}</td>
                  <td className="px-5 py-3.5 text-table-cell font-mono text-text-cell">{src.username}@{src.host}:{src.port}</td>
                  <td className="px-5 py-3.5 text-table-cell font-mono text-text-cell">{src.remote_path}</td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {src.last_polled_at ? new Date(src.last_polled_at).toLocaleString() : <span className="text-text-muted">Never</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    {src.last_error ? (
                      <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-fail-bg text-fail" title={src.last_error}>Error</span>
                    ) : src.is_active ? (
                      <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-pass-bg text-pass">Active</span>
                    ) : (
                      <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-table-header text-text-muted">Paused</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-3 text-[12px]">
                      <button onClick={() => handlePollNow(src.id)} className="text-text-muted hover:text-text-primary">Poll Now</button>
                      <button onClick={() => setLogsForId(src.id)} className="text-text-muted hover:text-text-primary">Logs</button>
                      <button onClick={() => setEditing({
                        id: src.id,
                        name: src.name,
                        host: src.host,
                        port: src.port,
                        username: src.username,
                        auth_method: src.auth_method,
                        password: '',
                        private_key: '',
                        remote_path: src.remote_path,
                        file_pattern: src.file_pattern || '*.mp3',
                        filename_template: src.filename_template || '',
                        poll_interval_minutes: src.poll_interval_minutes,
                        is_active: src.is_active,
                      })} className="text-text-muted hover:text-text-primary">Edit</button>
                      <button onClick={() => handleDelete(src.id)} className="text-text-muted hover:text-fail">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <SFTPSourceModal initial={editing} onClose={() => setEditing(null)} />}
      {logsForId && <SFTPLogsModal sourceId={logsForId} onClose={() => setLogsForId(null)} />}
    </div>
  );
}

function SFTPSourceModal({ initial, onClose }: { initial: SFTPFormState; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; fileCount?: number } | null>(null);

  const update = (changes: Partial<SFTPFormState>) => setForm({ ...form, ...changes });
  const isEdit = !!initial.id;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        host: form.host,
        port: form.port,
        username: form.username,
        auth_method: form.auth_method,
        remote_path: form.remote_path,
        file_pattern: form.file_pattern,
        filename_template: form.filename_template || null,
        poll_interval_minutes: form.poll_interval_minutes,
        is_active: form.is_active,
      };
      if (form.password) payload.password = form.password;
      if (form.private_key) payload.private_key = form.private_key;

      if (isEdit) {
        await api.put(`/ingestion/sftp-sources/${initial.id}`, payload);
      } else {
        await api.post('/ingestion/sftp-sources', payload);
      }
      queryClient.invalidateQueries({ queryKey: ['sftp-sources'] });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!isEdit) {
      setError('Save the source first, then test the connection');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; message: string; fileCount?: number }>(
        `/ingestion/sftp-sources/${initial.id}/test`
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto py-8">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-card w-full max-w-2xl p-6 shadow-lg my-auto">
        <h3 className="text-[15px] font-semibold text-text-primary mb-4">
          {isEdit ? 'Edit SFTP Source' : 'Add SFTP Source'}
        </h3>

        {error && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>}

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
          <Field label="Name" full>
            <input type="text" value={form.name} onChange={(e) => update({ name: e.target.value })} required className={inputCls} placeholder="My dialler SFTP" />
          </Field>
          <Field label="Host">
            <input type="text" value={form.host} onChange={(e) => update({ host: e.target.value })} required className={inputCls} placeholder="sftp.example.com" />
          </Field>
          <Field label="Port">
            <input type="number" value={form.port} onChange={(e) => update({ port: parseInt(e.target.value) || 22 })} required className={inputCls} />
          </Field>
          <Field label="Username">
            <input type="text" value={form.username} onChange={(e) => update({ username: e.target.value })} required className={inputCls} />
          </Field>
          <Field label="Auth Method">
            <select value={form.auth_method} onChange={(e) => update({ auth_method: e.target.value as 'password' | 'privatekey' })} className={inputCls}>
              <option value="password">Password</option>
              <option value="privatekey">Private Key</option>
            </select>
          </Field>
          {form.auth_method === 'password' ? (
            <Field label={isEdit ? 'Password (leave blank to keep)' : 'Password'} full>
              <input type="password" value={form.password} onChange={(e) => update({ password: e.target.value })} required={!isEdit} className={inputCls} />
            </Field>
          ) : (
            <Field label={isEdit ? 'Private Key (leave blank to keep)' : 'Private Key (PEM)'} full>
              <textarea value={form.private_key} onChange={(e) => update({ private_key: e.target.value })} required={!isEdit} className={inputCls + ' font-mono text-[11px]'} rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..." />
            </Field>
          )}
          <Field label="Remote Path" full>
            <input type="text" value={form.remote_path} onChange={(e) => update({ remote_path: e.target.value })} required className={inputCls} placeholder="/recordings" />
          </Field>
          <Field label="File Pattern">
            <input type="text" value={form.file_pattern} onChange={(e) => update({ file_pattern: e.target.value })} className={inputCls} placeholder="*.mp3" />
          </Field>
          <Field label="Poll Interval (minutes)">
            <input type="number" min={1} value={form.poll_interval_minutes} onChange={(e) => update({ poll_interval_minutes: parseInt(e.target.value) || 15 })} className={inputCls} />
          </Field>
          <Field label="Filename Template (optional)" full hint="Placeholders: {agent}, {phone}, {date}. Example: {agent}__{phone}__{date}.mp3">
            <input type="text" value={form.filename_template} onChange={(e) => update({ filename_template: e.target.value })} className={inputCls} placeholder="{agent}__{phone}__{date}.mp3" />
          </Field>
          <Field label="Active" full>
            <label className="flex items-center gap-2 text-table-cell text-text-cell">
              <input type="checkbox" checked={form.is_active} onChange={(e) => update({ is_active: e.target.checked })} />
              Poll this source on schedule
            </label>
          </Field>

          {testResult && (
            <div className={`col-span-2 rounded-btn px-3 py-2 text-table-cell ${testResult.ok ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'}`}>
              {testResult.message}
              {testResult.fileCount !== undefined && ` (${testResult.fileCount} files in directory)`}
            </div>
          )}

          <div className="col-span-2 flex gap-2 mt-2">
            <button type="button" onClick={onClose} className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors">
              Cancel
            </button>
            {isEdit && (
              <button type="button" onClick={handleTest} disabled={testing} className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors disabled:opacity-50">
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
            )}
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
              {saving ? 'Saving...' : isEdit ? 'Save' : 'Add Source'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SFTPLogsModal({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['sftp-logs', sourceId],
    queryFn: () => api.get<{ data: SFTPPollLog[] }>(`/ingestion/sftp-sources/${sourceId}/logs`),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-card w-full max-w-2xl p-6 shadow-lg max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-text-primary">Poll Logs</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">Close</button>
        </div>
        {!data?.data.length ? (
          <p className="text-table-cell text-text-muted">No polls yet.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                {['Started', 'Found', 'Ingested', 'Skipped', 'Error'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-table-header uppercase text-text-muted bg-table-header border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((log) => (
                <tr key={log.id} className="border-b border-border-light last:border-0">
                  <td className="px-3 py-2 text-table-cell text-text-cell font-mono">{new Date(log.started_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-table-cell text-text-cell">{log.files_found}</td>
                  <td className="px-3 py-2 text-table-cell text-pass font-medium">{log.files_ingested}</td>
                  <td className="px-3 py-2 text-table-cell text-text-muted">{log.files_skipped}</td>
                  <td className="px-3 py-2 text-table-cell text-fail">{log.error_message || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Zoho CRM Section
// ============================================================

const ZOHO_REGIONS: { value: ZohoRegion; label: string }[] = [
  { value: 'eu', label: 'EU (zoho.eu)' },
  { value: 'com', label: 'US (zoho.com)' },
  { value: 'in', label: 'India (zoho.in)' },
  { value: 'com.au', label: 'Australia (zoho.com.au)' },
  { value: 'jp', label: 'Japan (zoho.jp)' },
  { value: 'ca', label: 'Canada (zohocloud.ca)' },
];

function ZohoSection() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data } = useQuery({
    queryKey: ['zoho-connection'],
    queryFn: () => api.get<{ data: ZohoConnection | null }>('/integrations/zoho'),
  });
  const conn = data?.data ?? null;

  // Surface the result of the OAuth round-trip (Zoho redirects back with ?zoho=…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('zoho');
    if (!status) return;
    if (status === 'connected') setBanner({ ok: true, message: 'Zoho CRM connected.' });
    else if (status === 'error') {
      setBanner({ ok: false, message: params.get('message') || 'Zoho connection failed.' });
    }
    queryClient.invalidateQueries({ queryKey: ['zoho-connection'] });
    window.history.replaceState({}, '', window.location.pathname);
  }, [queryClient]);

  const handleReconnect = async () => {
    const { authorize_url } = await api.get<{ authorize_url: string }>('/integrations/zoho/authorize');
    window.location.assign(authorize_url);
  };

  const handleTest = async () => {
    setTestResult(null);
    const result = await api.post<{ ok: boolean; message: string }>('/integrations/zoho/test');
    setTestResult(result);
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Zoho CRM? Scored calls will stop syncing to Zoho.')) return;
    await api.delete('/integrations/zoho');
    queryClient.invalidateQueries({ queryKey: ['zoho-connection'] });
  };

  const statusBadge = !conn ? null : conn.status === 'active' ? (
    <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-pass-bg text-pass">Active</span>
  ) : conn.status === 'pending' ? (
    <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-review-bg text-review">Awaiting authorization</span>
  ) : (
    <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-table-header text-text-muted">Disabled</span>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[15px] font-semibold text-text-primary">Zoho CRM</h3>
        {!conn && (
          <button
            onClick={() => setEditing(true)}
            className="bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
          >
            Connect Zoho
          </button>
        )}
      </div>

      {banner && (
        <div className={`mb-4 rounded-btn px-3 py-2 text-table-cell ${banner.ok ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'}`}>
          {banner.message}
        </div>
      )}

      {!conn ? (
        <div className="bg-card border border-dashed border-border rounded-card p-8 text-center">
          <p className="text-text-secondary font-semibold mb-1">Zoho CRM not connected</p>
          <p className="text-table-cell text-text-muted">
            Push compliance scores and breach tasks onto the matching Lead/Contact after every call is scored.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {statusBadge}
              <span className="text-table-cell text-text-cell">
                Module <span className="font-medium text-text-primary">{conn.module}</span> · Region <span className="font-mono">{conn.dc_region}</span>
              </span>
            </div>
            <div className="flex items-center gap-3 text-[12px]">
              {conn.status === 'active' && (
                <button onClick={handleTest} className="text-text-muted hover:text-text-primary">Test</button>
              )}
              <button onClick={handleReconnect} className="text-text-muted hover:text-text-primary">Reconnect</button>
              <button onClick={() => setEditing(true)} className="text-text-muted hover:text-text-primary">Edit</button>
              <button onClick={handleDisconnect} className="text-text-muted hover:text-fail">Disconnect</button>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table-cell">
            <div className="flex justify-between border-b border-border-light py-1">
              <dt className="text-text-muted">Last synced</dt>
              <dd className="text-text-cell">{conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString() : 'Never'}</dd>
            </div>
            <div className="flex justify-between border-b border-border-light py-1">
              <dt className="text-text-muted">Last error</dt>
              <dd className={conn.last_error ? 'text-fail' : 'text-text-cell'} title={conn.last_error || ''}>
                {conn.last_error ? conn.last_error.slice(0, 40) + (conn.last_error.length > 40 ? '…' : '') : 'None'}
              </dd>
            </div>
          </dl>

          {conn.status === 'pending' && (
            <div className="mt-4 bg-review-bg border border-review/20 text-review px-3 py-2 rounded-btn text-table-cell">
              Credentials saved. Click <strong>Reconnect</strong> to authorize CallGuard in Zoho and activate the connection.
            </div>
          )}

          {testResult && (
            <div className={`mt-4 rounded-btn px-3 py-2 text-table-cell ${testResult.ok ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'}`}>
              {testResult.message}
            </div>
          )}
        </div>
      )}

      {editing && (
        <ZohoConnectModal
          initial={conn}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function ZohoConnectModal({ initial, onClose }: { initial: ZohoConnection | null; onClose: () => void }) {
  const [dcRegion, setDcRegion] = useState<ZohoRegion>(initial?.dc_region ?? 'eu');
  const [module, setModule] = useState<ZohoModule>(initial?.module ?? 'Leads');
  const [clientId, setClientId] = useState(initial?.client_id ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { authorize_url } = await api.post<{ authorize_url: string }>('/integrations/zoho', {
        dc_region: dcRegion,
        module,
        client_id: clientId,
        client_secret: clientSecret,
      });
      // Hand off to Zoho's consent screen; it redirects back to /integrations.
      window.location.assign(authorize_url);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto py-8">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-card w-full max-w-lg p-6 shadow-lg my-auto">
        <h3 className="text-[15px] font-semibold text-text-primary mb-1">
          {initial ? 'Edit Zoho Connection' : 'Connect Zoho CRM'}
        </h3>
        <p className="text-table-cell text-text-subtle mb-4">
          Paste the Client ID and Secret from your Zoho API console. You'll be sent to Zoho to approve access.
        </p>

        {error && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>}

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
          <Field label="Data centre">
            <select value={dcRegion} onChange={(e) => setDcRegion(e.target.value as ZohoRegion)} className={inputCls}>
              {ZOHO_REGIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Module">
            <select value={module} onChange={(e) => setModule(e.target.value as ZohoModule)} className={inputCls}>
              <option value="Leads">Leads</option>
              <option value="Contacts">Contacts</option>
            </select>
          </Field>
          <Field label="Client ID" full>
            <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} required className={inputCls} placeholder="1000.XXXXXXXX" />
          </Field>
          <Field label="Client Secret" full hint="Stored encrypted. Re-enter when reconnecting.">
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required className={inputCls} />
          </Field>

          <div className="col-span-2 flex gap-2 mt-2">
            <button type="button" onClick={onClose} className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
              {saving ? 'Redirecting…' : 'Save & Authorize'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

const inputCls = "w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors";

function Field({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <label className="block text-[12px] text-text-muted mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-text-muted mt-1">{hint}</p>}
    </div>
  );
}
