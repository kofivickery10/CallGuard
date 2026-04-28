import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileDropzone } from '../components/FileDropzone';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import type { Call, AgentSummary } from '@callguard/shared';

export function Upload() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
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
        <div className="bg-white border border-border rounded-card p-5 mb-5">
          <label className="block text-table-cell font-medium text-text-secondary mb-1.5">
            Assign to Agent <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <select
            value={agentId}
            onChange={(e) => { setAgentId(e.target.value); if (e.target.value) setAgentName(''); }}
            className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors bg-white mb-2.5"
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
        </div>
      )}

      {!isAdmin && (
        <div className="bg-primary-light border border-border rounded-btn px-4 py-3 mb-5 text-table-cell text-pass">
          This call will be assigned to you ({user?.name})
        </div>
      )}

      <FileDropzone onFileSelected={handleFileSelected} disabled={uploading} />

      {uploading && (
        <div className="mt-6 bg-white border border-border rounded-xl p-10 text-center">
          <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <div className="text-[16px] font-semibold text-text-primary">Processing your call...</div>
          <div className="text-table-cell text-text-muted mt-1">Uploading and preparing for analysis</div>
        </div>
      )}
    </div>
  );
}
