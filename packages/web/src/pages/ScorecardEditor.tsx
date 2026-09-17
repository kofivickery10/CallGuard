import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useDialog } from '../components/DialogProvider';
import { ScorecardImportDrawer } from '../components/ScorecardImportDrawer';
import {
  emptyItem,
  VALID_CONSUMER_DUTY_OUTCOMES,
  CONSUMER_DUTY_OUTCOME_LABELS,
  type ItemForm,
} from '../lib/scorecard-csv';
import type { Scorecard, ScorecardItemType, BranchConfig, AppliesWhen, Product } from '@callguard/shared';

// ---------------------------------------------------------------------------
// Shapes and small helpers
// ---------------------------------------------------------------------------

interface FormSnapshot {
  name: string;
  description: string;
  scoringMode: 'per_call' | 'journey';
  branchList: string;
  branchKeywords: Record<string, string>;
  items: ItemForm[];
}

// A stable fingerprint of everything Save actually submits, used to tell
// whether the form has unsaved changes (Cancel, the back link, tab close) —
// deliberately just the fields that reach the API, not view-only state like
// the checkpoint search/filter.
function snapshotForm(form: FormSnapshot): string {
  return JSON.stringify(form);
}

// An item as it is compared for "has this changed" — without sort_order, which
// every later item's would shift when one is removed, turning one deletion into
// forty changes.
function comparableItem(item: ItemForm): string {
  const { sort_order: _sortOrder, ...rest } = item;
  return JSON.stringify(rest);
}

/**
 * How many separate things are waiting to be saved. Shown on the save bar, so
 * it has to count what a person would count: each changed setting once, each
 * added, removed or edited checkpoint once.
 */
