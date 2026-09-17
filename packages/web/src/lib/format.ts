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

/**
 * A stored key as a person reads it: "on_risk" → "On risk".
 *
 * Branches and other per-tenant keys are configured as identifiers and stored
 * verbatim, so the raw value is what every filter and report has to send — but
 * nobody outside the database calls a sale "on_risk". Display only: never feed
 * the result back to the API.
 */
export function humanLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  const spaced = raw.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * mm:ss for a playback position, where 0 is a real value ("0:00") rather than
 * the absent duration formatDuration renders as "--".
 */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
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
