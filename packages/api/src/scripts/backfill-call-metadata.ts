// Backfill the two call-metadata gaps that migration 071's code fixes going
// forward but that existing rows still carry:
//
//   1. agent_id NULL where the dialler sent a short display name ("Lewis") and
//      the adviser is registered under their full name ("Lewis Moore"). Those
//      calls never appear under the adviser in reporting, and per-agent
//      learning context misses them. Matched only when EXACTLY ONE adviser in
//      the org matches — an ambiguous first name is left alone, because
//      attributing a compliance breach to the wrong adviser is worse than
//      leaving it unattributed.
//
//   2. speaker_integrity_flag on already-transcribed calls, so existing sales
//      surface the same "labels are unreliable" warning as new ones. Confidence
//      is lowered to match, which routes consent gates on those calls to manual
//      review on any future re-score.
//
// Deliberately does NOT re-score anything: re-scoring pushes to the tenant's
// Zoho QA record and rewrites their breach register, which is a separate,
// deliberate decision (see rescore-tenant-journeys.ts). This only corrects the
// metadata those decisions should be made from.
//
// Usage:
//   tsx src/scripts/backfill-call-metadata.ts                     # dry run, all orgs
//   tsx src/scripts/backfill-call-metadata.ts --org <uuid>        # dry run, one org
//   tsx src/scripts/backfill-call-metadata.ts --org <uuid> --commit
import { pool, query } from '../db/client.js';
import { assessSpeakerIntegrity, UNRELIABLE_SPEAKER_CONFIDENCE } from '../services/speaker-integrity.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function backfillAgentLinks(orgFilter: string | null, commit: boolean): Promise<void> {
  console.log('\n=== 1. Agent links ===');

  // Candidate calls: unlinked but carrying a name we could match on.
  const unlinked = await query<{
    organization_id: string;
    agent_name: string;
    n: string;
  }>(
    `SELECT organization_id, agent_name, count(*)::text AS n
       FROM calls
      WHERE agent_id IS NULL
        AND agent_name IS NOT NULL
        AND trim(agent_name) <> ''
        AND ($1::uuid IS NULL OR organization_id = $1)
      GROUP BY organization_id, agent_name
      ORDER BY count(*) DESC`,
    [orgFilter]
  );

  if (unlinked.length === 0) {
    console.log('No unlinked calls with an agent name.');
    return;
  }

  for (const row of unlinked) {
    const firstWord = row.agent_name.trim().split(/\s+/)[0]!;
    if (firstWord.length < 3) {
      console.log(`  "${row.agent_name}" (${row.n} calls): first token too short to match safely — skipped`);
      continue;
    }

    const candidates = await query<{ id: string; name: string }>(
      `SELECT id, name FROM users
         WHERE organization_id = $1
           AND lower(name) LIKE lower($2) || ' %'
         LIMIT 3`,
      [row.organization_id, firstWord]
    );

    if (candidates.length === 0) {
      console.log(`  "${row.agent_name}" (${row.n} calls): no adviser matches — skipped`);
      continue;
    }
    if (candidates.length > 1) {
      console.log(
        `  "${row.agent_name}" (${row.n} calls): AMBIGUOUS (${candidates.map((c) => c.name).join(', ')}) — skipped`
      );
      continue;
    }

    const match = candidates[0]!;
    console.log(`  "${row.agent_name}" (${row.n} calls) -> ${match.name} [${match.id}]`);
    if (commit) {
      const updated = await query<{ id: string }>(
        `UPDATE calls SET agent_id = $1, updated_at = now()
           WHERE organization_id = $2 AND agent_id IS NULL
             AND lower(trim(agent_name)) = lower(trim($3))
         RETURNING id`,
        [match.id, row.organization_id, row.agent_name]
      );
      console.log(`    linked ${updated.length} call(s)`);
    }
  }
}