function countChanges(baseline: FormSnapshot, current: FormSnapshot): number {
  let n = 0;
  if (baseline.name !== current.name) n++;
  if (baseline.description !== current.description) n++;
  if (baseline.scoringMode !== current.scoringMode) n++;
  if (baseline.branchList !== current.branchList) n++;
  if (JSON.stringify(baseline.branchKeywords) !== JSON.stringify(current.branchKeywords)) n++;

  const baseById = new Map(baseline.items.filter((i) => i.id).map((i) => [i.id!, i]));
  const seen = new Set<string>();
  current.items.forEach((item, i) => {
    if (item.id) {
      seen.add(item.id);
      const prev = baseById.get(item.id);
      if (!prev || comparableItem(prev) !== comparableItem(item)) n++;
      return;
    }
    // A checkpoint with no id is either brand new or, on a scorecard that has
    // never been saved, matched by position.
    const prev = baseline.items[i];
    if (!prev || prev.id || comparableItem(prev) !== comparableItem(item)) n++;
  });
  for (const id of baseById.keys()) if (!seen.has(id)) n++;

  return n;
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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// A section name that is another section name with something tacked on the end
// — "Consent (clear affirmative)" beside "Consent". Two names mean two sections
// on every report, a split nobody intended and nobody can see from one row.
const SECTION_SUFFIX = /^(.*?)\s*(?:\((.+)\)|[-–—:]\s+(.+))$/;

function normaliseSection(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function findSectionDrift(sections: string[]): { from: string; to: string }[] {
  const byNormalised = new Map(sections.map((s) => [normaliseSection(s), s]));
  const pairs: { from: string; to: string }[] = [];
  for (const section of sections) {
    const match = SECTION_SUFFIX.exec(section.trim());
    const base = match?.[1]?.trim();
    if (!base) continue;
    const target = byNormalised.get(normaliseSection(base));
    if (target && target !== section) pairs.push({ from: section, to: target });
  }
  return pairs;
}

const sectionAnchorId = (section: string) =>
  `section-${normaliseSection(section).replace(/[^a-z0-9]+/g, '-')}`;

// ---------------------------------------------------------------------------
// Shared class recipes (DESIGN_SYSTEM §4)
// ---------------------------------------------------------------------------

const inputClass =
  'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary bg-card placeholder:text-text-muted disabled:opacity-60 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors';
const selectClass =
  'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary bg-card disabled:opacity-60 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors';
const filterSelectClass =
  'border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary bg-card focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors';
const labelClass = 'block text-xs font-medium text-text-muted mb-1';
const noteClass = 'mt-1 text-xs text-text-muted';
const primaryBtn =
  'px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-on-solid hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const secondaryBtn =
  'px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
// A checkbox and its words as one target. The box itself is 20px; the label
// around it is the thing you click, and it is never under 32px tall.
const checkboxRowClass =
  'inline-flex items-center gap-2.5 min-h-[32px] py-1 text-table-cell text-text-secondary cursor-pointer';
const checkboxClass =
  'w-5 h-5 accent-primary shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded';

function ShimmerLine({ width }: { width: string }) {
  return (
    <div
      className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
      style={{
        backgroundImage:
          'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
        width,
      }}
    />
  );
}

// Compact count tile for the side rail. `tone='fail'` tints the number (e.g. a
// non-zero critical count) — the label always carries the meaning too, so it
// never relies on colour alone (§7).
function SummaryTile({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'fail' }) {
  return (
    <div className="bg-card border border-border rounded-card p-3 text-center">
      <div className={`text-card-value tabular-nums ${tone === 'fail' ? 'text-fail' : 'text-text-primary'}`}>{value}</div>
      <div className="text-card-label uppercase text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'fail' | 'muted' | 'review'; children: React.ReactNode }) {
  const tones = {
    fail: 'bg-fail-bg text-fail',
    review: 'bg-review-bg text-review',
    muted: 'bg-table-header text-text-secondary',
  } as const;
  return (
    <span className={`text-badge font-semibold px-2.5 py-[3px] rounded-full ${tones[tone]}`}>{children}</span>
  );
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-border-light pt-4">
      <legend className="text-table-header uppercase text-text-muted px-0">{title}</legend>
      <div className="mt-3 space-y-4">{children}</div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

export function ScorecardEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm } = useDialog();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [saveStatus, setSaveStatus] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  // Which checkpoint is expanded. Only the open one renders its fields — a
  // forty-two checkpoint scorecard with every field on screen is thirty-nine
  // screens of form, with Save at the bottom of it.
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // "Scope to products" stays shut unless the checkpoint already has a scope.
  const [productScopeOpen, setProductScopeOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(isNew);
  const [importOpen, setImportOpen] = useState(searchParams.get('import') === 'csv');
  const importTriggerRef = useRef<HTMLButtonElement>(null);

  // What Save would submit if nothing changes further — compared against the
  // live form to decide whether Cancel/the back link/tab-close need to warn,
  // and to count what is waiting to be saved.
  const [baseline, setBaseline] = useState<FormSnapshot>(() => ({
    name: '',
    description: '',
    scoringMode: 'journey',
    branchList: '',
    branchKeywords: {},
    items: [emptyItem(0)],
  }));

  // View-only filters over the checkpoint list — they never reorder or mutate
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

  const { data: productsData } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ data: Product[] }>('/products'),
  });
  // Active products drive the per-checkpoint scope picker. The disclosure only
  // appears when the org has a catalogue, so nothing changes for tenants who
  // don't use product-aware scoring.
  const activeProducts = useMemo(
    () => (productsData?.data ?? []).filter((p) => p.is_active),
    [productsData]
  );

  const {
    data: existing,
    isLoading: existingLoading,
    isError: existingError,
  } = useQuery({
    queryKey: ['scorecard', id],
    queryFn: () =>
      api.get<
        Scorecard & {
          scored_units?: number;
          items: (Partial<ItemForm> & { applies_when?: AppliesWhen | null; applies_to_products?: string[] | null })[];
        }
      >(`/scorecards/${id}`),
    enabled: !!id,
  });

  useEffect(() => {
    if (!existing) return;
    const nextDescription = existing.description || '';
    const nextScoringMode = existing.scoring_mode || 'journey';
    let nextBranchList = '';
    const nextBranchKeywords: Record<string, string> = {};
    if (existing.branch_config?.branches?.length) {
      nextBranchList = existing.branch_config.branches.join(', ');
      for (const [branch, words] of Object.entries(existing.branch_config.keywords || {})) {
        nextBranchKeywords[branch] = words.join(', ');
      }
    }
    const nextItems: ItemForm[] =
      existing.items && existing.items.length > 0
        ? existing.items.map((item, i) => ({
            ...emptyItem(i),
            ...item,
            description: item.description || '',
            severity: (item.severity as ItemForm['severity']) || '',
            section: item.section || '',
            item_type: item.item_type || 'ai',
            branch: branchToString(item.applies_when),
            expectation: item.expectation || '',
            ai_check: item.ai_check || '',
            remediation_guidance: item.remediation_guidance || '',
            consent_gate: !!item.consent_gate,
            applies_to_products: item.applies_to_products ?? [],
            consumer_duty_outcome: (item.consumer_duty_outcome as ItemForm['consumer_duty_outcome']) || '',
            vulnerability_related: !!item.vulnerability_related,
          }))
        : [emptyItem(0)];

    setName(existing.name);
    setDescription(nextDescription);
    setScoringMode(nextScoringMode);
    if (existing.branch_config?.branches?.length) {
      setBranchList(nextBranchList);
      setBranchKeywords(nextBranchKeywords);
    }
    if (existing.items && existing.items.length > 0) {
      setItems(nextItems);
    }

    // Match the baseline to what was just loaded (not what Save would submit)
    // so opening a scorecard and leaving it untouched never prompts to discard.
    setBaseline({
      name: existing.name,
      description: nextDescription,
      scoringMode: nextScoringMode,
      branchList: nextBranchList,
      branchKeywords: nextBranchKeywords,
      items: nextItems,
    });
  }, [existing]);

  const current: FormSnapshot = { name, description, scoringMode, branchList, branchKeywords, items };
  // True once the live form diverges from what was loaded/last saved.
  const isDirty = snapshotForm(current) !== snapshotForm(baseline);
  const changeCount = isDirty ? countChanges(baseline, current) : 0;

  // Warn on an actual browser tab close/refresh, not just an in-app nav —
  // those are handled by confirmDiscard below.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // A failed save/validation is otherwise invisible — the banner renders above
  // a long form, and the Save button that was just clicked may be elsewhere.
  useEffect(() => {
    if (error) {
      errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      errorRef.current?.focus();
    }
  }, [error]);

  // ---- Checkpoint editing -------------------------------------------------

  const addItem = () => {
    // Clear filters so the new (empty) checkpoint is always visible.
    resetFilters();
    setItems([...items, emptyItem(items.length)]);
    setOpenIndex(items.length);
    setProductScopeOpen(false);
  };

  const handleRemoveItem = async (index: number) => {
    if (items.length <= 1) return;
    const label = items[index]?.label.trim() || `Checkpoint ${index + 1}`;
    const ok = await confirm(
      `Remove "${label}"? It stays on the sales already scored against it, and stops being checked on future calls.`,
      { danger: true, confirmLabel: 'Remove' }
    );
    if (!ok) return;
    setItems(items.filter((_, i) => i !== index));
    setOpenIndex(null);
  };

  const updateItem = (index: number, field: keyof ItemForm, value: string | number | boolean) => {
    setItems(items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  // Toggle a product in a checkpoint's scope. Empty set = every product.
  const toggleItemProduct = (index: number, productId: string) => {
    setItems(
      items.map((item, i) => {
        if (i !== index) return item;
        const has = item.applies_to_products.includes(productId);
        return {
          ...item,
          applies_to_products: has
            ? item.applies_to_products.filter((pid) => pid !== productId)
            : [...item.applies_to_products, productId],
        };
      })
    );
  };

  const toggleRow = (index: number) => {
    const next = openIndex === index ? null : index;
    setOpenIndex(next);
    // The product scope opens with the row only when it already has one.
    setProductScopeOpen(next != null && (items[next]?.applies_to_products.length ?? 0) > 0);
  };

  const mergeSection = (from: string, to: string) => {
    setItems(items.map((item) => (item.section.trim() === from ? { ...item, section: to } : item)));
    setSaveStatus(`Renamed "${from}" to "${to}". Not saved yet.`);
  };

  // ---- Import -------------------------------------------------------------

  const applyImport = (imported: ItemForm[], mode: 'replace' | 'append', foundBranches: string[]) => {
    const kept = mode === 'append' ? items.filter((item) => item.label.trim()) : [];
    const next = [...kept, ...imported].map((item, i) => ({ ...item, sort_order: i }));
    setItems(next.length ? next : [emptyItem(0)]);
    // Branch names found in the CSV seed the branch list so applies_when saves
    // without the user retyping them.
    if (foundBranches.length > 0 && !branchList.trim()) setBranchList(foundBranches.join(', '));
    setError('');
    setOpenIndex(null);
    resetFilters();
    setImportOpen(false);
    setSaveStatus(
      mode === 'replace'
        ? `Replaced the checkpoints with the ${imported.length} in the file. Nothing is saved until you save.`
        : `Added ${plural(imported.length, 'checkpoint', 'checkpoints')}. Nothing is saved until you save.`
    );
    importTriggerRef.current?.focus();
  };

  const closeImport = () => {
    setImportOpen(false);
    if (searchParams.get('import')) {
      searchParams.delete('import');
      setSearchParams(searchParams, { replace: true });
    }
    importTriggerRef.current?.focus();
  };

  // ---- Leaving -------------------------------------------------------------

  const confirmDiscard = () => confirm('Discard your changes?', { danger: true, confirmLabel: 'Discard' });

  const handleBackClick = async (e: React.MouseEvent) => {
    if (!isDirty) return;
    e.preventDefault();
    if (await confirmDiscard()) navigate('/scorecards');
  };

  const handleCancel = async () => {
    if (isDirty && !(await confirmDiscard())) return;
    navigate('/scorecards');
  };

  // ---- Saving --------------------------------------------------------------

  const unit = scoringMode === 'per_call' ? 'call' : 'sale';
  const unitPlural = `${unit}s`;
  const scoredUnits = existing?.scored_units ?? 0;
  const currentVersion = existing?.version ?? 1;
  const nextVersion = currentVersion + 1;

  // The CRM half of the branch config (stage → branch map, no-score stages, and
  // the detect mode that makes them live). This screen deliberately doesn't edit
  // them — they're configured per tenant against their CRM picklist — but it must
  // carry them through a save, because the payload replaces branch_config whole.
  // Rebuilding the config from just `branches` + `keywords` is what wiped Trust
  // Point's stage map, after which every sale fell back to a guessed branch.
  const crmDetect = existing?.branch_config?.detect;
  const crmValues = existing?.branch_config?.crm_values;
  const noScoreCrmValues = existing?.branch_config?.no_score_crm_values;

  // Branch names the CRM map still points at that the user has removed or
  // renamed. Saving would orphan those mappings, so the save is blocked rather
  // than dropping them — a silently pruned map reads as "no CRM branching
  // configured" and scores every later sale on the default branch.
  const orphanedCrmBranches = Object.keys(crmValues || {}).filter((b) => !branches.includes(b));

  const buildBranchConfig = (): BranchConfig | null => {
    if (branches.length < 2) return null;
    const keywords: Record<string, string[]> = {};
    for (const branch of branches) {
      const words = (branchKeywords[branch] || '').split(',').map((w) => w.trim()).filter(Boolean);
      if (words.length > 0) keywords[branch] = words;
    }
    return {
      branches,
      detect: crmValues ? crmDetect || 'crm_field' : 'keyword',
      keywords,
      ...(crmValues ? { crm_values: crmValues } : {}),
      ...(noScoreCrmValues ? { no_score_crm_values: noScoreCrmValues } : {}),
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaveStatus('');

    // Belt and braces: the loading gate below already keeps this form from
    // rendering (and Save from being reachable) until an existing scorecard's
    // fetch resolves. Refusing here too means a race can never PUT a payload
    // built from the still-default single blank item — which would archive
    // every real checkpoint and bump the version.
    if (id && !existing) {
      setError("This scorecard hasn't finished loading yet — wait for it to load, then try again.");
      return;
    }
    if (!name.trim()) {
      setError('Give the scorecard a name before saving.');
      setDetailsOpen(true);
      return;
    }
    const unnamed = items.findIndex((item) => !item.label.trim());
    if (unnamed >= 0) {
      setError(`Checkpoint ${unnamed + 1} has no wording — say what it checks, or remove it.`);
      resetFilters();
      setOpenIndex(unnamed);
      return;
    }
    if (branches.length === 1) {
      setError('Branching needs at least 2 branch names (or leave the field empty for a single-path scorecard)');
      setDetailsOpen(true);
      return;
    }
    const unknownBranch = items.find((item) =>
      item.branch.split(',').map((b) => b.trim()).filter(Boolean).some((b) => !branches.includes(b))
    );
    if (unknownBranch) {
      setError(`Checkpoint "${unknownBranch.label || 'untitled'}" references branch "${unknownBranch.branch}" which is not in the branch list`);
      return;
    }
    if (orphanedCrmBranches.length > 0) {
      setError(
        `This scorecard maps CRM stage values onto branch ${orphanedCrmBranches
          .map((b) => `"${b}"`)
          .join(', ')}, which is no longer in the branch list. Restore the branch name, or ask an ` +
          `administrator to update the CRM stage map first — saving now would leave sales scored on a guessed branch.`
      );
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
          remediation_guidance: item.remediation_guidance || null,
          consent_gate: item.consent_gate,
          applies_to_products: item.applies_to_products.length ? item.applies_to_products : null,
          consumer_duty_outcome: item.consumer_duty_outcome || null,
          vulnerability_related: item.vulnerability_related,
        })),
      };

      if (isNew) {
        await api.post('/scorecards', payload);
        queryClient.invalidateQueries({ queryKey: ['scorecards'] });
        navigate('/scorecards');
        return;
      }

      await api.put(`/scorecards/${id}`, payload);
      // Invalidate both the list AND this scorecard's detail cache — without
      // the detail key, re-opening the editor serves the pre-save items from
      // cache (deleted rows appear to "come back" until a hard refresh).
      queryClient.invalidateQueries({ queryKey: ['scorecards'] });
      queryClient.invalidateQueries({ queryKey: ['scorecard', id] });
      // Stay put: an edit of a long scorecard is rarely one thing, and the
      // outcome is what the save bar needs to say next.
      setBaseline(current);
      setSaveStatus(`Saved as v${nextVersion}. It applies to ${unitPlural} scored from now on.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ---- Derived view state --------------------------------------------------

  const sections = useMemo(
    () => Array.from(new Set(items.map((i) => i.section.trim()).filter(Boolean))).sort(),
    [items]
  );
  const drift = useMemo(() => findSectionDrift(sections), [sections]);

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
        const hay = [item.label, item.section, item.description, item.expectation, item.ai_check, item.remediation_guidance]
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

  // Consecutive runs of the same section, in the order the checkpoints are
  // sorted — so a section that appears twice in the list gets two headers
  // rather than a count that doesn't match what is under it.
  const groups = useMemo(() => {
    const out: { section: string; rows: { item: ItemForm; index: number }[]; anchor: boolean }[] = [];
    const anchored = new Set<string>();
    for (const row of shown) {
      const section = row.item.section.trim() || 'Unsectioned';
      const last = out[out.length - 1];
      if (last && last.section === section) {
        last.rows.push(row);
        continue;
      }
      const anchor = !anchored.has(section);
      anchored.add(section);
      out.push({ section, rows: [row], anchor });
    }
    return out;
  }, [shown]);

  const backLink = (
    <Link
      to="/scorecards"
      onClick={handleBackClick}
      className="text-table-cell text-text-muted hover:text-text-primary inline-flex items-center min-h-[32px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
    >
      &larr; Back to Scorecards
    </Link>
  );

  // An existing scorecard's items haven't arrived yet — never paint the form
  // (and never let Save be reachable) while `items` is still just the default
  // single blank checkpoint, or a click here would PUT that as the whole
  // scorecard and archive every real one.
  if (!isNew && existingLoading) {
    return (
      <div aria-busy="true">
        <div className="mb-5">{backLink}</div>
        <div className="bg-card border border-border rounded-card p-5 mb-5 space-y-2">
          <ShimmerLine width="220px" />
          <ShimmerLine width="360px" />
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={`skeleton-${i}`} className="bg-card border border-border rounded-card px-5 py-4 space-y-2">
              <ShimmerLine width="55%" />
              <ShimmerLine width="30%" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // A genuine load failure (network error, deleted scorecard) — distinct from
  // an existing scorecard that simply has no items yet, which still renders
  // the normal (empty) form below.
  if (!isNew && existingError) {
    return (
      <div>
        <div className="mb-5">{backLink}</div>
        <div role="alert" className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell">
          Could not load this scorecard — try refreshing, or it may no longer exist.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3">{backLink}</div>

      <form onSubmit={handleSubmit}>
        {/* Save bar — what this is, what is waiting, and what saving will do.
            Sticky, so Save is never further away than the top of the screen. */}
        <div className="sticky top-0 z-20 bg-page pb-4">
          <div className="bg-card border border-border rounded-card shadow-card px-5 py-3.5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-[200px]">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-page-title text-text-primary">
                    {isNew ? 'New scorecard' : name || 'Untitled scorecard'}
                  </h2>
                  {!isNew && existing?.is_active && (
                    <span className="inline-flex items-center gap-1 text-badge font-semibold px-2.5 py-[3px] rounded-full bg-pass-bg text-pass">
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Live
                    </span>
                  )}
                  {!isNew && !existing?.is_active && (
                    <span className="text-badge font-semibold text-text-muted">Not live</span>
                  )}
                  {!isNew && <span className="text-badge font-semibold text-text-muted">v{currentVersion}</span>}
                </div>
                <p className="text-xs text-text-muted mt-1">
                  {isNew
                    ? 'Nothing is scored against it until you make it live on the Scorecards page.'
                    : scoredUnits > 0
                      ? `Applies to ${unitPlural} scored from now on. The ${plural(scoredUnits, unit, unitPlural)} already scored keep v${currentVersion}.`
                      : `Applies to ${unitPlural} scored from now on. Nothing has been scored against it yet.`}
                </p>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-table-cell text-text-muted tabular-nums">
                  {changeCount > 0 ? plural(changeCount, 'unsaved change', 'unsaved changes') : 'No unsaved changes'}
                </span>
                <button type="button" onClick={handleCancel} className={secondaryBtn}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryBtn}>
                  {saving ? 'Saving…' : isNew ? 'Create scorecard' : `Save as v${nextVersion}`}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div aria-live="polite" className="sr-only">
          {saveStatus}
        </div>

        {saveStatus && (
          <p className="text-table-cell text-pass mb-4 flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {saveStatus}
          </p>
        )}

        {error && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="bg-fail-bg text-fail px-4 py-3 rounded-btn mb-4 text-table-cell">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
          {/* ---- Main column ------------------------------------------- */}
          <div className="space-y-5 min-w-0">
            {/* Scorecard details: name, description, mode, branching. */}
            <div className="bg-card border border-border rounded-card">
              <button
                type="button"
                onClick={() => setDetailsOpen(!detailsOpen)}
                aria-expanded={detailsOpen}
                aria-controls="scorecard-details"
                className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-table-header transition-colors rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
              >
                <span>
                  <span className="block text-section-title text-text-primary">Scorecard details</span>
                  <span className="block text-xs text-text-muted mt-0.5">
                    Name, what it is for, whether it scores sales or calls, and branching.
                  </span>
                </span>
                <svg viewBox="0 0 24 24" className={`w-5 h-5 shrink-0 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {detailsOpen && (
                <div id="scorecard-details" className="px-5 pb-5 space-y-4 border-t border-border-light pt-4">
                  <div>
                    <label htmlFor="scorecard-name" className={labelClass}>Name</label>
                    <input
                      id="scorecard-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Protection sales QA"
                      className={inputClass}
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="scorecard-description" className={labelClass}>
                      Description <span className="font-normal">(optional)</span>
                    </label>
                    <textarea
                      id="scorecard-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What is this scorecard used for?"
                      className={inputClass}
                      rows={2}
                    />
                  </div>
                  <div>
                    <label htmlFor="scorecard-mode" className={labelClass}>What it scores</label>
                    <select
                      id="scorecard-mode"
                      value={scoringMode}
                      onChange={(e) => setScoringMode(e.target.value as 'per_call' | 'journey')}
                      className={selectClass}
                    >
                      <option value="journey">A sale — all of a sale's calls scored together</option>
                      <option value="per_call">A call — each call scored on its own</option>
                    </select>
                  </div>
                  <div className="border-t border-border-light pt-4">
                    <h3 className="text-section-title text-text-primary">
                      Branching <span className="text-text-muted font-normal text-xs">(optional)</span>
                    </h3>
                    <p className="text-xs text-text-muted mt-0.5 mb-3">
                      For scorecards where the call can take different paths (e.g. the policy goes on risk
                      or is referred for underwriting). Checkpoints can then be limited to one path; on the
                      others they count as not applicable instead of failing.
                    </p>
                    <label htmlFor="scorecard-branches" className={labelClass}>
                      Branch names <span className="font-normal">(comma-separated; the first is the default when no keywords match)</span>
                    </label>
                    <input
                      id="scorecard-branches"
                      type="text"
                      value={branchList}
                      onChange={(e) => setBranchList(e.target.value)}
                      placeholder="e.g. on_risk, referred"
                      className={inputClass}
                    />
                    {branches.length >= 2 &&
                      branches.map((branch, bi) => (
                        <div key={branch} className="mt-3">
                          <label htmlFor={`branch-keywords-${bi}`} className={labelClass}>
                            Keywords for &ldquo;{branch}&rdquo;
                            {bi === 0 && <span className="font-normal"> (default branch — keywords optional)</span>}
                          </label>
                          <input
                            id={`branch-keywords-${bi}`}
                            type="text"
                            value={branchKeywords[branch] || ''}
                            onChange={(e) => setBranchKeywords({ ...branchKeywords, [branch]: e.target.value })}
                            placeholder="Comma-separated phrases that identify this path in the transcript"
                            className={inputClass}
                          />
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>

            {/* Checkpoints */}
            <div>
              <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
                <div>
                  <h3 className="text-section-title text-text-primary">Checkpoints</h3>
                  <p className="text-xs text-text-muted mt-0.5">
                    {plural(items.length, 'checkpoint', 'checkpoints')} in {plural(stats.sections, 'section', 'sections')}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    ref={importTriggerRef}
                    type="button"
                    onClick={() => setImportOpen(true)}
                    className={secondaryBtn}
                  >
                    Import CSV
                  </button>
                  <button
                    type="button"
                    onClick={addItem}
                    className="inline-flex items-center min-h-[32px] text-primary-ink font-semibold text-table-cell hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                  >
                    + Add checkpoint
                  </button>
                </div>
              </div>

              {showTools && (
                <div className="bg-card border border-border rounded-card p-4 mb-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      id="checkpoint-search"
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search checkpoints, sections, rubric…"
                      aria-label="Search checkpoints"
                      className="flex-1 min-w-[180px] border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary bg-card placeholder:text-text-muted focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
                    />
                    {sections.length > 0 && (
                      <select
                        id="checkpoint-filter-section"
                        value={filterSection}
                        onChange={(e) => setFilterSection(e.target.value)}
                        aria-label="Filter by section"
                        className={filterSelectClass}
                      >
                        <option value="">All sections</option>
                        {sections.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    )}
                    <select
                      id="checkpoint-filter-severity"
                      value={filterSeverity}
                      onChange={(e) => setFilterSeverity(e.target.value as typeof filterSeverity)}
                      aria-label="Filter by severity"
                      className={filterSelectClass}
                    >
                      <option value="all">All severities</option>
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                      <option value="none">No severity</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-text-muted mr-1">Decided by</span>
                    {([['all', 'All'], ['ai', 'The AI'], ['manual', 'A person']] as const).map(([val, lbl]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setFilterType(val)}
                        aria-pressed={filterType === val}
                        className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                          filterType === val ? 'bg-primary-ink text-on-solid' : 'border border-border text-text-secondary hover:bg-sidebar-hover'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                    <div className="flex-1" />
                    <span className="text-xs text-text-muted tabular-nums" aria-live="polite">
                      Showing {visible.length} of {items.length}
                    </span>
                    {filtersActive && (
                      <button
                        type="button"
                        onClick={resetFilters}
                        className="text-table-cell text-primary-ink font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* One list of the sections already in this scorecard, offered to
                  every section box so the same name is typed the same way. */}
              <datalist id="scorecard-sections">
                {sections.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>

              {shown.length === 0 ? (
                <div className="bg-card border border-border rounded-card p-10 text-center">
                  <p className="text-table-cell text-text-muted">No checkpoints match your filters.</p>
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="text-primary-ink font-semibold text-table-cell hover:underline mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {groups.map((group, gi) => (
                    <div key={`${group.section}-${gi}`}>
                      <h4
                        id={group.anchor ? sectionAnchorId(group.section) : undefined}
                        className="text-table-header uppercase text-text-muted mb-1.5 scroll-mt-28"
                      >
                        {group.section} · {plural(group.rows.length, 'checkpoint', 'checkpoints')}
                      </h4>
                      <div className="bg-card border border-border rounded-card overflow-hidden">
                        {group.rows.map(({ item, index }) => (
                          <CheckpointEditorRow
                            key={item.id ?? `i-${index}`}
                            item={item}
                            index={index}
                            open={openIndex === index}
                            onToggle={() => toggleRow(index)}
                            onChange={(field, value) => updateItem(index, field, value)}
                            onRemove={() => handleRemoveItem(index)}
                            canRemove={items.length > 1}
                            branches={branches}
                            unit={unit}
                            activeProducts={activeProducts}
                            productScopeOpen={productScopeOpen}
                            onToggleProductScope={() => setProductScopeOpen(!productScopeOpen)}
                            onToggleProduct={(productId) => toggleItemProduct(index, productId)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ---- Side rail --------------------------------------------- */}
          <aside className="space-y-4 lg:sticky lg:top-[132px]">
            <div className="grid grid-cols-2 gap-2.5">
              <SummaryTile label="Checkpoints" value={stats.total} />
              <SummaryTile label="Sections" value={stats.sections} />
              <SummaryTile label="Decided by AI" value={stats.ai} />
              <SummaryTile label="By a person" value={stats.manual} />
              <SummaryTile label="Consent gates" value={stats.consent} />
              <SummaryTile label="Critical" value={stats.critical} tone={stats.critical > 0 ? 'fail' : 'default'} />
            </div>

            {drift.length > 0 && (
              <div className="bg-card border border-border rounded-card p-4">
                <h3 className="text-section-title text-text-primary">Two names, one section?</h3>
                {drift.map((pair) => (
                  <div key={pair.from} className="mt-3 text-xs text-text-secondary">
                    <p>
                      &ldquo;{pair.from}&rdquo; is &ldquo;{pair.to}&rdquo; with a suffix. Two names make two
                      sections on every report.
                    </p>
                    <button
                      type="button"
                      onClick={() => mergeSection(pair.from, pair.to)}
                      className="mt-1.5 inline-flex items-center min-h-[32px] text-table-cell text-primary-ink font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      Merge into &ldquo;{pair.to}&rdquo;
                    </button>
                  </div>
                ))}
              </div>
            )}

            {sections.length > 0 && (
              <nav aria-label="Sections" className="bg-card border border-border rounded-card p-4">
                <h3 className="text-table-header uppercase text-text-muted mb-2">Sections</h3>
                <ul className="space-y-0.5">
                  {sections.map((section) => {
                    const count = items.filter((i) => i.section.trim() === section).length;
                    return (
                      <li key={section}>
                        <button
                          type="button"
                          onClick={() => {
                            document
                              .getElementById(sectionAnchorId(section))
                              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }}
                          className="w-full flex items-baseline justify-between gap-2 text-left px-2 py-1.5 rounded-btn text-table-cell text-text-secondary hover:bg-sidebar-hover hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          <span className="truncate">{section}</span>
                          <span className="text-xs text-text-muted tabular-nums shrink-0">{count}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            )}
          </aside>
        </div>
      </form>

      {importOpen && (
        <ScorecardImportDrawer
          existingCount={items.filter((item) => item.label.trim()).length}
          onApply={applyImport}
          onClose={closeImport}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One checkpoint: collapsed to its wording and its badges, expanded to the
// four things there are to decide about it.
// ---------------------------------------------------------------------------

interface CheckpointEditorRowProps {
  item: ItemForm;
  index: number;
  open: boolean;
  onToggle: () => void;
  onChange: (field: keyof ItemForm, value: string | number | boolean) => void;
  onRemove: () => void;
  canRemove: boolean;
  branches: string[];
  unit: 'call' | 'sale';
  activeProducts: Product[];
  productScopeOpen: boolean;
  onToggleProductScope: () => void;
  onToggleProduct: (productId: string) => void;
}

const SEVERITY_LABELS: Record<Exclude<ItemForm['severity'], ''>, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function CheckpointEditorRow({
  item,
  index,
  open,
  onToggle,
  onChange,
  onRemove,
  canRemove,
  branches,
  unit,
  activeProducts,
  productScopeOpen,
  onToggleProductScope,
  onToggleProduct,
}: CheckpointEditorRowProps) {
  const bodyId = `checkpoint-body-${index}`;
  const fid = (field: string) => `checkpoint-${index}-${field}`;
  const productScopeId = `checkpoint-${index}-products`;

  return (
    <div className="border-b border-border-light last:border-0">
      <div className="flex items-start">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex-1 min-w-0 text-left flex items-start gap-3 px-5 py-3 hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
        >
          <span className="mt-0.5 shrink-0 inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 rounded-full bg-table-header text-text-muted text-badge tabular-nums">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-table-cell text-text-primary font-medium">
              {item.label.trim() || <span className="text-text-muted italic">New checkpoint — say what it checks</span>}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {item.severity ? (
                <Badge tone={item.severity === 'critical' || item.severity === 'high' ? 'fail' : 'muted'}>
                  {SEVERITY_LABELS[item.severity]}
                </Badge>
              ) : (
                <Badge tone="muted">severity from weight</Badge>
              )}
              {item.weight !== 1 && <Badge tone="muted">×{item.weight}</Badge>}
              {item.consent_gate && <Badge tone="review">Consent gate</Badge>}
              {item.item_type === 'manual' && <Badge tone="review">Decided by a person</Badge>}
              {item.branch.trim() && <Badge tone="muted">On {item.branch.trim()} only</Badge>}
              {item.applies_to_products.length > 0 && <Badge tone="muted">Some products</Badge>}
            </span>
          </span>
          <svg viewBox="0 0 24 24" className={`w-5 h-5 shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove checkpoint ${index + 1}`}
          className="shrink-0 w-10 h-10 mt-1.5 mr-2 rounded-full text-text-muted hover:text-fail hover:bg-sidebar-hover flex items-center justify-center transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      </div>

      {open && (
        <div id={bodyId} className="px-5 pb-5 space-y-5">
          <FieldGroup title="What it checks">
            <div>
              <label htmlFor={fid('label')} className={labelClass}>Checkpoint</label>
              <input
                id={fid('label')}
                type="text"
                value={item.label}
                onChange={(e) => onChange('label', e.target.value)}
                placeholder="e.g. Told the customer the call was being recorded"
                className={inputClass}
                required
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={fid('section')} className={labelClass}>Section</label>
                <input
                  id={fid('section')}
                  type="text"
                  list="scorecard-sections"
                  value={item.section}
                  onChange={(e) => onChange('section', e.target.value)}
                  placeholder="e.g. Opening"
                  className={inputClass}
                />
                <p className={noteClass}>Groups this checkpoint on every report. Pick an existing name where you can.</p>
              </div>
              <div>
                <label htmlFor={fid('item_type')} className={labelClass}>Decided by</label>
                <select
                  id={fid('item_type')}
                  value={item.item_type}
                  onChange={(e) => onChange('item_type', e.target.value)}
                  className={selectClass}
                >
                  <option value="ai">The AI</option>
                  <option value="manual">A person</option>
                </select>
                <p className={noteClass}>
                  {item.item_type === 'manual'
                    ? 'Never sent to the AI. It waits in the review queue and is left out of the score until someone marks it.'
                    : 'Scored by the AI from the transcript.'}
                </p>
              </div>
            </div>
            {item.item_type === 'ai' && (
              <>
                <div>
                  <label htmlFor={fid('description')} className={labelClass}>
                    What the AI looks for <span className="font-normal">(optional)</span>
                  </label>
                  <textarea
                    id={fid('description')}
                    value={item.description}
                    onChange={(e) => onChange('description', e.target.value)}
                    placeholder="Detailed instructions for the AI assessor"
                    className={inputClass}
                    rows={2}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor={fid('expectation')} className={labelClass}>
                      Expectation <span className="font-normal">(optional)</span>
                    </label>
                    <textarea
                      id={fid('expectation')}
                      value={item.expectation}
                      onChange={(e) => onChange('expectation', e.target.value)}
                      placeholder="e.g. Must state the firm is authorised and regulated by the FCA"
                      className={inputClass}
                      rows={2}
                    />
                    <p className={noteClass}>What the adviser has to say or do for this to pass.</p>
                  </div>
                  <div>
                    <label htmlFor={fid('ai_check')} className={labelClass}>
                      Wording check <span className="font-normal">(optional)</span>
                    </label>
                    <textarea
                      id={fid('ai_check')}
                      value={item.ai_check}
                      onChange={(e) => onChange('ai_check', e.target.value)}
                      placeholder="e.g. Statement must be present and convey the full regulatory meaning"
                      className={inputClass}
                      rows={2}
                    />
                    <p className={noteClass}>For statements that have to be said word for word.</p>
                  </div>
                </div>
              </>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={fid('consumer_duty_outcome')} className={labelClass}>Consumer Duty outcome</label>
                <select
                  id={fid('consumer_duty_outcome')}
                  value={item.consumer_duty_outcome}
                  onChange={(e) => onChange('consumer_duty_outcome', e.target.value)}
                  className={selectClass}
                >
                  <option value="">Unmapped</option>
                  {VALID_CONSUMER_DUTY_OUTCOMES.map((o) => (
                    <option key={o} value={o}>{CONSUMER_DUTY_OUTCOME_LABELS[o]}</option>
                  ))}
                </select>
                <p className={noteClass}>Used to group findings in the board pack. It does not change the score.</p>
              </div>
              <div className="flex items-end">
                <label htmlFor={fid('vulnerability_related')} className={checkboxRowClass}>
                  <input
                    id={fid('vulnerability_related')}
                    type="checkbox"
                    checked={item.vulnerability_related}
                    onChange={(e) => onChange('vulnerability_related', e.target.checked)}
                    className={checkboxClass}
                  />
                  About customer vulnerability
                </label>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup title="How it scores">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={fid('severity')} className={labelClass}>Severity</label>
                <select
                  id={fid('severity')}
                  value={item.severity}
                  onChange={(e) => onChange('severity', e.target.value)}
                  className={selectClass}
                >
                  <option value="">None</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <p className={noteClass}>Critical fails the whole {unit}, whatever the score.</p>
              </div>
              <div>
                <label htmlFor={fid('weight')} className={labelClass}>Weight</label>
                <input
                  id={fid('weight')}
                  type="number"
                  value={item.weight}
                  onChange={(e) => onChange('weight', parseFloat(e.target.value) || 1)}
                  min={0.1}
                  max={10}
                  step={0.1}
                  className={inputClass}
                />
                <p className={noteClass}>
                  How much it counts in the percentage. Left as None, a weight of 2.0 or more counts as
                  critical, 1.5 or more as high, below that as medium.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={fid('score_type')} className={labelClass}>Score type</label>
                <select
                  id={fid('score_type')}
                  value={item.score_type}
                  onChange={(e) => onChange('score_type', e.target.value)}
                  className={selectClass}
                  disabled={item.item_type === 'manual'}
                >
                  <option value="binary">Yes / No</option>
                  <option value="scale_1_5">Scale 1–5</option>
                  <option value="scale_1_10">Scale 1–10</option>
                </select>
                <p className={noteClass}>
                  {item.item_type === 'manual'
                    ? 'Set by whoever reviews it, not here.'
                    : 'Yes / No is a pass or a fail. A scale is converted to a percentage of its top mark.'}
                </p>
              </div>
              <div>
                <label htmlFor={fid('consent_gate')} className={checkboxRowClass}>
                  <input
                    id={fid('consent_gate')}
                    type="checkbox"
                    checked={item.consent_gate}
                    onChange={(e) => onChange('consent_gate', e.target.checked)}
                    className={checkboxClass}
                    disabled={item.item_type === 'manual'}
                  />
                  Consent gate
                </label>
                <p className={noteClass}>
                  If the AI isn&rsquo;t sure who spoke, this goes to a person instead of being scored.
                </p>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup title="When it applies">
            {branches.length >= 2 && (
              <div className="sm:max-w-[50%]">
                <label htmlFor={fid('branch')} className={labelClass}>Branch</label>
                <select
                  id={fid('branch')}
                  value={item.branch}
                  onChange={(e) => onChange('branch', e.target.value)}
                  className={selectClass}
                >
                  <option value="">Every branch</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                  {item.branch && !branches.includes(item.branch) && (
                    <option value={item.branch}>{item.branch}</option>
                  )}
                </select>
                <p className={noteClass}>
                  Scored only on {unit}s that took this path. On the others it counts as not applicable.
                </p>
              </div>
            )}
            {activeProducts.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={onToggleProductScope}
                  aria-expanded={productScopeOpen}
                  aria-controls={productScopeId}
                  className="flex items-center gap-2 min-h-[32px] text-table-cell font-semibold text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                >
                  <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-transform ${productScopeOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  Scope to products
                  <span className="font-normal text-text-muted">
                    {item.applies_to_products.length === 0
                      ? '— every product'
                      : `— ${plural(item.applies_to_products.length, 'product', 'products')}`}
                  </span>
                </button>
                {productScopeOpen && (
                  <div id={productScopeId} className="mt-3">
                    <div className="flex flex-wrap gap-2">
                      {activeProducts.map((p) => {
                        const selected = item.applies_to_products.includes(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => onToggleProduct(p.id)}
                            aria-pressed={selected}
                            className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                              selected
                                ? 'bg-primary-ink text-on-solid'
                                : 'border border-border text-text-secondary hover:bg-sidebar-hover'
                            }`}
                          >
                            {p.name}
                          </button>
                        );
                      })}
                    </div>
                    <p className={noteClass}>
                      Scored only when the {unit} includes one of these. Otherwise it counts as not applicable.
                    </p>
                  </div>
                )}
              </div>
            )}
          </FieldGroup>

          <FieldGroup title="What to do about it">
            <div>
              <label htmlFor={fid('remediation_guidance')} className={labelClass}>
                Remediation guidance <span className="font-normal">(optional)</span>
              </label>
              <textarea
                id={fid('remediation_guidance')}
                value={item.remediation_guidance}
                onChange={(e) => onChange('remediation_guidance', e.target.value)}
                placeholder="e.g. Call the customer back, confirm the exclusion applies and record their acknowledgement on the file."
                className={inputClass}
                rows={2}
              />
              <p className={noteClass}>
                Your firm&rsquo;s words, not the AI&rsquo;s. Leave blank and this checkpoint has no
                remediation step. Whatever you write here is emailed to the adviser, so keep it a
                general instruction and out of any one customer&rsquo;s details.
              </p>
            </div>
          </FieldGroup>
        </div>
      )}
    </div>
  );
}
