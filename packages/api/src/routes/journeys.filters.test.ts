import { describe, it, expect } from 'vitest';
import { buildWhere, type JourneyFilter } from './journeys.js';

// The sales list builds its WHERE from fragments and then rebuilds it with one
// fragment REMOVED, so each filter tab can count what clicking it would return.
//
// Pre-numbering the placeholders made that impossible and shipped a live bug:
// dropping `j.status = $2` left a statement referencing only $1 while two
// parameters were still bound, and Postgres refuses the bind — "bind message
// supplies 2 parameters, but prepared statement requires 1". Every ?status=
// request on the sales screen 500'd, under a comment claiming Postgres allowed
// it. These tests pin the invariant that actually matters: the highest $n a
// rendered statement references always equals the number of parameters returned
// with it.

// The property that was violated in production.
function assertBalanced(built: { sql: string; params: unknown[] }): void {
  const referenced = [...built.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const highest = referenced.length ? Math.max(...referenced) : 0;
  expect(highest).toBe(built.params.length);
  // Every placeholder from 1..n is used — no holes left by a dropped fragment.
  for (let i = 1; i <= built.params.length; i++) {
    expect(referenced).toContain(i);
  }
}

const filters: JourneyFilter[] = [
  { key: 'org', sql: 'j.organization_id = ?', params: ['org-1'] },
  { key: 'status', sql: 'j.status = ?', params: ['scored'] },
  { key: 'branch', sql: 'j.branch = ?', params: ['London'] },
  { key: 'feedback', sql: 'feedback_status_sql = ?', params: ['awaiting'] },
];

describe('buildWhere', () => {
  it('numbers placeholders in order across fragments', () => {
    const built = buildWhere(filters);
    expect(built.sql).toBe(
      'j.organization_id = $1 AND j.status = $2 AND j.branch = $3 AND feedback_status_sql = $4'
    );
    expect(built.params).toEqual(['org-1', 'scored', 'London', 'awaiting']);
    assertBalanced(built);
  });

  // The regression. Before this, the statement kept $1 and dropped $2's clause
  // while both parameters stayed bound.
  it('renumbers and drops the parameter when a fragment is excluded', () => {
    const built = buildWhere(filters, 'status');
    expect(built.sql).toBe(
      'j.organization_id = $1 AND j.branch = $2 AND feedback_status_sql = $3'
    );
    expect(built.params).toEqual(['org-1', 'London', 'awaiting']);
    assertBalanced(built);
  });

  it('stays balanced whichever fragment is excluded', () => {
    for (const key of ['org', 'status', 'branch', 'feedback', 'not-a-key']) {
      assertBalanced(buildWhere(filters, key));
    }
  });

  // `j.pass IS TRUE` carries no parameter — it must not consume a placeholder
  // or shift the numbering of the fragments after it.
  it('handles a parameterless fragment without shifting the numbering', () => {
    const built = buildWhere([
      { key: 'org', sql: 'j.organization_id = ?', params: ['org-1'] },
      { key: 'result', sql: 'j.pass IS TRUE', params: [] },
      { key: 'status', sql: 'j.status = ?', params: ['scored'] },
    ]);
    expect(built.sql).toBe('j.organization_id = $1 AND j.pass IS TRUE AND j.status = $2');
    expect(built.params).toEqual(['org-1', 'scored']);
    assertBalanced(built);
  });

  it('handles a fragment carrying more than one parameter', () => {
    const built = buildWhere([
      { key: 'org', sql: 'j.organization_id = ?', params: ['org-1'] },
      { key: 'range', sql: 'd >= ?::date AND d < ?::date', params: ['2026-01-01', '2026-02-01'] },
    ]);
    expect(built.sql).toBe('j.organization_id = $1 AND d >= $2::date AND d < $3::date');
    expect(built.params).toEqual(['org-1', '2026-01-01', '2026-02-01']);
    assertBalanced(built);
  });

  it('returns an empty statement for no filters', () => {
    const built = buildWhere([]);
    expect(built.sql).toBe('');
    expect(built.params).toEqual([]);
  });
});
