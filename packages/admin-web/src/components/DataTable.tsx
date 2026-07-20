import { useState, type ReactNode } from 'react';

// Lightweight client-side table controls: sort, search, and pagination over an
// in-memory row array (the superadmin lists are fetched whole, so this needs no
// server round-trips). Pages keep their own custom cell rendering; this only
// supplies the derived rows and the header/pagination chrome.

export type SortDir = 'asc' | 'desc';

interface TableControlsOptions<T> {
  initialSortKey: string;
  initialSortDir?: SortDir;
  // Fields matched (case-insensitively) by the search box.
  searchFields?: (keyof T)[];
  pageSize?: number;
  // Value to sort a row by for a given column key. Default reads row[key].
  // Provide this for numeric-string columns (return Number) or derived columns.
  sortValue?: (row: T, key: string) => string | number;
}

export function useTableControls<T>(rows: T[], opts: TableControlsOptions<T>) {
  const [sortKey, setSortKey] = useState(opts.initialSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(opts.initialSortDir ?? 'asc');
  const [search, setSearchState] = useState('');
  const [page, setPage] = useState(1);

  const pageSize = opts.pageSize ?? 25;
  const sortValue = opts.sortValue ?? ((r: T, k: string) => r[k as keyof T] as unknown as string | number);

  const q = search.trim().toLowerCase();
  const filtered =
    q && opts.searchFields?.length
      ? rows.filter((r) => opts.searchFields!.some((f) => String(r[f] ?? '').toLowerCase().includes(q)))
      : rows;

  const sorted = [...filtered].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = sorted.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  return {
    pageRows,
    total: sorted.length,
    totalPages,
    page: clampedPage,
    setPage,
    sortKey,
    sortDir,
    toggleSort: (key: string) => {
      if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortKey(key);
        setSortDir('asc');
      }
      setPage(1);
    },
    search,
    setSearch: (v: string) => {
      setSearchState(v);
      setPage(1);
    },
  };
}

// A sortable <th>. Non-sortable columns (e.g. an action column) should use a
// plain <th> instead.
export function SortHead({
  label,
  columnKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
}: {
  label: ReactNode;
  columnKey: string;
  activeKey: string;
  dir: SortDir;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
}) {
  const active = activeKey === columnKey;
  return (
    <th className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        aria-label={`Sort by ${typeof label === 'string' ? label : columnKey}`}
        className={`inline-flex items-center gap-1 hover:text-text-secondary rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        <span>{label}</span>
        <svg
          viewBox="0 0 24 24"
          className={`w-3 h-3 transition-opacity ${active ? 'opacity-100 text-text-secondary' : 'opacity-30'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {active && dir === 'asc' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}
        </svg>
      </button>
    </th>
  );
}

// Footer pagination row. Renders nothing when everything fits on one page.
export function TablePagination({
  page,
  totalPages,
  total,
  onPage,
  noun = 'rows',
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  if (totalPages <= 1) {
    return (
      <div className="px-4 py-2.5 border-t border-border text-xs text-text-muted">
        {total} {noun}
      </div>
    );
  }
  const btn =
    'px-2.5 py-1 rounded-btn border border-border text-text-secondary hover:bg-sidebar-hover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-xs text-text-muted">
      <span>{total} {noun}</span>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          Prev
        </button>
        <span aria-live="polite">
          Page {page} of {totalPages}
        </span>
        <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next
        </button>
      </div>
    </div>
  );
}

// Search input for a table toolbar.
export function TableSearch({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="border border-border rounded-btn px-3 py-1.5 text-sm bg-card text-text-primary placeholder:text-text-muted focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    />
  );
}
