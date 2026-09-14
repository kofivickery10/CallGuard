// Re-derive every sale's wrap-up call under the current rule
// (services/journey.ts chooseWrapUpCall), for sales assembled while the wrap-up
// was simply the latest call in the window, however short.
//
// The wrap-up decides who closed the sale — the dashboard's adviser, the Zoho QA
// record's owner, the default feedback recipient — so moving it changes who is
// credited as soon as it commits. It does NOT re-score, does NOT push to Zoho and
// does NOT re-send feedback. The report lists what needs a person: sales worth
// re-scoring (admin "Re-score" button, or rescore-tenant-journeys.ts), and sales
// whose feedback went to an adviser the sale will no longer be credited to —
// those still read as fed back, so nobody is prompted to tell the new adviser.
// Sales mid-scoring are left alone; score-journey re-derives the wrap-up itself.
//
// Usage:
//   tsx src/scripts/rederive-wrap-up.ts                           # dry run, every org
//   tsx src/scripts/rederive-wrap-up.ts --org=<organizationId>    # dry run, one org
//   tsx src/scripts/rederive-wrap-up.ts [--org=<id>] --commit     # apply
import { pool, query, withTransaction } from '../db/client.js';
import { chooseWrapUpCall, setWrapUpRole } from '../services/wrap-up.js';

interface Row {
  journey_id: string;
  org_name: string;
  status: string;
  overall_score: string | null;
  call_id: string;
  role: string;
  duration_seconds: string | null;
  call_date: string | null;
  created_at: string;
  agent_id: string | null;
  agent_name: string | null;
}

interface FeedbackRow {
  journey_id: string;
  adviser_user_id: string | null;
  adviser_name: string | null;
  acknowledged: boolean;
}

function describeCall(c: Row | undefined): string {
  if (!c) return '(none)';
  const mins = c.duration_seconds === null ? '?' : (Number(c.duration_seconds) / 60).toFixed(1);
  return `${c.call_id.slice(0, 8)} ${mins} min, ${c.agent_name ?? 'no agent'}${c.agent_id ? '' : ' (unlinked)'}`;
}

// Dashboards and the Zoho owner go by agent_id; the display name alone misses a
// move between a linked call and an unlinked one under the same name.
function sameAdviser(a: Row | undefined, b: Row): boolean {
  return (a?.agent_id ?? null) === b.agent_id && (a?.agent_name ?? null) === b.agent_name;
}

function feedbackReachedAdviser(f: FeedbackRow, closer: Row): boolean {
  if (f.adviser_user_id && closer.agent_id) return f.adviser_user_id === closer.agent_id;
  return (f.adviser_name ?? '').trim().toLowerCase() === (closer.agent_name ?? '').trim().toLowerCase();
}

async function main() {
  const commit = process.argv.includes('--commit');
  const org = process.argv.find((a) => a.startsWith('--org='))?.slice('--org='.length) ?? null;

  const rows = await query<Row>(
    `SELECT j.id AS journey_id, o.name AS org_name, j.status, j.overall_score,
            c.id AS call_id, jc.role, c.duration_seconds, c.call_date, c.created_at,
            c.agent_id, c.agent_name
       FROM journeys j
       JOIN organizations o ON o.id = j.organization_id
       JOIN journey_calls jc ON jc.journey_id = j.id
       JOIN calls c ON c.id = jc.call_id
      WHERE ($1::uuid IS NULL OR j.organization_id = $1)
      ORDER BY j.created_at`,
    [org]
  );
  const feedback = await query<FeedbackRow>(
    `SELECT f.journey_id, f.adviser_user_id, f.adviser_name, f.confirmed_at IS NOT NULL AS acknowledged
       FROM journey_feedback f
      WHERE ($1::uuid IS NULL OR f.organization_id = $1)`,
    [org]
  );

  const byJourney = new Map<string, Row[]>();
  for (const r of rows) byJourney.set(r.journey_id, [...(byJourney.get(r.journey_id) ?? []), r]);
  const feedbackByJourney = new Map<string, FeedbackRow[]>();
  for (const f of feedback) feedbackByJourney.set(f.journey_id, [...(feedbackByJourney.get(f.journey_id) ?? []), f]);

  const moves: { journeyId: string; from: Row | undefined; to: Row; first: Row; strandedFeedback: FeedbackRow[] }[] = [];
  for (const [journeyId, calls] of byJourney) {
    const current = calls.find((c) => c.role === 'wrap_up');
    const chosen = chooseWrapUpCall(calls.map((c) => ({ ...c, id: c.call_id })));
    if (chosen && chosen.call_id !== current?.call_id) {
      const sent = feedbackByJourney.get(journeyId) ?? [];
      const strandedFeedback = sent.length > 0 && !sent.some((f) => feedbackReachedAdviser(f, chosen)) ? sent : [];
      moves.push({ journeyId, from: current, to: chosen, first: calls[0]!, strandedFeedback });
    }
  }

  console.log(`${byJourney.size} sale(s) checked, ${moves.length} wrap-up(s) to move.\n`);
  for (const m of moves) {
    const lines = [
      `${m.journeyId}  ${m.first.org_name}  [${m.first.status}, score ${m.first.overall_score ?? 'none'}]`,
      `  from: ${describeCall(m.from)}`,
      `  to:   ${describeCall(m.to)}${sameAdviser(m.from, m.to) ? '' : '   <- adviser changes'}`,
    ];
    for (const f of m.strandedFeedback) {
      lines.push(`  feedback went to ${f.adviser_name ?? 'unknown'}${f.acknowledged ? ' (acknowledged)' : ''}, not the new closer`);
    }
    console.log(lines.join('\n'));
  }

  const rescore = moves.filter(
    (m) => m.first.status === 'scored' && (m.first.overall_score === null || !sameAdviser(m.from, m.to))
  );
  if (rescore.length > 0) {
    console.log(
      `\nWorth re-scoring once applied (held with no score, or the Zoho QA owner would be stale):\n` +
        rescore.map((m) => `  ${m.journeyId}`).join('\n')
    );
  }
  const stranded = moves.filter((m) => m.strandedFeedback.length > 0);
  if (stranded.length > 0) {
    console.log(
      `\nFeedback to re-send — these still read as fed back, but the adviser now credited never received it:\n` +
        stranded.map((m) => `  ${m.journeyId}  (now ${m.to.agent_name ?? 'no agent'})`).join('\n')
    );
  }

  if (!commit) {
    console.log('\nDRY RUN — nothing changed. Re-run with --commit to apply.');
    return;
  }

  let applied = 0;
  for (const m of moves) {
    if (m.first.status === 'scoring') {
      console.log(`skip ${m.journeyId}: scoring now, and score-journey re-derives the wrap-up itself`);
      continue;
    }
    await withTransaction((tx) => setWrapUpRole(tx, m.journeyId));
    applied++;
  }
  console.log(
    `\nApplied ${applied} wrap-up move(s). Nothing re-scored, nothing pushed to Zoho, no feedback sent.`
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
