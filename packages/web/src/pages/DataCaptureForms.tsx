import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import type { CaptureForm } from '@callguard/shared';

interface FormListItem extends CaptureForm {
  field_count: string;
}

// Data Capture Forms — the question sets the AI extracts answers to on every
// scored sale. Set-once configuration, reached via the Settings hub.
export function DataCaptureForms() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const { notify, confirm } = useDialog();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['capture-forms'],
    queryFn: () => api.get<{ data: FormListItem[] }>('/capture/forms'),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/capture/forms/${id}/archive`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['capture-forms'] }),
    onError: (err) =>
      void notify('Failed to archive: ' + (err instanceof Error ? err.message : 'unknown error')),
  });

  const handleArchive = async (form: FormListItem) => {
    const ok = await confirm(
      `Archive "${form.name}"? New sales will no longer be captured against it. Existing captured records are kept.`,
      { confirmLabel: 'Archive' }
    );
    if (ok) archiveMutation.mutate(form.id);
  };

  const forms = data?.data ?? [];

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-page-title text-text-primary">Data Capture Forms</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            The question sets the AI captures customer answers to on every sale — separate from QA scorecards.
          </p>
        </div>
        {isAdmin && (
          <Link
            to="/capture-forms/new"
            className="px-3.5 py-2 rounded-btn text-table-cell border border-primary bg-primary text-white font-semibold hover:bg-primary-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            New form
          </Link>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40 text-text-muted">
          <div className="w-8 h-8 border-[3px] border-border border-t-primary rounded-full animate-spin mr-3" />
          Loading…
        </div>
      )}

      {isError && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
          Could not load capture forms.
        </div>
      )}

      {!isLoading && !isError && forms.length === 0 && (
        <div className="bg-card border border-border rounded-card p-10 text-center">
          <p className="text-table-cell text-text-muted mb-4">
            No capture forms yet. Create one for each context you capture against — an insurer, a
            supplier, a product line.
          </p>
          {isAdmin && (
            <Link to="/capture-forms/new" className="text-primary text-table-cell font-semibold hover:underline">
              Create your first form
            </Link>
          )}
        </div>
      )}

      {forms.length > 0 && (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-table-header text-left">
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">Name</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">Context</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">Questions</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">Version</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">Status</th>
                  {isAdmin && <th className="px-5 py-3" />}
                </tr>
              </thead>
              <tbody>
                {forms.map((form) => (
                  <tr key={form.id} className="border-t border-border-light">
                    <td className="px-5 py-3.5 text-table-cell text-text-primary font-medium">
                      {isAdmin ? (
                        <Link to={`/capture-forms/${form.id}/edit`} className="hover:text-primary transition-colors">
                          {form.name}
                        </Link>
                      ) : (
                        form.name
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-table-cell text-text-secondary">{form.context_label ?? '—'}</td>
                    <td className="px-5 py-3.5 text-table-cell text-text-secondary">{form.field_count}</td>
                    <td className="px-5 py-3.5 text-table-cell text-text-secondary">v{form.version}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${
                          form.is_active ? 'bg-pass-bg text-pass' : 'bg-table-header text-text-muted'
                        }`}
                      >
                        {form.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        <Link
                          to={`/capture-forms/${form.id}/edit`}
                          className="text-badge font-semibold text-text-secondary hover:text-primary transition-colors mr-3"
                        >
                          Edit
                        </Link>
                        <button
                          onClick={() => handleArchive(form)}
                          disabled={archiveMutation.isPending}
                          className="text-badge font-semibold text-text-muted hover:text-fail transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          Archive
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
