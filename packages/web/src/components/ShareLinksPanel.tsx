import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { CallShareLink } from '@callguard/shared';

interface Props {
  callId: string;
}

export function ShareLinksPanel({ callId }: Props) {
  const queryClient = useQueryClient();
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data } = useQuery({
    queryKey: ['share-links', callId],
    queryFn: () => api.get<{ data: CallShareLink[] }>(`/calls/${callId}/share-links`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['share-links', callId] });

  const handleCreate = async () => {
    setCreating(true);
    try {
      const created = await api.post<{ id: string; url: string; expires_at: string }>(
        `/calls/${callId}/share-links`,
        { expires_in_days: expiresInDays }
      );
      setJustCreated({ url: created.url });
      invalidate();
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (linkId: string) => {
    if (!confirm('Revoke this share link? It will stop working immediately.')) return;
    await api.delete(`/calls/${callId}/share-links/${linkId}`);
    invalidate();
  };

  const handleCopy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activeLinks = data?.data.filter((l) => !l.revoked_at) || [];
  const revokedLinks = data?.data.filter((l) => l.revoked_at) || [];

  return (
    <div className="bg-white border border-border rounded-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-[15px] font-semibold text-text-primary">Share with Client</h3>
        <p className="text-[12px] text-text-muted mt-0.5">
          Generate a secure link so your client can see their call's quality summary
        </p>
      </div>

      <div className="p-5">
        {justCreated ? (
          <div className="bg-pass-bg border border-pass/20 rounded-btn p-4 mb-4">
            <div className="text-[13px] font-semibold text-pass mb-2">Share link created</div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={justCreated.url}
                className="flex-1 border border-border rounded-btn px-2 py-1.5 text-[11px] font-mono text-text-cell bg-white"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button
                onClick={() => handleCopy(justCreated.url)}
                className="bg-primary text-white px-3 py-1.5 rounded-btn text-[12px] font-semibold hover:bg-primary-hover transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                onClick={() => setJustCreated(null)}
                className="px-3 py-1.5 rounded-btn border border-border text-text-cell text-[12px] font-semibold hover:bg-sidebar-hover transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 mb-4">
            <label className="text-table-cell text-text-cell">Expires in:</label>
            <select
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(parseInt(e.target.value))}
              className="border border-border rounded-btn px-2 py-1.5 text-table-cell text-text-primary bg-white focus:outline-none focus:border-primary"
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="bg-primary text-white px-4 py-1.5 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
            >
              {creating ? 'Generating...' : 'Generate Share Link'}
            </button>
          </div>
        )}

        {activeLinks.length > 0 && (
          <div className="mb-3">
            <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold mb-2">Active Links</div>
            {activeLinks.map((link) => (
              <LinkRow key={link.id} link={link} onCopy={handleCopy} onRevoke={() => handleRevoke(link.id)} copied={copied} />
            ))}
          </div>
        )}

        {revokedLinks.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-text-muted font-semibold mb-2">
              Revoked / Expired ({revokedLinks.length})
            </summary>
            {revokedLinks.map((link) => (
              <LinkRow key={link.id} link={link} onCopy={handleCopy} onRevoke={() => { /* already revoked */ }} copied={copied} disabled />
            ))}
          </details>
        )}

        {activeLinks.length === 0 && revokedLinks.length === 0 && (
          <div className="text-[12px] text-text-muted text-center py-3">
            No share links created yet
          </div>
        )}
      </div>
    </div>
  );
}

function LinkRow({
  link,
  onCopy,
  onRevoke,
  copied,
  disabled,
}: {
  link: CallShareLink;
  onCopy: (url: string) => void;
  onRevoke: () => void;
  copied: boolean;
  disabled?: boolean;
}) {
  const isExpired = new Date(link.expires_at) < new Date();
  return (
    <div className={`flex items-center gap-2 py-2 border-b border-border-light last:border-0 ${disabled ? 'opacity-60' : ''}`}>
      <input
        readOnly
        value={link.url}
        className="flex-1 min-w-0 border border-border rounded-btn px-2 py-1 text-[11px] font-mono text-text-cell bg-table-header truncate"
        onClick={(e) => (e.target as HTMLInputElement).select()}
      />
      <div className="text-[11px] text-text-muted flex-shrink-0 whitespace-nowrap">
        {link.view_count} views
        {link.feedback_count > 0 && (
          <span className="ml-2 text-secondary">★ {link.avg_stars?.toFixed(1)}</span>
        )}
      </div>
      <div className="text-[11px] text-text-muted flex-shrink-0 whitespace-nowrap">
        {link.revoked_at ? 'Revoked' : isExpired ? 'Expired' : `Exp ${new Date(link.expires_at).toLocaleDateString('en-GB')}`}
      </div>
      {!disabled && (
        <>
          <button
            onClick={() => onCopy(link.url)}
            className="text-[11px] text-primary font-semibold hover:underline flex-shrink-0"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={onRevoke}
            className="text-[11px] text-text-muted hover:text-fail flex-shrink-0"
          >
            Revoke
          </button>
        </>
      )}
    </div>
  );
}
