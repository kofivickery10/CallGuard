import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useDialog } from '../components/DialogProvider';
import type {
  CaptureForm,
  CaptureFormField,
  CaptureAnswerType,
  CapturePiiClass,
} from '@callguard/shared';

interface FieldDraft {
  key: number; // local list key (fields have no server id until saved)
  label: string;
  description: string;
  answer_type: CaptureAnswerType;
  choices: string; // comma-separated in the editor
  required: boolean;
  pii_class: CapturePiiClass;
}

const ANSWER_TYPE_LABELS: Record<CaptureAnswerType, string> = {
  text: 'Free text',
  yes_no: 'Yes / No',
  number: 'Number',
  currency: 'Currency',
  date: 'Date',
  choice: 'Choice list',
};

const PII_LABELS: Record<CapturePiiClass, string> = {
  none: 'Store the answer',
  personal: 'Personal data — confirm only',
  health: 'Health data — confirm only',
};

let nextKey = 1;
function blankField(): FieldDraft {
  return {
    key: nextKey++,
    label: '',
    description: '',
    answer_type: 'text',
    choices: '',
    required: true,
    pii_class: 'none',
  };
}

// Create/edit a Data Capture form. Editing a form that has already been
// captured against bumps its version server-side; existing captured records
// stay pinned to the version they were extracted with.
export function DataCaptureFormEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const { notify } = useDialog();

  const [name, setName] = useState('');
  const [contextLabel, setContextLabel] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>([blankField()]);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isNew) return;
    api
      .get<CaptureForm & { fields: CaptureFormField[] }>(`/capture/forms/${id}`)
      .then((form) => {
        setName(form.name);
        setContextLabel(form.context_label ?? '');
        setFields(
          form.fields.map((f) => ({
            key: nextKey++,
            label: f.label,
            description: f.description ?? '',
            answer_type: f.answer_type,
            choices: (f.choices ?? []).join(', '),
            required: f.required,
            pii_class: f.pii_class,
          }))
        );
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load form'))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const updateField = (key: number, patch: Partial<FieldDraft>) =>
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const moveField = (index: number, dir: -1 | 1) =>
    setFields((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  const removeField = (key: number) =>
    setFields((prev) => (prev.length > 1 ? prev.filter((f) => f.key !== key) : prev));

  const handleSave = async () => {
    setError('');
    if (!name.trim()) return setError('Give the form a name.');
    const emptyLabel = fields.findIndex((f) => !f.label.trim());
    if (emptyLabel >= 0) return setError(`Question ${emptyLabel + 1} needs a label.`);
    const badChoice = fields.findIndex(
      (f) => f.answer_type === 'choice' && !f.choices.split(',').map((c) => c.trim()).filter(Boolean).length
    );
    if (badChoice >= 0) return setError(`Question ${badChoice + 1} is a choice list but has no choices.`);

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        context_label: contextLabel.trim() || null,
        fields: fields.map((f, i) => ({
          label: f.label.trim(),
          description: f.description.trim() || null,
          answer_type: f.answer_type,
          choices:
            f.answer_type === 'choice'
              ? f.choices.split(',').map((c) => c.trim()).filter(Boolean)
              : null,
          required: f.required,
          pii_class: f.pii_class,
          sort_order: i,
        })),
      };
      if (isNew) {
        await api.post('/capture/forms', payload);
      } else {
        await api.put(`/capture/forms/${id}`, payload);
      }
      await notify(isNew ? 'Form created.' : 'Form saved.');
      navigate('/capture-forms');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mr-3" />
        Loading…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-card border border-border rounded-card p-10 text-center">
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block">{loadError}</div>
        <div className="mt-4">
          <Link to="/capture-forms" className="text-primary text-table-cell font-semibold hover:underline">
            Back to Data Capture Forms
          </Link>
        </div>
      </div>
    );
  }

  const inputClass =
    'w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none';

  return (
    <div className="max-w-4xl">
      <Link
        to="/capture-forms"
        className="inline-flex items-center gap-1.5 text-table-cell text-text-muted hover:text-text-primary mb-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Data Capture Forms
      </Link>

      <div className="mb-6">
        <h2 className="text-page-title text-text-primary">{isNew ? 'New capture form' : 'Edit capture form'}</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          The questions agents must ask, and how each answer is captured.
        </p>
      </div>

      {error && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-4">{error}</div>
      )}

      <div className="bg-card border border-border rounded-card p-5 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="cf-name" className="block text-badge uppercase tracking-wider text-text-muted font-semibold mb-1.5">
              Form name
            </label>
            <input
              id="cf-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Application questions — Acme Provider"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="cf-context" className="block text-badge uppercase tracking-wider text-text-muted font-semibold mb-1.5">
              Context (optional)
            </label>
            <input
              id="cf-context"
              type="text"
              value={contextLabel}
              onChange={(e) => setContextLabel(e.target.value)}
              maxLength={120}
              placeholder="What this form is for — a provider, product line…"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3 mb-4">
        {fields.map((f, i) => (
          <div key={f.key} className="bg-card border border-border rounded-card p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <span className="text-badge uppercase tracking-wider text-text-muted font-semibold pt-1.5">
                Question {i + 1}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => moveField(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move question ${i + 1} up`}
                  className="p-1.5 rounded-btn text-text-muted hover:text-text-primary hover:bg-table-header disabled:opacity-30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
                </button>
                <button
                  onClick={() => moveField(i, 1)}
                  disabled={i === fields.length - 1}
                  aria-label={`Move question ${i + 1} down`}
                  className="p-1.5 rounded-btn text-text-muted hover:text-text-primary hover:bg-table-header disabled:opacity-30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                <button
                  onClick={() => removeField(f.key)}
                  disabled={fields.length === 1}
                  aria-label={`Remove question ${i + 1}`}
                  className="p-1.5 rounded-btn text-text-muted hover:text-fail hover:bg-fail-bg disabled:opacity-30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <input
                type="text"
                value={f.label}
                onChange={(e) => updateField(f.key, { label: e.target.value })}
                maxLength={300}
                aria-label={`Question ${i + 1} text`}
                placeholder="The question the agent must ask"
                className={inputClass}
              />
              <input
                type="text"
                value={f.description}
                onChange={(e) => updateField(f.key, { description: e.target.value })}
                maxLength={500}
                aria-label={`Question ${i + 1} guidance`}
                placeholder="Guidance for the AI (optional) — common phrasings, what counts as asked"
                className={inputClass}
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <select
                  value={f.answer_type}
                  onChange={(e) => updateField(f.key, { answer_type: e.target.value as CaptureAnswerType })}
                  aria-label={`Question ${i + 1} answer type`}
                  className={inputClass}
                >
                  {(Object.keys(ANSWER_TYPE_LABELS) as CaptureAnswerType[]).map((t) => (
                    <option key={t} value={t}>{ANSWER_TYPE_LABELS[t]}</option>
                  ))}
                </select>
                <select
                  value={f.pii_class}
                  onChange={(e) => updateField(f.key, { pii_class: e.target.value as CapturePiiClass })}
                  aria-label={`Question ${i + 1} data handling`}
                  className={inputClass}
                >
                  {(Object.keys(PII_LABELS) as CapturePiiClass[]).map((p) => (
                    <option key={p} value={p}>{PII_LABELS[p]}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-table-cell text-text-secondary px-1">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => updateField(f.key, { required: e.target.checked })}
                    className="w-4 h-4 accent-primary"
                  />
                  Required on every sale
                </label>
              </div>
              {f.answer_type === 'choice' && (
                <input
                  type="text"
                  value={f.choices}
                  onChange={(e) => updateField(f.key, { choices: e.target.value })}
                  aria-label={`Question ${i + 1} choices`}
                  placeholder="Allowed answers, comma-separated — e.g. never, current, former"
                  className={inputClass}
                />
              )}
              {f.pii_class !== 'none' && (
                <p className="text-xs text-text-muted">
                  Confirm-only: CallGuard records that this was asked and answered, but never stores the
                  answer itself.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mb-8">
        <button
          onClick={() => setFields((prev) => [...prev, blankField()])}
          className="px-3 py-2 rounded-btn text-table-cell border border-border text-text-secondary font-semibold hover:border-primary hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          + Add question
        </button>
        <div className="flex items-center gap-2">
          <Link
            to="/capture-forms"
            className="px-3.5 py-2 rounded-btn text-table-cell border border-border text-text-secondary font-semibold hover:text-text-primary transition-colors"
          >
            Cancel
          </Link>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3.5 py-2 rounded-btn text-table-cell border border-primary bg-primary text-white font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {saving ? 'Saving…' : isNew ? 'Create form' : 'Save changes'}
          </button>
        </div>
      </div>

      {!isNew && (
        <p className="text-xs text-text-muted mb-8">
          Saving changes to a form that has already captured sales creates a new version — existing
          captured records keep the questions they were captured with.
        </p>
      )}
    </div>
  );
}
