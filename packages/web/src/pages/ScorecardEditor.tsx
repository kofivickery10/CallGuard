import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Scorecard, ScoreType } from '@callguard/shared';

const VALID_SCORE_TYPES: ScoreType[] = ['binary', 'scale_1_5', 'scale_1_10'];

function parseCSV(text: string): ItemForm[] {
  // Strip BOM and carriage returns
  const clean = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV must have at least 2 rows');

  const header = parseCSVLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const labelIdx = header.indexOf('label');

  // If we find a "label" column, use structured format
  if (labelIdx >= 0) {
    return parseStructuredCSV(lines, header);
  }

  // Otherwise try to parse as a QA scorecard format (Section, Criteria, Score columns)
  const criteriaIdx = header.indexOf('criteria');

  if (criteriaIdx >= 0) {
    return parseQASpreadsheet(lines, header);
  }

  // Last resort: scan all rows for any column that looks like a question/criterion
  return parseFreeform(lines);
}

function parseStructuredCSV(lines: string[], header: string[]): ItemForm[] {
  const labelIdx = header.indexOf('label');
  const descIdx = header.indexOf('description');
  const typeIdx = header.indexOf('score_type');
  const weightIdx = header.indexOf('weight');

  const items: ItemForm[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]!);
    const label = cols[labelIdx]?.trim();
    if (!label) continue;

    const rawType = typeIdx >= 0 ? cols[typeIdx]?.trim() || 'binary' : 'binary';
    const scoreType = VALID_SCORE_TYPES.includes(rawType as ScoreType)
      ? (rawType as ScoreType)
      : 'binary';

    items.push({
      label,
      description: descIdx >= 0 ? cols[descIdx]?.trim() || '' : '',
      score_type: scoreType,
      weight: weightIdx >= 0 ? parseFloat(cols[weightIdx] || '1') || 1 : 1,
      sort_order: items.length,
    });
  }

  if (items.length === 0) throw new Error('No valid criteria found in CSV');
  return items;
}

function parseQASpreadsheet(lines: string[], header: string[]): ItemForm[] {
  const criteriaIdx = header.indexOf('criteria');
  const sectionIdx = header.indexOf('section');

  const items: ItemForm[] = [];
  let currentSection = '';

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]!);
    const section = sectionIdx >= 0 ? cols[sectionIdx]?.trim() || '' : '';
    const criteria = cols[criteriaIdx]?.trim() || '';

    if (section) currentSection = section;
    if (!criteria) continue;

    // Skip rows that look like headers/metadata
    if (criteria.toLowerCase().startsWith('agent name') || criteria.toLowerCase().startsWith('observer')) continue;

    items.push({
      label: criteria,
      description: currentSection ? `Section: ${currentSection}` : '',
      score_type: 'binary',
      weight: 1,
      sort_order: items.length,
    });
  }

  if (items.length === 0) throw new Error('No valid criteria found in CSV');
  return items;
}

