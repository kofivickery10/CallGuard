import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError } from '../lib/lazyWithRetry';

interface Props {
  children: ReactNode;
  /** Change this (the route path) to clear a caught error — lets the user navigate away. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/*
 * Last line of defence for the blank screen. lazyWithRetry already reloads once
 * on a stale chunk, so anything reaching here is either a chunk that is still
 * missing after that reload (show "new version — reload") or a real render error
 * in the page (show the error, keep the shell usable).
 */
export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page failed to render:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    // Navigating to another page should get a fresh attempt rather than leaving
    // the error card pinned in place for the rest of the session.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stale = isChunkLoadError(error);

    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center gap-3 rounded-card border border-border bg-card px-6 py-12 text-center shadow-card"
      >
        <svg
          className={stale ? 'h-8 w-8 text-primary' : 'h-8 w-8 text-fail'}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {stale ? (
            <>
              <path d="M21 12a9 9 0 1 1-3.2-6.9" />
              <path d="M21 3v5h-5" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4.5" />
              <path d="M12 16h.01" />
            </>
          )}
        </svg>

        <p className="text-section-title text-text-primary">
          {stale ? 'A new version of CallGuard is available' : 'This page failed to load'}
        </p>
        <p className="max-w-md text-table-cell text-text-secondary">
          {stale
            ? 'This tab is running an older build. Reload to pick up the latest version — nothing has been lost.'
            : 'Something went wrong while rendering this page. Reload to try again; if it keeps happening, contact support.'}
        </p>

        <button
          type="button"
          onClick={this.reload}
          className="mt-1 rounded-btn bg-primary px-[18px] py-[9px] text-table-cell font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label="Reload the page"
        >
          Reload page
        </button>
      </div>
    );
  }
}
