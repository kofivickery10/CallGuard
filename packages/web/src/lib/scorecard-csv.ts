import { parseCsv, toCsv } from '@callguard/shared';
import type { ScoreType, ScorecardItemType, ConsumerDutyOutcome, ScorecardItem } from '@callguard/shared';

// One checkpoint as the editor holds it while you are working on it: every
// field a string or a plain value, so an input can bind straight to it and an
// empty box means "not set" rather than undefined.
export interface ItemForm {
  id?: string;
  label: string;
  description: string;
  score_type: ScoreType;
  weight: number;
  sort_order: number;
  severity: '' | 'critical' | 'high' | 'medium' | 'low';
  section: string;
  item_type: ScorecardItemType;
  // '' = applies to every branch; comma-separated for more than one.
  branch: string;
  expectation: string;
  ai_check: string;
  remediation_guidance: string;
  consent_gate: boolean;
  // Product ids this checkpoint is scored on. Empty = every product.
  applies_to_products: string[];
  // '' = unmapped — the honest default until a person tags this checkpoint
  // against a Consumer Duty outcome.
  consumer_duty_outcome: ConsumerDutyOutcome | '';
  vulnerability_related: boolean;
}

export function emptyItem(sortOrder: number): ItemForm {
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
    remediation_guidance: '',
    consent_gate: false,
    applies_to_products: [],
    consumer_duty_outcome: '',
    vulnerability_related: false,
  };
}

export const VALID_SCORE_TYPES: ScoreType[] = ['binary', 'scale_1_5', 'scale_1_10'];
export const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const VALID_CONSUMER_DUTY_OUTCOMES: ConsumerDutyOutcome[] = [
  'products_and_services',
  'price_and_value',
  'consumer_understanding',
  'consumer_support',
];
export const CONSUMER_DUTY_OUTCOME_LABELS: Record<ConsumerDutyOutcome, string> = {
  products_and_services: 'Products & services',
  price_and_value: 'Price & value',
  consumer_understanding: 'Consumer understanding',
  consumer_support: 'Consumer support',
};

const TRUTHY = ['true', 'yes', 'y', '1'];

// The columns import reads and export writes, in this order. One list, so a
// file exported from one scorecard imports into another unchanged.
export const CSV_COLUMNS = [
  'label',
  'description',
  'score_type',
  'weight',
  'severity',
  'section',
  'item_type',
  'branch',
  'expectation',
  'ai_check',
  'remediation_guidance',
  'consent_gate',
  'consumer_duty_outcome',
  'vulnerability_related',
] as const;

/** One line of a chosen file, with what it would become and what is wrong with it. */
export interface ImportRow {
  // The line number in the file the person is looking at, counting the header
  // as line 1 — so "line 8 needs fixing" can be found in their spreadsheet.
  line: number;
  item: ItemForm;
  ready: boolean;
  // What this line's check says. "Ready", or every reason it isn't, or a note
  // about what will happen to it ("No section — it will be grouped as
  // Unsectioned"), which does not stop it importing.
  notes: string[];
}

export interface ImportPreview {
  rows: ImportRow[];
  readyCount: number;
  problemCount: number;
  // Branch names found in the file, to seed the branch list.
  branches: string[];
  // Set when the file could not be read as a scorecard at all.
  fatal?: string;
}

function branchesOf(item: ItemForm): string[] {
  return item.branch.split(',').map((b) => b.trim()).filter(Boolean);
}

/**
 * Read a CSV into a preview: every line, what it would become, and its own
 * check. Nothing here changes the scorecard — the editor shows this, and only
 * an explicit "Replace with N checkpoints" / "Add N checkpoints" applies it.
 */
export function previewScorecardCsv(text: string): ImportPreview {
  const lines = parseCsv(text);
  if (lines.length < 2) {
    return {
      rows: [],
      readyCount: 0,
      problemCount: 0,
      branches: [],
      fatal: 'This file needs a header row and at least one checkpoint under it.',
    };
  }

  const header = lines[0]!.map((h) => h.trim().toLowerCase());
  const rows =
    header.indexOf('label') >= 0
      ? structuredRows(lines, header)
      : header.indexOf('criteria') >= 0
        ? qaSpreadsheetRows(lines, header)
        : freeformRows(lines);

  if (rows.length === 0) {
    return {
      rows: [],
      readyCount: 0,
      problemCount: 0,
      branches: [],
      fatal: `No checkpoints found in this file. Use a CSV with a "label" column — the full set is ${CSV_COLUMNS.join(', ')}.`,
    };
  }

  const branches = [...new Set(rows.filter((r) => r.ready).flatMap((r) => branchesOf(r.item)))];
  return {
    rows,
    readyCount: rows.filter((r) => r.ready).length,
    problemCount: rows.filter((r) => !r.ready).length,
    branches,
  };
}

