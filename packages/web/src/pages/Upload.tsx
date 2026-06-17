import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileDropzone } from '../components/FileDropzone';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import type { Call, AgentSummary } from '@callguard/shared';

interface BulkImportResult {
  total: number;
  queued: number;
  duplicates: number;
  errors: number;
  error_rows: { row: number; audio_url: string; error: string }[];
}

interface BulkImportRow {
  audio_url: string;
  agent_name?: string;
  customer_phone?: string;
  call_date?: string;
  external_id?: string;
  tags?: string;
  scorecard_id?: string;
}

interface ScorecardSummary {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

function parseCSV(text: string): BulkImportRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const firstLine = lines[0] ?? '';
  const headerCells = firstLine.split(',').map((h) => h.trim().toLowerCase());
  const rows: BulkImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const cells = line.split(',').map((c) => c.trim());
    const row: Record<string, string> = {};
    headerCells.forEach((h, j) => { row[h] = cells[j] || ''; });
    const audioUrl = row.audio_url;
    if (!audioUrl) continue;
    rows.push({
      audio_url: audioUrl,
      agent_name: row.agent_name || undefined,
      customer_phone: row.customer_phone || undefined,
      call_date: row.call_date || undefined,
      external_id: row.external_id || undefined,
      tags: row.tags || undefined,
      scorecard_id: row.scorecard_id || undefined,
    });
  }
  return rows;
}

