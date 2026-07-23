// Single UUID validator for the API. Anchored with dash positions — a loose
// "36 chars of hex-or-dash" pattern admits strings Postgres's ::uuid cast
// rejects, turning a bad stored id into a 500 instead of a dropped entry.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
