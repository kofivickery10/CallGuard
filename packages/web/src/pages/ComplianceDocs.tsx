import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface DocType {
  id: string;
  title: string;
  description: string;
}

interface RenderedDoc {
  type: string;
  title: string;
  markdown: string;
  html: string;
}

export function ComplianceDocs() {
  const [selected, setSelected] = useState<DocType | null>(null);
  const [rendered, setRendered] = useState<RenderedDoc | null>(null);
  const [controllerName, setControllerName] = useState('');
  const [dpoEmail, setDpoEmail] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  const { data } = useQuery({
    queryKey: ['compliance-docs'],
    queryFn: () => api.get<{ data: DocType[] }>('/compliance-docs'),
  });

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setGenerating(true);
    setError('');
    try {
      const result = await api.post<RenderedDoc>(
        `/compliance-docs/${selected.id}/render`,
        { data_controller_name: controllerName, dpo_email: dpoEmail }
      );
      setRendered(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadMd = () => {
    if (!rendered) return;
    const blob = new Blob([rendered.markdown], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${rendered.type}.md`;
    a.click();
  };

  const handleOpenPrintable = () => {
    if (!rendered) return;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${rendered.title}</title>
<style>
@page { size: A4; margin: 18mm 15mm; }
body { font-family: 'Inter', -apple-system, sans-serif; color: #1a2e1a; font-size: 12px; line-height: 1.6; max-width: 180mm; margin: 0 auto; }
h1 { font-size: 24px; border-bottom: 2px solid #4a9e6e; padding-bottom: 8px; }
h2 { font-size: 16px; margin-top: 24px; color: #2d6e4a; }
h3 { font-size: 14px; margin-top: 18px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 11px; }
th, td { border: 1px solid #e2e8e2; padding: 6px 8px; text-align: left; }
th { background: #f8faf8; font-weight: 600; }
code { background: #f0f5f0; padding: 2px 4px; border-radius: 3px; font-family: Monaco, monospace; font-size: 11px; }
hr { border: none; border-top: 1px solid #e2e8e2; margin: 24px 0; }
@media print { .no-print { display: none; } }
</style>
</head><body>${rendered.html}<script class="no-print">window.addEventListener('load',()=>setTimeout(()=>window.print(),500));</script></body></html>`;
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
    }
  };

  const handleClose = () => {
    setSelected(null);
    setRendered(null);
    setControllerName('');
    setDpoEmail('');
    setError('');
  };

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Compliance Docs</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Auto-generated templates for UK GDPR, Article 30, and internal security policy
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.data.map((doc) => (
          <button
            key={doc.id}
            onClick={() => setSelected(doc)}
            className="bg-white border border-border rounded-card p-5 text-left hover:border-primary hover:shadow-md transition-all"
          >
            <h3 className="text-[15px] font-semibold text-text-primary mb-2">{doc.title}</h3>
            <p className="text-table-cell text-text-subtle leading-relaxed">{doc.description}</p>
            <div className="mt-4 text-[12px] text-primary font-semibold">
              Generate &rarr;
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto py-8">
          <div className="absolute inset-0 bg-text-primary/30" onClick={handleClose} />
          <div className="relative bg-white border border-border rounded-card w-full max-w-2xl p-6 shadow-lg my-auto">
            <h3 className="text-[15px] font-semibold text-text-primary mb-1">{selected.title}</h3>
            <p className="text-table-cell text-text-subtle mb-5">{selected.description}</p>

            {error && (
              <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">
                {error}
              </div>
            )}

            {!rendered ? (
              <form onSubmit={handleGenerate} className="space-y-4">
                <div>
                  <label className="block text-[12px] text-text-muted mb-1">Data Controller Name</label>
                  <input
                    type="text"
                    value={controllerName}
                    onChange={(e) => setControllerName(e.target.value)}
                    placeholder="e.g. Jane Smith"
                    required
                    className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-text-muted mb-1">DPO Email</label>
                  <input
                    type="email"
                    value={dpoEmail}
                    onChange={(e) => setDpoEmail(e.target.value)}
                    placeholder="dpo@yourcompany.com"
                    required
                    className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={generating}
                    className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors"
                  >
                    {generating ? 'Generating...' : 'Generate'}
                  </button>
                </div>
              </form>
            ) : (
              <div>
                <div className="bg-pass-bg text-pass px-3 py-2 rounded-btn text-table-cell mb-4">
                  Document generated successfully.
                </div>
                <div className="bg-table-header border border-border-light rounded-btn p-4 max-h-[300px] overflow-y-auto mb-4">
                  <pre className="text-[11px] whitespace-pre-wrap font-mono text-text-cell">
                    {rendered.markdown.slice(0, 2000)}{rendered.markdown.length > 2000 ? '\n\n[truncated preview - download for full document]' : ''}
                  </pre>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleDownloadMd}
                    className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors"
                  >
                    Download .md
                  </button>
                  <button
                    onClick={handleOpenPrintable}
                    className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors"
                  >
                    Open Printable PDF
                  </button>
                  <button
                    onClick={handleClose}
                    className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