/** Only the lines that passed their check, renumbered as a checkpoint list. */
export function readyItems(preview: ImportPreview): ItemForm[] {
  return preview.rows
    .filter((r) => r.ready)
    .map((r, i) => ({ ...r.item, sort_order: i }));
}

// A file already in our own shape: one column per field.
function structuredRows(lines: string[][], header: string[]): ImportRow[] {
  const idx = (name: string) => header.indexOf(name);
  const col = (cells: string[], name: string): string => {
    const i = idx(name);
    return i >= 0 ? (cells[i] ?? '').trim() : '';
  };

  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!;
    const notes: string[] = [];
    let ready = true;

    const label = col(cells, 'label');
    if (!label) {
      // A line with no checkpoint text is not a checkpoint. Reported rather
      // than silently dropped, so a count that looks short can be explained.
      rows.push({ line: i + 1, item: emptyItem(rows.length), ready: false, notes: ['No checkpoint text — there is nothing to score.'] });
      continue;
    }

    const rawScoreType = col(cells, 'score_type').toLowerCase();
    let scoreType: ScoreType = 'binary';
    if (rawScoreType) {
      if (VALID_SCORE_TYPES.includes(rawScoreType as ScoreType)) {
        scoreType = rawScoreType as ScoreType;
      } else {
        ready = false;
        notes.push(`Score type must be one of ${VALID_SCORE_TYPES.join(', ')}.`);
      }
    }

    const rawWeight = col(cells, 'weight');
    let weight = 1;
    if (rawWeight) {
      const parsed = Number(rawWeight);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        ready = false;
        notes.push('Weight must be a number above 0.');
      } else {
        weight = parsed;
      }
    }

    const rawSeverity = col(cells, 'severity').toLowerCase();
    let severity: ItemForm['severity'] = '';
    if (rawSeverity && rawSeverity !== 'none') {
      if ((VALID_SEVERITIES as readonly string[]).includes(rawSeverity)) {
        severity = rawSeverity as ItemForm['severity'];
      } else {
        ready = false;
        notes.push('Severity must be one of none, low, medium, high, critical.');
      }
    }

    const rawItemType = col(cells, 'item_type').toLowerCase();
    let itemType: ScorecardItemType = 'ai';
    if (rawItemType) {
      if (rawItemType === 'manual' || rawItemType === 'ai') {
        itemType = rawItemType;
      } else {
        ready = false;
        notes.push('Decided by must be either ai or manual.');
      }
    }

    const rawOutcome = col(cells, 'consumer_duty_outcome').toLowerCase();
    let outcome: ItemForm['consumer_duty_outcome'] = '';
    if (rawOutcome) {
      if (VALID_CONSUMER_DUTY_OUTCOMES.includes(rawOutcome as ConsumerDutyOutcome)) {
        outcome = rawOutcome as ConsumerDutyOutcome;
      } else {
        ready = false;
        notes.push(`Consumer Duty outcome must be one of ${VALID_CONSUMER_DUTY_OUTCOMES.join(', ')}, or left blank.`);
      }
    }

    const section = col(cells, 'section');
    if (!section) notes.push('No section — it will be grouped as Unsectioned.');

    rows.push({
      line: i + 1,
      ready,
      notes: ready && notes.length === 0 ? ['Ready'] : notes,
      item: {
        ...emptyItem(rows.length),
        label,
        description: col(cells, 'description'),
        score_type: scoreType,
        weight,
        severity,
        section,
        item_type: itemType,
        branch: col(cells, 'branch'),
        expectation: col(cells, 'expectation'),
        ai_check: col(cells, 'ai_check'),
        remediation_guidance: col(cells, 'remediation_guidance'),
        consent_gate: TRUTHY.includes(col(cells, 'consent_gate').toLowerCase()),
        consumer_duty_outcome: outcome,
        vulnerability_related: TRUTHY.includes(col(cells, 'vulnerability_related').toLowerCase()),
      },
    });
  }
  return rows;
}

