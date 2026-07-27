import { lazy, type ComponentType } from 'react';

/*
 * Route chunks are content-hashed, so a deploy renames every one of them. A tab
 * that was loaded before the deploy still holds the old index.html and asks for
 * chunk names that no longer exist — the import rejects and the route renders
 * nothing. This wrapper turns that into a single automatic reload, which pulls
 * the new index.html and the new hashes. Anything that is not a chunk-load
 * failure (or a second failure straight after a reload) is rethrown for
 * ChunkErrorBoundary to show.
 */

const RELOAD_KEY = 'cg:chunk-reload-at';
// A reload recorded inside this window means the reload already happened and did
// not fix it — stop, so a genuinely missing chunk can't loop the tab.
const RELOAD_WINDOW_MS = 20_000;

/** Matches the browser-specific wording for "the module I asked for isn't valid JS". */
export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return (
    /dynamically imported module/i.test(message) ||     // Chrome, Safari
    /Importing a module script failed/i.test(message) || // Safari
    /Failed to load module script/i.test(message) ||     // MIME-type rejection
    /error loading dynamically imported module/i.test(message) || // Firefox
    /Loading chunk \d+ failed/i.test(message)
  );
}

function readReloadStamp(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {
    return 0; // sessionStorage blocked (private mode / third-party context)
  }
}

function writeReloadStamp(value: number | null): void {
  try {
    if (value === null) sessionStorage.removeItem(RELOAD_KEY);
    else sessionStorage.setItem(RELOAD_KEY, String(value));
  } catch {
    // Nothing to do — worst case the boundary prompts a manual reload.
  }
}

// `any` mirrors React.lazy's own signature — route components take no props.
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      const mod = await factory();
      writeReloadStamp(null); // chunks resolve again — arm the guard for the next deploy
      return mod;
    } catch (err) {
      if (!isChunkLoadError(err)) throw err;

      const lastReload = readReloadStamp();
      if (Date.now() - lastReload > RELOAD_WINDOW_MS) {
        writeReloadStamp(Date.now());
        window.location.reload();
        // Never settles: keeps the Suspense fallback on screen until the reload
        // takes over, instead of flashing the error state on the way out.
        return new Promise<{ default: T }>(() => {});
      }

      throw err;
    }
  });
}
