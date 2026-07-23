import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Scorecard, ScoreType, ScorecardItemType, BranchConfig, AppliesWhen, Product } from '@callguard/shared';

const VALID_SCORE_TYPES: ScoreType[] = ['binary', 'scale_1_5', 'scale_1_10'];
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const TRUTHY = ['true', 'yes', 'y', '1'];

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
  const idx = (name: string) => header.indexOf(name);
  const labelIdx = idx('label');
  const descIdx = idx('description');
  const typeIdx = idx('score_type');
  const weightIdx = idx('weight');
  const severityIdx = idx('severity');
  const sectionIdx = idx('section');
  const itemTypeIdx = idx('item_type');
  const branchIdx = idx('branch');
  const expectationIdx = idx('expectation');
  const aiCheckIdx = idx('ai_check');
  const consentIdx = idx('consent_gate');

  const items: ItemForm[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]!);
    const label = cols[labelIdx]?.trim();
    if (!label) continue;

    const rawType = typeIdx >= 0 ? cols[typeIdx]?.trim() || 'binary' : 'binary';
    const scoreType = VALID_SCORE_TYPES.includes(rawType as ScoreType)
      ? (rawType as ScoreType)
      : 'binary';
    const rawSeverity = severityIdx >= 0 ? (cols[severityIdx]?.trim().toLowerCase() || '') : '';
    const rawItemType = itemTypeIdx >= 0 ? (cols[itemTypeIdx]?.trim().toLowerCase() || 'ai') : 'ai';

    items.push({
      label,
      description: descIdx >= 0 ? cols[descIdx]?.trim() || '' : '',
      score_type: scoreType,
      weight: weightIdx >= 0 ? parseFloat(cols[weightIdx] || '1') || 1 : 1,
      sort_order: items.length,
      severity: VALID_SEVERITIES.includes(rawSeverity) ? (rawSeverity as ItemForm['severity']) : '',
      section: sectionIdx >= 0 ? cols[sectionIdx]?.trim() || '' : '',
      item_type: rawItemType === 'manual' ? 'manual' : 'ai',
      branch: branchIdx >= 0 ? cols[branchIdx]?.trim() || '' : '',
      expectation: expectationIdx >= 0 ? cols[expectationIdx]?.trim() || '' : '',
      ai_check: aiCheckIdx >= 0 ? cols[aiCheckIdx]?.trim() || '' : '',
      consent_gate: consentIdx >= 0 ? TRUTHY.includes(cols[consentIdx]?.trim().toLowerCase() || '') : false,
      applies_to_products: [],
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

    items.push({ ...emptyItem(items.length), label: criteria, section: currentSection });
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
          ...emptyItem(items.length),
          label: text.replace(/\?$/, '').trim() + '?',
          section: currentSection,
        });
      }
    }
  }

  if (items.length === 0) throw new Error('Could not find any criteria in this file. Use a CSV with columns: label, description, score_type, weight, severity, section, item_type, branch, expectation, ai_check, consent_gate');
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
  severity: '' | 'critical' | 'high' | 'medium' | 'low';
  section: string;
  item_type: ScorecardItemType;
  // '' = applies to all branches; comma-separated for multiple branches
  branch: string;
  expectation: string;
  ai_check: string;
  consent_gate: boolean;
  // Product ids this criterion is required for. Empty = applies to every
  // product (the default).
  applies_to_products: string[];
}

function emptyItem(sortOrder: number): ItemForm {
  return {
    label: '',
    description: '',
    score_type: 'binary',
    weight: 1,
    sort_order: sortOrder,
    severity: '',
    section: '',
    item_type: 'ai',
    branch: '',
    expectation: '',
    ai_check: '',
    consent_gate: false,
    applies_to_products: [],
  };
}

function branchToString(appliesWhen: AppliesWhen | null | undefined): string {
  if (!appliesWhen?.branch) return '';
  return Array.isArray(appliesWhen.branch) ? appliesWhen.branch.join(', ') : appliesWhen.branch;
}