function parseFreeform(lines: string[]): ItemForm[] {
  // Scan every row and column looking for text that looks like a criterion
  // (starts with "Did", "Was", "Is", or contains a question mark)
  const items: ItemForm[] = [];
  let currentSection = '';

  for (const line of lines) {
    const cols = parseCSVLine(line);
    for (const col of cols) {
      const text = col.trim();
      if (!text) continue;

      // Detect section headers (e.g. "1. Opening & Compliance")
      if (/^\d+\.\s+/.test(text) && !text.includes('?') && text.length < 60) {
        currentSection = text;
        continue;
      }

      // Detect criteria (questions about agent behavior)
      if (
        text.includes('?') ||
        /^did (the |our )?agent/i.test(text) ||
        /^was the agent/i.test(text) ||
        /^did the agent/i.test(text)
      ) {
        items.push({
          label: text.replace(/\?$/, '').trim() + '?',
          description: currentSection ? `Section: ${currentSection}` : '',
          score_type: 'binary',
          weight: 1,
          sort_order: items.length,
        });
      }
    }
  }

  if (items.length === 0) throw new Error('Could not find any criteria in this file. Use a CSV with columns: label, description, score_type, weight');
  return items;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

interface ItemForm {
  id?: string;
  label: string;
  description: string;
  score_type: ScoreType;
  weight: number;
  sort_order: number;
}

export function ScorecardEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<ItemForm[]>([
    {
      label: '',
      description: '',
      score_type: 'binary',
      weight: 1,
      sort_order: 0,
    },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const csvInputRef = useRef<HTMLInputElement>(null);

  const handleCSVImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = parseCSV(event.target?.result as string);
        setItems(parsed);
        setError('');
      } catch (err) {
        setError((err as Error).message);
      }
    };
    reader.readAsText(file);

    // Reset so same file can be re-selected
    e.target.value = '';
  };

  const { data: existing } = useQuery({
    queryKey: ['scorecard', id],
    queryFn: () =>
      api.get<Scorecard & { items: ItemForm[] }>(`/scorecards/${id}`),
    enabled: !!id,
  });

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description || '');
      if (existing.items && existing.items.length > 0) {
        setItems(
          existing.items.map((item) => ({
            ...item,
            description: item.description || '',
          }))
        );
      }
    }
  }, [existing]);

  const addItem = () => {
    setItems([
      ...items,
      {
        label: '',
        description: '',
        score_type: 'binary',
        weight: 1,
        sort_order: items.length,
      },
    ]);
  };

  const removeItem = (index: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (
    index: number,
    field: keyof ItemForm,
    value: string | number
  ) => {
    setItems(
      items.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);

    try {
      const payload = {
        name,
        description: description || undefined,
        items: items.map((item, i) => ({
          ...item,
          sort_order: i,
        })),
      };

      if (isNew) {
        await api.post('/scorecards', payload);
      } else {
        await api.put(`/scorecards/${id}`, payload);
      }

      queryClient.invalidateQueries({ queryKey: ['scorecards'] });
      navigate('/scorecards');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <button
        onClick={() => navigate('/scorecards')}
        className="text-table-cell text-text-muted hover:text-text-primary mb-5 inline-block transition-colors"
      >
        &larr; Back to Scorecards
      </button>

      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">
          {isNew ? 'Create Scorecard' : 'Edit Scorecard'}
        </h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Define the criteria used to evaluate call quality
        </p>
      </div>

      {error && (
        <div className="bg-fail-bg text-fail px-4 py-3 rounded-btn mb-5 text-table-cell">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="bg-white border border-border rounded-card p-5 space-y-4">
          <div>
            <label className="block text-table-cell font-medium text-text-secondary mb-1">Scorecard Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer Service QA" className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors" required />
          </div>
          <div>
            <label className="block text-table-cell font-medium text-text-secondary mb-1">Description <span className="text-text-muted font-normal">(optional)</span></label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this scorecard used for?" className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors" rows={2} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-[15px] font-semibold text-text-primary">Criteria</h3>
              <p className="text-[12px] text-text-muted mt-0.5">{items.length} {items.length === 1 ? 'criterion' : 'criteria'}</p>
            </div>
            <div className="flex items-center gap-3">
              <input ref={csvInputRef} type="file" accept=".csv" onChange={handleCSVImport} className="hidden" />
              <button type="button" onClick={() => csvInputRef.current?.click()} className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold border border-border text-text-cell hover:bg-sidebar-hover transition-colors">
                Import CSV
              </button>
              <button type="button" onClick={addItem} className="text-primary font-semibold text-table-cell hover:underline">
                + Add Criterion
              </button>
            </div>
          </div>

          <div className="space-y-2.5">
            {items.map((item, index) => (
              <div key={index} className="bg-white border border-border rounded-card p-5">
                <div className="flex items-start gap-3">
                  <div className="flex-1 space-y-3">
                    <div>
                      <label className="block text-[12px] text-text-muted mb-1">Question / Criterion</label>
                      <input type="text" value={item.label} onChange={(e) => updateItem(index, 'label', e.target.value)} placeholder="e.g. Did the agent greet the customer?" className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors" required />
                    </div>
                    <div>
                      <label className="block text-[12px] text-text-muted mb-1">AI Rubric <span className="text-text-muted">(optional)</span></label>
                      <textarea value={item.description} onChange={(e) => updateItem(index, 'description', e.target.value)} placeholder="Detailed instructions for the AI evaluator" className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors" rows={2} />
                    </div>
                    <div className="flex gap-4">
                      <div>
                        <label className="block text-[12px] text-text-muted mb-1">Score Type</label>
                        <select value={item.score_type} onChange={(e) => updateItem(index, 'score_type', e.target.value)} className="border border-border rounded-btn px-3 py-1.5 text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors">
                          <option value="binary">Yes / No</option>
                          <option value="scale_1_5">Scale 1-5</option>
                          <option value="scale_1_10">Scale 1-10</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[12px] text-text-muted mb-1">Weight</label>
                        <input type="number" value={item.weight} onChange={(e) => updateItem(index, 'weight', parseFloat(e.target.value) || 1)} min={0.1} max={10} step={0.1} className="w-20 border border-border rounded-btn px-3 py-1.5 text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors" />
                      </div>
                    </div>
                  </div>
                  <button type="button" onClick={() => removeItem(index)} className="text-text-muted hover:text-fail transition-colors mt-1 p-1" disabled={items.length <= 1}>
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-1">
          <button type="submit" disabled={saving} className="bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
            {saving ? 'Saving...' : isNew ? 'Create Scorecard' : 'Save Changes'}
          </button>
          <button type="button" onClick={() => navigate('/scorecards')} className="px-[18px] py-[9px] rounded-btn text-text-cell font-semibold border border-border hover:bg-sidebar-hover text-table-cell transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