async function backfillSpeakerIntegrity(orgFilter: string | null, commit: boolean): Promise<void> {
  console.log('\n=== 2. Speaker integrity ===');

  const calls = await query<{
    id: string;
    organization_id: string;
    transcript_text: string;
    speaker_attribution_confidence: string | null;
  }>(
    `SELECT id, organization_id, transcript_text, speaker_attribution_confidence
       FROM calls
      WHERE transcript_text IS NOT NULL
        AND speaker_integrity_flag IS NULL
        AND ($1::uuid IS NULL OR organization_id = $1)
      ORDER BY created_at DESC`,
    [orgFilter]
  );

  console.log(`Assessing ${calls.length} transcribed call(s)...`);

  const byFlag = new Map<string, number>();
  let flaggedTotal = 0;

  for (const call of calls) {
    // The stored transcript has already been through cleanup, and we no longer
    // know what verdict that pass returned. Pass 'unclear' so the assessment
    // rests purely on content — the 'model_verdict_conflict' escalation only
    // applies where we can actually see a 'confirmed' to contradict.
    const result = assessSpeakerIntegrity(call.transcript_text, 'unclear');
    if (!result.flag) continue;

    flaggedTotal++;
    byFlag.set(result.flag, (byFlag.get(result.flag) ?? 0) + 1);
    const current = call.speaker_attribution_confidence
      ? Number(call.speaker_attribution_confidence)
      : null;
    const lowered = current === null ? UNRELIABLE_SPEAKER_CONFIDENCE : Math.min(current, UNRELIABLE_SPEAKER_CONFIDENCE);

    console.log(`  ${call.id}: ${result.flag} (confidence ${current ?? 'null'} -> ${lowered})`);
    console.log(`    ${result.detail}`);

    if (commit) {
      await query(
        `UPDATE calls
            SET speaker_integrity_flag = $2,
                speaker_attribution_confidence = $3,
                updated_at = now()
          WHERE id = $1`,
        [call.id, result.flag, lowered]
      );
    }
  }

  console.log(`\nFlagged ${flaggedTotal} of ${calls.length} call(s):`);
  for (const [flag, n] of [...byFlag].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flag}: ${n}`);
  }

  // Which sales those calls belong to — the operator's list of scores to
  // reconsider, since a flagged call may have produced a false breach.
  if (flaggedTotal > 0 && commit) {
    const affected = await query<{ journey_id: string; scored_at: string | null; overall_score: string | null }>(
      `SELECT DISTINCT j.id AS journey_id, j.scored_at, j.overall_score::text
         FROM journeys j
         JOIN journey_calls jc ON jc.journey_id = j.id
         JOIN calls c ON c.id = jc.call_id
        WHERE c.speaker_integrity_flag IS NOT NULL
          AND j.status = 'scored'
          AND ($1::uuid IS NULL OR j.organization_id = $1)
        ORDER BY j.scored_at DESC NULLS LAST`,
      [orgFilter]
    );
    console.log(`\n${affected.length} scored sale(s) include at least one flagged call:`);
    for (const a of affected.slice(0, 50)) {
      console.log(`  ${a.journey_id}  score=${a.overall_score ?? '-'}  scored=${a.scored_at ?? '-'}`);
    }
    if (affected.length > 50) console.log(`  ... and ${affected.length - 50} more`);
    console.log('\nRe-score deliberately NOT triggered — it rewrites the breach register and');
    console.log('pushes to the CRM. Use rescore-tenant-journeys.ts when you have decided to.');
  }
}

async function main() {
  const orgFilter = arg('--org');
  const commit = process.argv.includes('--commit');

  console.log(commit ? 'MODE: COMMIT' : 'MODE: DRY RUN (pass --commit to apply)');
  console.log(`ORG:  ${orgFilter ?? 'all'}`);

  await backfillAgentLinks(orgFilter, commit);
  await backfillSpeakerIntegrity(orgFilter, commit);

  if (!commit) console.log('\nDRY RUN — nothing written.');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