// A QA manual exported from a spreadsheet: a "criteria" column, with the
// section named once and then left blank down the rows under it.
function qaSpreadsheetRows(lines: string[][], header: string[]): ImportRow[] {
  const criteriaIdx = header.indexOf('criteria');
  const sectionIdx = header.indexOf('section');
  const rows: ImportRow[] = [];
  let currentSection = '';

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!;
    const section = sectionIdx >= 0 ? (cells[sectionIdx] ?? '').trim() : '';
    const criteria = (cells[criteriaIdx] ?? '').trim();
    if (section) currentSection = section;
    if (!criteria) continue;
    // Header/metadata lines that spreadsheets carry above the real criteria.
    const lower = criteria.toLowerCase();
    if (lower.startsWith('agent name') || lower.startsWith('observer')) continue;

    rows.push({
      line: i + 1,
      ready: true,
      notes: currentSection ? ['Ready'] : ['No section — it will be grouped as Unsectioned.'],
      item: { ...emptyItem(rows.length), label: criteria, section: currentSection },
    });
  }
  return rows;
}

// Last resort: a manual with no recognisable columns at all. Scan every cell
// for something shaped like a question about what the adviser did.
function freeformRows(lines: string[][]): ImportRow[] {
  const rows: ImportRow[] = [];
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    for (const cell of lines[i]!) {
      const text = cell.trim();
      if (!text) continue;

      if (/^\d+\.\s+/.test(text) && !text.includes('?') && text.length < 60) {
        currentSection = text;
        continue;
      }

      if (text.includes('?') || /^(did|was|is)\s+(the\s+|our\s+)?(agent|adviser)/i.test(text)) {
        rows.push({
          line: i + 1,
          ready: true,
          notes: currentSection ? ['Ready'] : ['No section — it will be grouped as Unsectioned.'],
          item: {
            ...emptyItem(rows.length),
            label: text.replace(/\?$/, '').trim() + '?',
            section: currentSection,
          },
        });
      }
    }
  }
  return rows;
}

type ExportableItem = Pick<
  ScorecardItem,
  'label' | 'description' | 'score_type' | 'weight' | 'severity' | 'section' | 'item_type' |
  'expectation' | 'ai_check' | 'remediation_guidance' | 'consent_gate' |
  'consumer_duty_outcome' | 'vulnerability_related'
> & { applies_when?: { branch: string | string[] } | null };

/**
 * A scorecard's checkpoints as a CSV in exactly the columns import accepts, so
 * a firm can take their scorecard into a spreadsheet, work on it there, and
 * bring it back.
 */
export function scorecardItemsToCsv(items: ExportableItem[]): string {
  const rows: (string | number | boolean | null)[][] = [[...CSV_COLUMNS]];
  for (const item of items) {
    const branch = item.applies_when?.branch;
    rows.push([
      item.label,
      item.description ?? '',
      item.score_type,
      item.weight,
      item.severity ?? 'none',
      item.section ?? '',
      item.item_type,
      Array.isArray(branch) ? branch.join(', ') : (branch ?? ''),
      item.expectation ?? '',
      item.ai_check ?? '',
      item.remediation_guidance ?? '',
      item.consent_gate ? 'yes' : 'no',
      item.consumer_duty_outcome ?? '',
      item.vulnerability_related ? 'yes' : 'no',
    ]);
  }
  return toCsv(rows);
}

/** The blank starting point: one header row and one worked example under it. */
export function scorecardTemplateCsv(): string {
  return toCsv([
    [...CSV_COLUMNS],
    [
      'Told the customer the call was being recorded',
      'The adviser says the call is recorded before anything else is discussed.',
      'binary',
      1.5,
      'high',
      'Opening',
      'ai',
      '',
      'Must state that the call is recorded, before the fact find begins.',
      'The statement must be present and carry its full meaning.',
      'Call the customer back and tell them the call was recorded, then note the file.',
      'no',
      'consumer_understanding',
      'no',
    ],
  ]);
}

/** Save a CSV to the visitor's machine. No endpoint: the data is already here. */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM is what makes Excel open a UTF-8 CSV without mangling accents.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** "trust-point-qa-manual.csv" from "Trust Point QA manual". */
export function csvFilename(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'scorecard'}.csv`;
}
