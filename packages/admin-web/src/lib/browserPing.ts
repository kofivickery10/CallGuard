// Lightweight desktop notifications via the Web Notifications API.
//
// No service worker: these fire only while a browser tab is open (foreground OR
// background). They do NOT wake a closed browser — that would need Web Push
// (service worker + VAPID + a push-subscription backend), a much larger build.

export function canNotify(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// Ask for permission. Call this from a user gesture (e.g. visiting support) so the
// browser prompt isn't suppressed. Safe to call repeatedly.
export async function ensureNotifyPermission(): Promise<boolean> {
  if (!canNotify()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

// Fire a ping. No-op when permission is missing or the tab is already focused —
// if the user is looking at the app, the in-app badge is enough.
export function ping(title: string, body: string): void {
  if (!canNotify() || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    // Shared tag collapses repeat pings into one popup instead of stacking.
    const n = new Notification(title, { body, tag: 'callguard-support' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some engines throw if constructed outside a service-worker context */
  }
}

// Track an unread count across renders and ping when it rises. Pass the previous
// value (held in a ref) and get the new value back to store. Skips the first
// observation (prev === null) so pre-existing unread on load doesn't ping.
export function pingOnIncrease(
  prev: number | null,
  next: number,
  title: string,
  body: string
): number {
  if (prev !== null && next > prev) ping(title, body);
  return next;
}
