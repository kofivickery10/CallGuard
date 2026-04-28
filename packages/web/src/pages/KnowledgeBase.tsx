import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  KB_SECTION_TYPES,
  KB_SECTION_LABELS,
  KB_SECTION_HINTS,
} from '@callguard/shared';
import type { KBSection, KBFile, KBSectionType } from '@callguard/shared';

export function KnowledgeBase() {
  const { data } = useQuery({
    queryKey: ['kb'],
    queryFn: () => api.get<{ data: KBSection[] }>('/kb'),
  });

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Knowledge Base</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Teach the AI about your business so it can evaluate calls accurately
        </p>
      </div>

      <div className="space-y-4">
        {KB_SECTION_TYPES.map((type) => (
          <SectionCard
            key={type}
            sectionType={type}
            section={data?.data.find((s) => s.section_type === type)}
          />
        ))}
      </div>
    </div>
  );
}

function SectionCard({
  sectionType,
  section,
}: {
  sectionType: KBSectionType;
  section?: KBSection;
}) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState(section?.content || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (section?.content !== undefined) {
      setContent(section.content);
    }
  }, [section?.content]);

  const isDirty = content !== (section?.content || '');

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/kb/${sectionType}`, { content });
      queryClient.invalidateQueries({ queryKey: ['kb'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      await api.post(`/kb/${sectionType}/files`, formData);
      queryClient.invalidateQueries({ queryKey: ['kb'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!confirm('Delete this file?')) return;
    try {
      await api.delete(`/kb/files/${fileId}`);
      queryClient.invalidateQueries({ queryKey: ['kb'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const files: KBFile[] = section?.files || [];

  return (
    <div className="bg-white border border-border rounded-card p-5">
      <div className="mb-3">
        <h3 className="text-[15px] font-semibold text-text-primary">
          {KB_SECTION_LABELS[sectionType]}
        </h3>
        <p className="text-[12px] text-text-muted mt-0.5">
          {KB_SECTION_HINTS[sectionType]}
        </p>
      </div>

      {error && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn mb-3 text-table-cell">
          {error}
        </div>
      )}

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={`Add notes, rules, or information about ${KB_SECTION_LABELS[sectionType].toLowerCase()}...`}
        rows={6}
        className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors"
      />

      {/* Files */}
      {files.length > 0 && (
        <div className="mt-3 space-y-1">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center justify-between bg-table-header border border-border-light rounded-btn px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <svg
                  viewBox="0 0 24 24"
                  className="w-4 h-4 flex-shrink-0 text-primary"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-table-cell text-text-primary truncate">
                  {file.file_name}
                </span>
                {file.file_size_bytes && (
                  <span className="text-[11px] text-text-muted flex-shrink-0">
                    {(file.file_size_bytes / 1024).toFixed(0)}KB
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleDeleteFile(file.id)}
                className="text-[12px] text-text-muted hover:text-fail ml-2 flex-shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between mt-4">
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-[14px] py-[7px] rounded-btn text-[12px] font-semibold border border-border text-text-cell hover:bg-sidebar-hover transition-colors disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : '+ Attach File (PDF, DOCX, TXT)'}
          </button>
        </div>

        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-[12px] text-pass font-medium">Saved</span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="bg-primary text-white px-[18px] py-[7px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