export function Upload() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [scorecardId, setScorecardId] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkImportResult | null>(null);
  const [bulkError, setBulkError] = useState('');

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
    enabled: isAdmin,
  });

  const { data: scorecards } = useQuery({
    queryKey: ['scorecards'],
    queryFn: () => api.get<{ data: ScorecardSummary[] }>('/scorecards'),
    enabled: isAdmin,
  });

  const handleFileSelected = async (file: File) => {
    setError('');
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('audio', file);

      if (isAdmin) {
        if (agentId) {
          formData.append('agent_id', agentId);
          const selectedAgent = agents?.data.find((a) => a.id === agentId);
          if (selectedAgent) formData.append('agent_name', selectedAgent.name);
        } else if (agentName) {
          formData.append('agent_name', agentName);
        }
        if (scorecardId) {
          formData.append('scorecard_id', scorecardId);
        }
      }

      const call = await api.post<Call>('/calls/upload', formData);
      navigate(`/calls/${call.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Upload</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Upload audio files to transcribe and analyse for compliance
        </p>
      </div>

      {error && (
        <div className="bg-fail-bg text-fail px-4 py-3 rounded-btn mb-5 text-table-cell">
          {error}
        </div>
      )}

      {isAdmin && (
        <div className="bg-card border border-border rounded-card p-5 mb-5">
          <label className="block text-table-cell font-medium text-text-secondary mb-1.5">
            Assign to Agent <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <select
            value={agentId}
            onChange={(e) => { setAgentId(e.target.value); if (e.target.value) setAgentName(''); }}
            className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors bg-card mb-2.5"
          >
            <option value="">Select an agent or type below</option>
            {agents?.data.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          {!agentId && (
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="Or type agent name"
              className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors"
            />
          )}

          {scorecards && scorecards.data.length > 1 && (
            <>
              <label className="block text-table-cell font-medium text-text-secondary mb-1.5 mt-4">
                Score against scorecard <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <select
                value={scorecardId}
                onChange={(e) => setScorecardId(e.target.value)}
                className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors bg-card"
              >
                <option value="">Use the active scorecard</option>
                {scorecards.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.is_active ? ' (active)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-[12px] text-text-muted mt-1.5">
                Leave on "active" unless you are scoring against a specific campaign or client scorecard.
              </p>
            </>
          )}
        </div>
      )}

      {!isAdmin && (
        <div className="bg-primary-light border border-border rounded-btn px-4 py-3 mb-5 text-table-cell text-pass">
          This call will be assigned to you ({user?.name})
        </div>
      )}

      <FileDropzone onFileSelected={handleFileSelected} disabled={uploading} />

      {uploading && (
        <div className="mt-6 bg-card border border-border rounded-xl p-10 text-center">
          <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <div className="text-[16px] font-semibold text-text-primary">Processing your call...</div>
          <div className="text-table-cell text-text-muted mt-1">Uploading and preparing for analysis</div>
        </div>
      )}

      {isAdmin && (
        <div className="mt-8 bg-card border border-border rounded-card overflow-hidden">
          <button
            onClick={() => setBulkOpen((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-table-header transition-colors"
          >
            <div>
              <div className="text-[15px] font-semibold text-text-primary">Bulk import from URLs</div>
              <div className="text-table-cell text-text-muted mt-0.5">
                Paste a CSV of recording URLs to ingest many historical calls at once. Up to 200 per batch.
              </div>
            </div>
            <span className="text-text-muted text-[18px]">{bulkOpen ? '−' : '+'}</span>
          </button>

          {bulkOpen && (
            <div className="px-5 py-5 border-t border-border space-y-4">
              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1.5">
                  CSV (header row required)
                </label>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder={`audio_url,agent_name,customer_phone,call_date,external_id,tags,scorecard_id\nhttps://your-archive.example.com/call-001.mp3,Marcus Webb,+44 7468 432 368,2026-04-29,crm-12345,suitability,\nhttps://your-archive.example.com/call-002.mp3,Tina Lee,+44 7468 432 368,2026-04-30,crm-12346,vulnerability,`}
                  className="w-full border border-border rounded-btn px-3 py-2 text-[12px] font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors bg-page"
                />
                <div className="text-[11px] text-text-muted mt-1.5">
                  Required: <code>audio_url</code>. Optional: <code>agent_name</code>, <code>customer_phone</code>, <code>call_date</code> (ISO), <code>external_id</code> (your CRM id, used for deduplication), <code>tags</code> (comma-separated), <code>scorecard_id</code> (UUID of a scorecard from <a href="/scorecards" className="text-primary hover:underline">Scorecards</a>; leave blank to use the active one).
                </div>
              </div>

              {bulkError && (
                <div className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell">
                  {bulkError}
                </div>
              )}

              {bulkResult && (
                <div className="bg-primary-light/40 border border-primary/30 rounded-btn px-4 py-3 text-table-cell text-text-primary">
                  <div className="font-semibold mb-1">Import complete.</div>
                  <div>
                    <strong>{bulkResult.queued}</strong> queued for scoring,{' '}
                    <strong>{bulkResult.duplicates}</strong> duplicates skipped,{' '}
                    <strong>{bulkResult.errors}</strong> errors out of <strong>{bulkResult.total}</strong> rows.
                  </div>
                  {bulkResult.error_rows.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-fail text-[12px] font-semibold">View errors</summary>
                      <ul className="mt-2 text-[12px] text-text-secondary space-y-1">
                        {bulkResult.error_rows.map((e) => (
                          <li key={e.row} className="font-mono">
                            row {e.row + 1}: {e.audio_url || '(missing url)'} - {e.error}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              <button
                onClick={async () => {
                  setBulkError('');
                  setBulkResult(null);
                  const rows = parseCSV(csvText);
                  if (rows.length === 0) {
                    setBulkError('No rows parsed. Paste a CSV with at least one audio_url row beneath the header.');
                    return;
                  }
                  if (rows.length > 200) {
                    setBulkError(`Too many rows (${rows.length}). Maximum 200 per batch.`);
                    return;
                  }
                  setBulkBusy(true);
                  try {
                    const result = await api.post<BulkImportResult>('/calls/bulk-import', { rows });
                    setBulkResult(result);
                    setCsvText('');
                  } catch (err) {
                    setBulkError((err as Error).message);
                  } finally {
                    setBulkBusy(false);
                  }
                }}
                disabled={bulkBusy || !csvText.trim()}
                className="bg-primary hover:bg-primary-hover text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkBusy ? 'Importing...' : 'Import CSV'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
