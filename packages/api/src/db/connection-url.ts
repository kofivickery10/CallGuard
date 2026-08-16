/**
 * Removes any `sslmode` query parameter from a Postgres connection string,
 * leaving every other part of the URL — credentials, host, path, and the
 * remaining query parameters — untouched and in their original order.
 *
 * Used by client.ts (which applies SSL config to `pg` explicitly instead of
 * via the connection string — see the comment there) and mirrored in
 * scripts/backup.sh for pg_dump, which doesn't understand the pg-npm-only
 * `sslmode=no-verify`/`true` aliases.
 *
 * This used to be a regex matching "sslmode=" and its value, plus cleanup
 * passes for a leftover leading/trailing `&`, which only produced a well-formed query
 * string when `sslmode` happened to be the last parameter. Parsing the URL
 * properly instead means parameter order never matters, and credentials
 * that contain URL-special characters are round-tripped as-is (the WHATWG
 * URL parser keeps `username`/`password` in their original percent-encoded
 * form; nothing here re-encodes them).
 */
export function stripSslModeParam(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Not a parseable absolute URL — nothing we can safely strip from it,
    // so hand it back unchanged rather than throw.
    return rawUrl;
  }

  const keysToDelete = new Set(
    [...parsed.searchParams.keys()].filter((key) => key.toLowerCase() === 'sslmode')
  );
  for (const key of keysToDelete) {
    parsed.searchParams.delete(key);
  }

  return parsed.toString();
}
