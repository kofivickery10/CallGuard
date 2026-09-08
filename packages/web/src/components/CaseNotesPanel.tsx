import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { JourneyNote } from '@callguard/shared';

const MAX_LENGTH = 5000;

interface CaseNotesPanelProps {
  journeyId: string;
  // admin/supervisor. Viewers see the notes and their history but cannot write:
  // the same split the API enforces (requireActioner vs requireOrgView).
  canAction: boolean;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// One note, its attribution, and — on demand — every version it replaced.
function NoteCard({
  note,
  journeyId,
  canAction,
}: {
  note: JourneyNote;
  journeyId: string;
  canAction: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: string) =>
      api.patch<{ note: JourneyNote }>(`/journeys/${journeyId}/notes/${note.id}`, { body }),
    onSuccess: () => {
      setEditing(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['journey-notes', journeyId] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'Could not save this note. Try again.'),
  });

  const trimmed = draft.trim();

  return (
    <li className="border border-border rounded-card p-4">
      {editing ? (
        <div>
          <label htmlFor={`note-edit-${note.id}`} className="sr-only">
            Edit note
          </label>
          <textarea
            id={`note-edit-${note.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            maxLength={MAX_LENGTH}
            className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
          />
          {error && (
            <p role="alert" className="mt-2 text-table-cell text-fail">
              {error}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => save.mutate(trimmed)}
              disabled={!trimmed || save.isPending}
              className="bg-primary text-white px-3 py-1.5 rounded-btn text-table-cell font-semibold hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(note.body);
                setEditing(false);
                setError(null);
              }}
              className="px-3 py-1.5 rounded-btn text-table-cell text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              Cancel
            </button>
            {/* Said at the point of editing, not buried in a help page: the
                person needs to know the old wording survives before they
                replace it, not afterwards. */}
            <span className="text-xs text-text-muted">
              The current version is kept and stays visible.
            </span>
          </div>
        </div>
      ) : (
        <>
          <p className="text-table-cell text-text-primary whitespace-pre-wrap">{note.body}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-text-muted">
              {note.author_name} · {formatWhen(note.created_at)}
            </span>
            {note.edited_at && (
              // Edited state is stated in words, never by styling alone — a
              // reader must be able to tell this is not the original text.
              <span className="text-xs text-text-secondary">
                Edited by {note.edited_by_name} · {formatWhen(note.edited_at)}
              </span>
            )}
            {note.revisions.length > 0 && (
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                aria-expanded={showHistory}
                className="text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary/40 rounded"
              >
                {showHistory ? 'Hide' : 'Show'} earlier {note.revisions.length === 1 ? 'version' : `versions (${note.revisions.length})`}
              </button>
            )}
            {canAction && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={`Edit note by ${note.author_name}`}
                className="text-xs text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40 rounded"
              >
                Edit
              </button>
            )}
          </div>

          {showHistory && (
            <ol className="mt-3 space-y-2 border-l-2 border-border pl-3">
              {note.revisions.map((rev) => (
                <li key={rev.id}>
                  <p className="text-table-cell text-text-secondary whitespace-pre-wrap">{rev.body}</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {rev.author_name} · {formatWhen(rev.written_at)} — replaced by{' '}
                    {rev.superseded_by_name} on {formatWhen(rev.superseded_at)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </li>
  );
}

// Case-level notes on a sale (CG-9).
//
// Notes are part of the evidence chain, not a scratchpad: they travel into the
// claims-defence pack, cannot be deleted, and every edit keeps what it replaced.
// The panel says so where someone is about to write or amend one, rather than
// leaving them to discover it.
export function CaseNotesPanel({ journeyId, canAction }: CaseNotesPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['journey-notes', journeyId],
    queryFn: () => api.get<{ notes: JourneyNote[] }>(`/journeys/${journeyId}/notes`),
    enabled: !!journeyId,
  });

  const add = useMutation({
    mutationFn: (body: string) =>
      api.post<{ note: JourneyNote }>(`/journeys/${journeyId}/notes`, { body }),
    onSuccess: () => {
      setDraft('');
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['journey-notes', journeyId] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'Could not save this note. Try again.'),
  });

  const notes = data?.notes ?? [];
  const trimmed = draft.trim();

  return (
    <div className="bg-card border border-border rounded-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-section-title text-text-primary">Case notes</h3>
        <p className="mt-1 text-xs text-text-muted">
          Context about this sale as a whole — why a score reads the way it does, what a
          reviewer should know. Notes appear in the claims-defence pack.
        </p>
      </div>

      <div className="p-5">
        {isLoading && <p className="text-table-cell text-text-subtle">Loading notes…</p>}

        {isError && (
          <p role="alert" className="text-table-cell text-fail">
            Could not load the notes for this sale. Refresh to try again.
          </p>
        )}

        {!isLoading && !isError && notes.length === 0 && (
          <p className="text-table-cell text-text-subtle">
            No notes on this sale yet.
            {canAction ? ' Add one below.' : ''}
          </p>
        )}

        {notes.length > 0 && (
          <ul className="space-y-3">
            {notes.map((note) => (
              <NoteCard key={note.id} note={note} journeyId={journeyId} canAction={canAction} />
            ))}
          </ul>
        )}

        {canAction && (
          <div className={notes.length > 0 ? 'mt-5 pt-5 border-t border-border' : 'mt-4'}>
            <label htmlFor="new-case-note" className="block text-table-cell text-text-secondary mb-1.5">
              Add a note
            </label>
            <textarea
              id="new-case-note"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              maxLength={MAX_LENGTH}
              placeholder="e.g. The score on this case is low because three calls are missing — the customer used two numbers."
              className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
            />
            {error && (
              <p role="alert" className="mt-2 text-table-cell text-fail">
                {error}
              </p>
            )}
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => add.mutate(trimmed)}
                disabled={!trimmed || add.isPending}
                className="bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors disabled:opacity-50"
              >
                {add.isPending ? 'Saving…' : 'Add note'}
              </button>
              <span className="text-xs text-text-muted">
                Saved against your name. Notes can be edited but not deleted.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
