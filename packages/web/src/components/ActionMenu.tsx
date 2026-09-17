import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown under the label — why an action is unavailable, or what it costs. */
  hint?: string;
  icon?: ReactNode;
}

/**
 * The page's less-used actions behind one control, so the header carries the
 * step the reviewer is actually on. Closes on Escape, on outside click, and
 * after a choice; arrow keys move through the items and focus returns to the
 * trigger (DESIGN_SYSTEM §7).
 */
export function ActionMenu({
  items,
  label = 'More actions',
}: {
  items: ActionMenuItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Opening with the keyboard should land on the first item, not leave focus
  // behind on the trigger with an open menu nobody is in.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const focusable = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        e.key === 'ArrowDown'
          ? (index + 1) % focusable.length
          : (index - 1 + focusable.length) % focusable.length;
      focusable[next]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="w-10 h-10 rounded-btn border border-border bg-card flex items-center justify-center text-text-secondary hover:bg-sidebar-hover hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <svg
          className="w-5 h-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-1.5 z-30 w-64 bg-card border border-border rounded-card shadow-lg p-1"
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
              className="w-full text-left px-3 py-2 rounded-btn flex items-start gap-2.5 text-table-cell text-text-primary hover:bg-sidebar-hover disabled:opacity-50 disabled:hover:bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
            >
              {item.icon && <span className="mt-0.5 text-text-secondary">{item.icon}</span>}
              <span className="min-w-0">
                <span className="block font-semibold">{item.label}</span>
                {item.hint && (
                  <span className="block text-xs text-text-secondary mt-0.5">{item.hint}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
