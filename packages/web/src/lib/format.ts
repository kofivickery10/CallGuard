// Shared display formatters. One home for these so pages don't each grow a
// slightly different variant (DESIGN_SYSTEM §4: shared recipes, not one-offs).

/**
 * Human-readable phone display. Stored numbers are E.164-normalised
 * ("+447700900123"); render UK numbers as "+44 7700 900123" and leave anything
 * unrecognised untouched rather than guessing.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('44') && digits.length === 12) {
    // +44 XXXX XXXXXX (UK mobile/geographic national significant number)
    return `+44 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  return raw.startsWith('+') ? raw : `+${digits}`;
}

/** mm:ss (or h:mm:ss over an hour). Accepts null/0 → "--". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return '--';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