function stringToAppliesWhen(branch: string): AppliesWhen | null {
  const parts = branch.split(',').map((b) => b.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return { branch: parts.length === 1 ? parts[0]! : parts };
}

const inputClass = 'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors';
const selectClass = 'border border-border rounded-btn px-3 py-1.5 text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors';
const labelClass = 'block text-xs text-text-muted mb-1';
const filterSelectClass = 'border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary bg-card focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors';

// Compact count tile for the criteria summary strip. `tone='fail'` tints the
// number (e.g. a non-zero critical count) — the label always carries the
// meaning too, so it never relies on colour alone (§7).
function SummaryTile({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'fail' }) {
  return (
    <div className="bg-card border border-border rounded-card p-3 text-center">
      <div className={`text-card-value tabular-nums ${tone === 'fail' ? 'text-fail' : 'text-text-primary'}`}>{value}</div>
      <div className="text-card-label uppercase text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

export function ScorecardEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scoringMode, setScoringMode] = useState<'per_call' | 'journey'>('journey');
  // Comma-separated branch names; first is the default (no keyword match)
  const [branchList, setBranchList] = useState('');
  const [branchKeywords, setBranchKeywords] = useState<Record<string, string>>({});
  const [items, setItems] = useState<ItemForm[]>([emptyItem(0)]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const csvInputRef = useRef<HTMLInputElement>(null);

  // View-only filters over the criteria list — they never reorder or mutate
  // `items`, so saving (which reindexes sort_order from the full array) is
  // unaffected. Edits/removals operate on each item's real index.
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | ScorecardItemType>('all');
  const [filterSection, setFilterSection] = useState('');
  const [filterSeverity, setFilterSeverity] =
    useState<'all' | 'none' | 'critical' | 'high' | 'medium' | 'low'>('all');

  const resetFilters = () => {
    setSearch('');
    setFilterType('all');
    setFilterSection('');
    setFilterSeverity('all');
  };

  const branches = branchList.split(',').map((b) => b.trim()).filter(Boolean);

  const handleCSVImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = parseCSV(event.target?.result as string);
        setItems(parsed);
        // Branch names found in the CSV seed the branch list so applies_when
        // saves without the user retyping them.
        const found = new Set<string>();
        for (const item of parsed) {
          item.branch.split(',').map((b) => b.trim()).filter(Boolean).forEach((b) => found.add(b));
        }
        if (found.size > 0 && !branchList.trim()) {
          setBranchList([...found].join(', '));
        }
        setError('');
      } catch (err) {
        setError((err as Error).message);
      }
    };
    reader.readAsText(file);

    // Reset so same file can be re-selected
    e.target.value = '';
  };

  const { data: productsData } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ data: Product[] }>('/products'),
  });
  // Active products drive the per-criterion "Required for" picker. The section
  // only appears when the org has a catalogue, so nothing changes for tenants
  // who don't use product-aware scoring.
  const activeProducts = (productsData?.data ?? []).filter((p) => p.is_active);

  const { data: existing } = useQuery({
    queryKey: ['scorecard', id],
    queryFn: () =>
      api.get<Scorecard & { items: (Partial<ItemForm> & { applies_when?: AppliesWhen | null; applies_to_products?: string[] | null })[] }>(`/scorecards/${id}`),
    enabled: !!id,
  });

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description || '');
      setScoringMode(existing.scoring_mode || 'journey');
      if (existing.branch_config?.branches?.length) {
        setBranchList(existing.branch_config.branches.join(', '));
        const kw: Record<string, string> = {};
        for (const [branch, words] of Object.entries(existing.branch_config.keywords || {})) {
          kw[branch] = words.join(', ');
        }
        setBranchKeywords(kw);
      }
      if (existing.items && existing.items.length > 0) {
        setItems(
          existing.items.map((item, i) => ({
            ...emptyItem(i),
            ...item,
            description: item.description || '',
            severity: (item.severity as ItemForm['severity']) || '',
            section: item.section || '',
            item_type: item.item_type || 'ai',
            branch: branchToString(item.applies_when),
            expectation: item.expectation || '',
            ai_check: item.ai_check || '',
            consent_gate: !!item.consent_gate,
            applies_to_products: item.applies_to_products ?? [],
          }))
        );
      }
    }
  }, [existing]);

  const addItem = () => {
    // Clear filters so the new (empty) criterion is always visible.
    resetFilters();
    setItems([...items, emptyItem(items.length)]);
  };

  const removeItem = (index: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (
    index: number,
    field: keyof ItemForm,
    value: string | number | boolean
  ) => {
    setItems(
      items.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  };

  // Toggle a product in a criterion's "Required for" set. Empty set = the
  // criterion applies to every product.
  const toggleItemProduct = (index: number, productId: string) => {
    setItems(
      items.map((item, i) => {
        if (i !== index) return item;
        const has = item.applies_to_products.includes(productId);
        return {
          ...item,
          applies_to_products: has
            ? item.applies_to_products.filter((id) => id !== productId)
            : [...item.applies_to_products, productId],
        };
      })
    );
  };

  const buildBranchConfig = (): BranchConfig | null => {
    if (branches.length < 2) return null;
    const keywords: Record<string, string[]> = {};
    for (const branch of branches) {
      const words = (branchKeywords[branch] || '').split(',').map((w) => w.trim()).filter(Boolean);
      if (words.length > 0) keywords[branch] = words;
    }
    return { branches, detect: 'keyword', keywords };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (branches.length === 1) {
      setError('Branching needs at least 2 branch names (or leave the field empty for a single-path scorecard)');
      return;
    }
    const unknownBranch = items.find((item) =>
      item.branch.split(',').map((b) => b.trim()).filter(Boolean).some((b) => !branches.includes(b))
    );
    if (unknownBranch) {
      setError(`Criterion "${unknownBranch.label || 'untitled'}" references branch "${unknownBranch.branch}" which is not in the branch list`);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name,
        description: description || undefined,
        scoring_mode: scoringMode,
        branch_config: buildBranchConfig(),
        items: items.map((item, i) => ({
          id: item.id,
          label: item.label,
          description: item.description || undefined,
          score_type: item.score_type,
          weight: item.weight,
          sort_order: i,
          severity: item.severity || null,
          section: item.section || null,
          item_type: item.item_type,
          applies_when: stringToAppliesWhen(item.branch),
          expectation: item.expectation || null,
          ai_check: item.ai_check || null,
          consent_gate: item.consent_gate,
          applies_to_products: item.applies_to_products.length ? item.applies_to_products : null,
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

  const sections = Array.from(new Set(items.map((i) => i.section.trim()).filter(Boolean))).sort();

  const stats = {
    total: items.length,
    ai: items.filter((i) => i.item_type === 'ai').length,
    manual: items.filter((i) => i.item_type === 'manual').length,
    sections: sections.length,
    consent: items.filter((i) => i.consent_gate).length,
    critical: items.filter((i) => i.severity === 'critical').length,
  };

  const q = search.trim().toLowerCase();
  const visible = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (filterType !== 'all' && item.item_type !== filterType) return false;
      if (filterSection && item.section.trim() !== filterSection) return false;
      if (filterSeverity !== 'all') {
        if (filterSeverity === 'none' ? !!item.severity : item.severity !== filterSeverity) return false;
      }
      if (q) {
        const hay = [item.label, item.section, item.description, item.expectation, item.ai_check]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

  const filtersActive = filterType !== 'all' || !!filterSection || filterSeverity !== 'all' || !!q;
  // The summary + filter toolbar only earns its space on larger scorecards.
  const showTools = items.length >= 5;
  // Below the toolbar threshold the (now hidden) filters must not hide rows —
  // fall back to the full list so stale filter state can never strand items.
  const shown = showTools ? visible : items.map((item, index) => ({ item, index }));

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
        <div className="bg-card border border-border rounded-card p-5 space-y-4">
          <div>
            <label className="block text-table-cell font-medium text-text-secondary mb-1">Scorecard Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer Service QA" className={inputClass} required />
          </div>
          <div>
            <label className="block text-table-cell font-medium text-text-secondary mb-1">Description <span className="text-text-muted font-normal">(optional)</span></label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this scorecard used for?" className={inputClass} rows={2} />
          </div>
          <div>
            <label className="block text-table-cell font-medium text-text-secondary mb-1">Scoring Mode</label>
            <select value={scoringMode} onChange={(e) => setScoringMode(e.target.value as 'per_call' | 'journey')} className={selectClass}>
              <option value="journey">Sale (all of a sale's calls scored together)</option>
              <option value="per_call">Per call (each call scored on its own)</option>
            </select>
          </div>
        </div>

        <div className="bg-card border border-border rounded-card p-5 space-y-4">
          <div>
            <h3 className="text-section-title text-text-primary">Branching <span className="text-text-muted font-normal text-xs">(optional)</span></h3>
            <p className="text-xs text-text-muted mt-0.5">
              For scorecards where the call can take different paths (e.g. policy goes on risk vs referred for underwriting).
              Criteria can then be limited to one branch; the rest score as N/A instead of failing.
            </p>
          </div>
          <div>
            <label className={labelClass}>Branch names <span className="text-text-muted">(comma-separated; the first is the default when no keywords match)</span></label>
            <input type="text" value={branchList} onChange={(e) => setBranchList(e.target.value)} placeholder="e.g. on_risk, referred" className={inputClass} />
          </div>
          {branches.length >= 2 && branches.map((branch, bi) => (
            <div key={branch}>
              <label className={labelClass}>
                Keywords for &ldquo;{branch}&rdquo;{bi === 0 && <span className="text-text-muted"> (default branch — keywords optional)</span>}
              </label>
              <input
                type="text"
                value={branchKeywords[branch] || ''}
                onChange={(e) => setBranchKeywords({ ...branchKeywords, [branch]: e.target.value })}
                placeholder="Comma-separated phrases that identify this path in the transcript"
                className={inputClass}
              />
            </div>
          ))}
        </div>

        <div>
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <div>
              <h3 className="text-section-title text-text-primary">Criteria</h3>
              <p className="text-xs text-text-muted mt-0.5">{items.length} {items.length === 1 ? 'criterion' : 'criteria'}</p>
            </div>
            <div className="flex items-center gap-3">
              <input ref={csvInputRef} type="file" accept=".csv" onChange={handleCSVImport} className="hidden" />
              <button type="button" onClick={() => csvInputRef.current?.click()} className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold border border-border text-text-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                Import CSV
              </button>
              <button type="button" onClick={addItem} className="text-primary font-semibold text-table-cell hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                + Add Criterion
              </button>
            </div>
          </div>

          {showTools && (
            <>
              {/* Summary — at-a-glance counts for the whole scorecard */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5 mb-4">
                <SummaryTile label="Total" value={stats.total} />
                <SummaryTile label="AI-scored" value={stats.ai} />
                <SummaryTile label="Manual" value={stats.manual} />
                <SummaryTile label="Sections" value={stats.sections} />
                <SummaryTile label="Consent gates" value={stats.consent} />
                <SummaryTile label="Critical" value={stats.critical} tone={stats.critical > 0 ? 'fail' : 'default'} />
              </div>

              {/* Filters — view only; never reorder or mutate the item list */}
              <div className="bg-card border border-border rounded-card p-4 mb-4 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search criteria, sections, rubric…"
                    aria-label="Search criteria"
                    className="flex-1 min-w-[180px] border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
                  />
                  {sections.length > 0 && (
                    <select value={filterSection} onChange={(e) => setFilterSection(e.target.value)} aria-label="Filter by section" className={filterSelectClass}>
                      <option value="">All sections</option>
                      {sections.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                  <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value as typeof filterSeverity)} aria-label="Filter by severity" className={filterSelectClass}>
                    <option value="all">All severities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                    <option value="none">No severity</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-muted mr-1">Type</span>
                  {([['all', 'All'], ['ai', 'AI-scored'], ['manual', 'Manual']] as const).map(([val, lbl]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setFilterType(val)}
                      aria-pressed={filterType === val}
                      className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                        filterType === val ? 'bg-primary text-white' : 'border border-border text-text-secondary hover:bg-sidebar-hover'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                  <div className="flex-1" />
                  <span className="text-xs text-text-muted tabular-nums">Showing {visible.length} of {items.length}</span>
                  {filtersActive && (
                    <button type="button" onClick={resetFilters} className="text-table-cell text-primary font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {shown.length === 0 ? (
            <div className="bg-card border border-border rounded-card p-10 text-center">
              <p className="text-table-cell text-text-muted">No criteria match your filters.</p>
              <button type="button" onClick={resetFilters} className="text-primary font-semibold text-table-cell hover:underline mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                Clear filters
              </button>
            </div>
          ) : (
          <div className="space-y-2.5">
            {shown.map(({ item, index }) => (
              <div key={item.id ?? `i-${index}`} className="bg-card border border-border rounded-card p-5">
                <div className="flex items-start gap-3">
                  <span className="mt-1 shrink-0 inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 rounded-full bg-table-header text-text-muted text-badge tabular-nums" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="flex-1 space-y-3">
                    <div className="flex gap-4">
                      <div className="flex-1">
                        <label className={labelClass}>Question / Criterion</label>
                        <input type="text" value={item.label} onChange={(e) => updateItem(index, 'label', e.target.value)} placeholder="e.g. Did the agent greet the customer?" className={inputClass} required />
                      </div>
                      <div className="w-44">
                        <label className={labelClass}>Section</label>
                        <input type="text" value={item.section} onChange={(e) => updateItem(index, 'section', e.target.value)} placeholder="e.g. Opening" className={inputClass} />
                      </div>
                    </div>
                    <div className="flex gap-4 flex-wrap">
                      <div>
                        <label className={labelClass}>Type</label>
                        <select value={item.item_type} onChange={(e) => updateItem(index, 'item_type', e.target.value)} className={selectClass}>
                          <option value="ai">AI-scored</option>
                          <option value="manual">Manual review</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelClass}>Score Type</label>
                        <select value={item.score_type} onChange={(e) => updateItem(index, 'score_type', e.target.value)} className={selectClass} disabled={item.item_type === 'manual'}>
                          <option value="binary">Yes / No</option>
                          <option value="scale_1_5">Scale 1-5</option>
                          <option value="scale_1_10">Scale 1-10</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelClass}>Weight</label>
                        <input type="number" value={item.weight} onChange={(e) => updateItem(index, 'weight', parseFloat(e.target.value) || 1)} min={0.1} max={10} step={0.1} className="w-20 border border-border rounded-btn px-3 py-1.5 text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors" />
                      </div>
                      <div>
                        <label className={labelClass}>Severity</label>
                        <select value={item.severity} onChange={(e) => updateItem(index, 'severity', e.target.value)} className={selectClass}>
                          <option value="">None</option>
                          <option value="critical">Critical</option>
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                        </select>
                      </div>
                      {branches.length >= 2 && (
                        <div>
                          <label className={labelClass}>Applies to</label>
                          <select value={item.branch} onChange={(e) => updateItem(index, 'branch', e.target.value)} className={selectClass}>
                            <option value="">All branches</option>
                            {branches.map((b) => (
                              <option key={b} value={b}>{b}</option>
                            ))}
                            {item.branch && !branches.includes(item.branch) && (
                              <option value={item.branch}>{item.branch}</option>
                            )}
                          </select>
                        </div>
                      )}
                      <div className="flex items-end pb-1.5">
                        <label className="flex items-center gap-2 text-table-cell text-text-secondary cursor-pointer">
                          <input type="checkbox" checked={item.consent_gate} onChange={(e) => updateItem(index, 'consent_gate', e.target.checked)} className="accent-primary" disabled={item.item_type === 'manual'} />
                          Consent gate
                        </label>
                      </div>
                    </div>
                    {activeProducts.length > 0 && (
                      <div>
                        <label className={labelClass}>
                          Required for products{' '}
                          <span className="text-text-muted">
                            {item.applies_to_products.length === 0
                              ? '(none selected — scored on every product)'
                              : '(scored only when the sale includes one of these; N/A otherwise)'}
                          </span>
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {activeProducts.map((p) => {
                            const selected = item.applies_to_products.includes(p.id);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => toggleItemProduct(index, p.id)}
                                aria-pressed={selected}
                                className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                                  selected
                                    ? 'bg-primary text-white'
                                    : 'border border-border text-text-secondary hover:bg-sidebar-hover'
                                }`}
                              >
                                {p.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {item.item_type === 'ai' && (
                      <>
                        <div>
                          <label className={labelClass}>AI Rubric <span className="text-text-muted">(optional)</span></label>
                          <textarea value={item.description} onChange={(e) => updateItem(index, 'description', e.target.value)} placeholder="Detailed instructions for the AI evaluator" className={inputClass} rows={2} />
                        </div>
                        <div className="flex gap-4">
                          <div className="flex-1">
                            <label className={labelClass}>Expectation <span className="text-text-muted">(optional — what the adviser must say/do)</span></label>
                            <textarea value={item.expectation} onChange={(e) => updateItem(index, 'expectation', e.target.value)} placeholder="e.g. Must state the firm is authorised and regulated by the FCA" className={inputClass} rows={2} />
                          </div>
                          <div className="flex-1">
                            <label className={labelClass}>Wording check <span className="text-text-muted">(optional — for word-for-word statements)</span></label>
                            <textarea value={item.ai_check} onChange={(e) => updateItem(index, 'ai_check', e.target.value)} placeholder="e.g. Statement must be present and convey the full regulatory meaning" className={inputClass} rows={2} />
                          </div>
                        </div>
                      </>
                    )}
                    {item.item_type === 'manual' && (
                      <p className="text-xs text-text-muted">
                        Manual items are never sent to the AI — they land in the review queue and are excluded from the AI score until a reviewer marks them.
                      </p>
                    )}
                  </div>
                  <button type="button" onClick={() => removeItem(index)} aria-label={`Remove criterion ${index + 1}`} className="text-text-muted hover:text-fail transition-colors mt-1 p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40" disabled={items.length <= 1}>
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
          )}
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
