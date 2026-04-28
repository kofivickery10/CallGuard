/**
 * Demo data seed script.
 *
 * Creates a fully populated demo environment:
 *   - Org: "Acme Financial Planning"
 *   - Admin: demo@callguard.app / password123
 *   - 8 agents with varying risk profiles
 *   - 1 scorecard with 15 items
 *   - KB content (3 sections filled)
 *   - 50 calls with varying scores + breaches + item scores
 *   - 1 alert rule
 *   - Some notifications
 *
 * Usage:
 *   npm run seed-demo --workspace=packages/api
 *   npm run seed-demo --workspace=packages/api -- --reset
 */

import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { pool, query, queryOne } from '../db/client.js';

const DEMO_ORG = 'Acme Financial Planning';
const DEMO_ADMIN_EMAIL = 'demo@callguard.app';
const DEMO_ADMIN_PASSWORD = 'password123';

const AGENTS = [
  { name: 'Neha Patel', email: 'neha.patel@acme.example', profile: 'star' },        // 0 breaches
  { name: 'Sarah Mitchell', email: 'sarah.mitchell@acme.example', profile: 'good' }, // 1 medium
  { name: 'James Okafor', email: 'james.okafor@acme.example', profile: 'good' },
  { name: 'Amy Blackwell', email: 'amy.blackwell@acme.example', profile: 'average' },
  { name: 'David Park', email: 'david.park@acme.example', profile: 'average' },
  { name: 'Rachel Kim', email: 'rachel.kim@acme.example', profile: 'average' },
  { name: 'Tom Richards', email: 'tom.richards@acme.example', profile: 'elevated' },   // 2 high
  { name: 'Marcus Webb', email: 'marcus.webb@acme.example', profile: 'high_risk' },   // 3 critical
];

const SCORECARD_ITEMS = [
  { label: 'Adviser identity and FCA authorisation disclosed', weight: 1.0, severity: 'medium' },
  { label: 'Purpose of call confirmed with client', weight: 1.0, severity: 'medium' },
  { label: 'Client objectives identified', weight: 1.5, severity: 'high' },
  { label: 'Attitude to investment risk explored', weight: 2.0, severity: 'critical' },
  { label: 'Capacity for loss assessed', weight: 2.0, severity: 'critical' },
  { label: 'Investment time horizon confirmed', weight: 1.5, severity: 'high' },
  { label: 'Existing arrangements reviewed', weight: 1.5, severity: 'high' },
  { label: 'Vulnerable client indicators screened', weight: 2.0, severity: 'critical' },
  { label: 'Charges and costs disclosed clearly', weight: 1.5, severity: 'high' },
  { label: 'Conflicts of interest disclosed', weight: 1.0, severity: 'medium' },
  { label: 'Recommendation linked to objectives', weight: 1.5, severity: 'high' },
  { label: 'Client given opportunity to ask questions', weight: 1.0, severity: 'medium' },
  { label: 'Cancellation and cooling-off rights explained', weight: 1.0, severity: 'medium' },
  { label: 'Next steps and documentation confirmed', weight: 1.0, severity: 'medium' },
  { label: 'No high-pressure or urgency language used', weight: 2.5, severity: 'critical' },
];

const KB_SECTIONS: Record<string, string> = {
  company_overview: `Acme Financial Planning is a UK-regulated IFA network with 38 advisers across 12 regional offices. We provide regulated advice on pensions, investments, protection, and mortgages. Our tone is professional, plain-English, and client-first.`,
  products: `We advise on the full retail product range:
- **Pensions**: SIPPs (Aegon, AJ Bell), personal pensions, DB transfer advice (specialist team only)
- **Investments**: ISAs, GIA, bonds via platform (primary: Transact)
- **Protection**: Life, critical illness, income protection (panel of insurers)
- **Mortgages**: Residential and BTL via panel broker agreement

Typical portfolio split is 40% equity / 30% bonds / 20% alternatives / 10% cash for a medium-risk retirement client.`,
  compliance: `## Mandatory elements of every advice call

1. Adviser identity, firm name, FCA number (stated within 30 seconds)
2. Call recording disclosure
3. Full fact-find before recommendation (objectives, risk, capacity for loss, time horizon)
4. Vulnerable client screening (bereavement, cognitive, financial distress - apply protocol)
5. Complete charges disclosure (aggregated monetary illustration, not just %)
6. Cooling-off rights clearly stated
7. Recommendation explicitly linked back to stated client objectives
8. NO urgency language ("closing window", "limited time") - CRITICAL FAIL

Pension transfers require specialist pathway and additional signoff.`,
};

function parseArgs(): { reset: boolean } {
  return { reset: process.argv.includes('--reset') };
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  const { reset } = parseArgs();
  console.log('CallGuard demo seed starting...\n');

  // Check if demo org exists
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM organizations WHERE name = $1`,
    [DEMO_ORG]
  );

  if (existing) {
    if (!reset) {
      console.log(`Demo org "${DEMO_ORG}" already exists.`);
      console.log('Run with --reset to wipe and recreate:');
      console.log('  npm run seed-demo --workspace=packages/api -- --reset\n');
      process.exit(0);
    }
    console.log(`[reset] Deleting existing "${DEMO_ORG}"...`);
    // Delete in FK dependency order (calls first to free agent_id references)
    await query(`DELETE FROM score_corrections WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM insight_digests WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM calls WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM scorecards WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM knowledge_base_sections WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM alert_rules WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM notifications WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM api_keys WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM sftp_sources WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM breaches WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM users WHERE organization_id = $1`, [existing.id]);
    await query(`DELETE FROM organizations WHERE id = $1`, [existing.id]);
    console.log('  Deleted. Related rows cleared.\n');
  }

  // 1. Create org (Pro plan so demo shows all features: coaching, ai_learning, insights)
  const org = await queryOne<{ id: string }>(
    `INSERT INTO organizations (name, plan) VALUES ($1, 'pro') RETURNING id`,
    [DEMO_ORG]
  );
  const orgId = org!.id;
  console.log(`[org]   ${DEMO_ORG} (${orgId.slice(0, 8)}...)`);

  // 2. Admin user
  const adminHash = await bcrypt.hash(DEMO_ADMIN_PASSWORD, 12);
  const admin = await queryOne<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
    [orgId, DEMO_ADMIN_EMAIL, 'Demo Admin', adminHash]
  );
  const adminId = admin!.id;
  console.log(`[admin] ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);

  // 3. Agents
  const agentHash = await bcrypt.hash('agent123', 12);
  const agents: { id: string; name: string; profile: string }[] = [];
  for (const a of AGENTS) {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'member') RETURNING id`,
      [orgId, a.email, a.name, agentHash]
    );
    agents.push({ id: row!.id, name: a.name, profile: a.profile });
  }
  console.log(`[agents] ${agents.length} created (password: agent123)`);

  // 4. Scorecard
  const sc = await queryOne<{ id: string }>(
    `INSERT INTO scorecards (organization_id, name, description, is_active, created_by)
     VALUES ($1, $2, $3, true, $4) RETURNING id`,
    [orgId, 'Financial Planning QA', 'FCA-aligned scorecard for investment and pension advice calls', adminId]
  );
  const scorecardId = sc!.id;
  const scorecardItems: { id: string; label: string; weight: number; severity: string }[] = [];
  for (let i = 0; i < SCORECARD_ITEMS.length; i++) {
    const item = SCORECARD_ITEMS[i]!;
    const row = await queryOne<{ id: string }>(
      `INSERT INTO scorecard_items (scorecard_id, label, description, score_type, weight, sort_order, severity)
       VALUES ($1, $2, $3, 'binary', $4, $5, $6) RETURNING id`,
      [scorecardId, item.label, `Rubric for: ${item.label}`, item.weight, i, item.severity]
    );
    scorecardItems.push({ id: row!.id, ...item });
  }
  console.log(`[scorecard] Financial Planning QA (${scorecardItems.length} items)`);

  // 5. KB sections
  for (const [type, content] of Object.entries(KB_SECTIONS)) {
    await query(
      `INSERT INTO knowledge_base_sections (organization_id, section_type, content)
       VALUES ($1, $2, $3)`,
      [orgId, type, content]
    );
  }
  console.log(`[kb]    3 sections filled`);

  // 6. Calls with scores and breaches
  const transcriptTemplates = [
    `Agent: Hello, thank you for calling Acme Financial Planning. I'm {name}, FCA number 487291. This call may be recorded for compliance and training purposes.

Customer: Hi, yes I'd like to go ahead with the investment you mentioned.

Agent: Perfect. Before we proceed, I just want to confirm a few things about your objectives and risk tolerance...`,
    `Agent: Good morning, this is {name} from Acme. Just to confirm, this call is recorded. How can I help today?

Customer: I want to transfer my pension.

Agent: Absolutely. A few questions before we discuss the options - can you tell me about your current arrangements?`,
  ];

  type CallSpec = { status: 'scored' | 'failed' | 'processing'; overallScore?: number; failingItems?: number };

  // Build per-agent specs based on risk profile
  function agentCallSpecs(profile: string): CallSpec[] {
    const specs: CallSpec[] = [];
    const totalCalls = randBetween(4, 8);

    switch (profile) {
      case 'star':
        for (let i = 0; i < totalCalls; i++) specs.push({ status: 'scored', overallScore: randBetween(90, 98), failingItems: 0 });
        break;
      case 'good':
        for (let i = 0; i < totalCalls; i++) {
          if (i === 0) specs.push({ status: 'scored', overallScore: randBetween(70, 78), failingItems: 1 });
          else specs.push({ status: 'scored', overallScore: randBetween(82, 95), failingItems: 0 });
        }
        break;
      case 'average':
        for (let i = 0; i < totalCalls; i++) {
          if (i < 2) specs.push({ status: 'scored', overallScore: randBetween(60, 72), failingItems: randBetween(1, 2) });
          else specs.push({ status: 'scored', overallScore: randBetween(78, 92), failingItems: 0 });
        }
        break;
      case 'elevated':
        for (let i = 0; i < totalCalls; i++) {
          if (i < 2) specs.push({ status: 'scored', overallScore: randBetween(55, 68), failingItems: 2 });
          else if (i < 4) specs.push({ status: 'scored', overallScore: randBetween(72, 84), failingItems: 1 });
          else specs.push({ status: 'scored', overallScore: randBetween(82, 90), failingItems: 0 });
        }
        break;
      case 'high_risk':
        for (let i = 0; i < totalCalls; i++) {
          if (i < 3) specs.push({ status: 'scored', overallScore: randBetween(42, 55), failingItems: 4 });
          else if (i < 5) specs.push({ status: 'scored', overallScore: randBetween(60, 72), failingItems: 2 });
          else specs.push({ status: 'scored', overallScore: randBetween(76, 85), failingItems: 1 });
        }
        break;
    }
    // Add a couple of processing/failed calls overall (non-per-agent but fine)
    if (Math.random() < 0.15) specs.push({ status: 'processing' });
    if (Math.random() < 0.08) specs.push({ status: 'failed' });
    return specs;
  }

  let totalCalls = 0;
  let totalBreaches = 0;
  // Track Neha's top-scoring call (for exemplar) + a handful of failing item scores (for corrections)
  let nehaTopCall: { callId: string; score: number } | null = null;
  const failingItemScoresForCorrection: Array<{
    callId: string;
    callScoreId: string;
    callItemScoreId: string;
    scorecardItemId: string;
    itemLabel: string;
    originalScore: number;
  }> = [];

  for (const agent of agents) {
    const specs = agentCallSpecs(agent.profile);
    let priorCoachingForAgent = 0;
    for (const spec of specs) {
      const callId = uuid();
      const createdAt = hoursAgo(randBetween(1, 60 * 24)); // last 60 days
      const duration = randBetween(400, 1600);
      const template = pick(transcriptTemplates).replace('{name}', agent.name);

      await query(
        `INSERT INTO calls (
           id, organization_id, uploaded_by, file_name, file_key,
           file_size_bytes, mime_type, agent_id, agent_name,
           duration_seconds, status, transcript_text,
           created_at, updated_at, ingestion_source, encrypted_at_rest
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'upload', true)`,
        [
          callId,
          orgId,
          adminId,
          `call-${createdAt.toISOString().slice(0, 10)}-${agent.name.replace(/\s/g, '-').toLowerCase()}.mp3`,
          `demo/${orgId}/${callId}/placeholder.mp3`,
          randBetween(500_000, 2_000_000),
          'audio/mpeg',
          agent.id,
          agent.name,
          duration,
          spec.status === 'processing' ? 'scoring' : spec.status,
          spec.status === 'failed' ? null : template,
          createdAt,
          createdAt,
        ]
      );
      totalCalls++;

      if (spec.status === 'scored') {
        // Create call_score row (with demo coaching)
        const pass = (spec.overallScore || 0) >= 70;
        const coaching = buildDemoCoaching(agent.name, spec.overallScore || 0, spec.failingItems || 0);
        const priorCoachingCount = Math.min(priorCoachingForAgent, 3);
        const callScoreRow = await queryOne<{ id: string }>(
          `INSERT INTO call_scores (
             call_id, scorecard_id, overall_score, pass, scored_at,
             model_id, prompt_tokens, completion_tokens, coaching, prior_coaching_count, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5) RETURNING id`,
          [callId, scorecardId, spec.overallScore, pass, createdAt, 'claude-sonnet-4-demo', 4200, 1800, JSON.stringify(coaching), priorCoachingCount]
        );
        priorCoachingForAgent++;
        const callScoreId = callScoreRow!.id;

        // Track Neha's highest scoring call for exemplar seeding
        if (agent.name === 'Neha Patel' && (!nehaTopCall || (spec.overallScore || 0) > nehaTopCall.score)) {
          nehaTopCall = { callId, score: spec.overallScore || 0 };
        }

        // Decide which items fail
        const failingItemCount = spec.failingItems || 0;
        const shuffledItems = [...scorecardItems].sort(() => Math.random() - 0.5);
        const failingItems = shuffledItems.slice(0, failingItemCount);
        const failingItemSet = new Set(failingItems.map((i) => i.id));

        for (const item of scorecardItems) {
          const failed = failingItemSet.has(item.id);
          const score = failed ? 0 : 1;
          const normalized = failed ? 0 : 100;
          const cisRow = await queryOne<{ id: string }>(
            `INSERT INTO call_item_scores (
               call_score_id, scorecard_item_id, score, normalized_score,
               confidence, evidence, reasoning
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              callScoreId,
              item.id,
              score,
              normalized,
              0.85 + Math.random() * 0.15,
              failed
                ? `[demo] Expected to hear '${item.label.toLowerCase()}' but did not find evidence in the transcript.`
                : `[demo] Confirmed in call: agent addressed ${item.label.toLowerCase()}.`,
              failed
                ? `The adviser did not ${item.label.toLowerCase().replace('did the agent ', '').replace('?', '')}. This is required under the scorecard criteria.`
                : `Criterion met - adviser handled this appropriately.`,
            ]
          );

          // Create breach for failing item
          if (failed) {
            await query(
              `INSERT INTO breaches (
                 organization_id, call_id, call_item_score_id, scorecard_item_id,
                 severity, status, detected_at
               )
               VALUES ($1, $2, $3, $4, $5, 'new', $6)`,
              [orgId, callId, cisRow!.id, item.id, item.severity, createdAt]
            );
            totalBreaches++;

            // Capture a handful of failing item scores on 'average' agents for correction demo
            if (
              (agent.profile === 'average' || agent.profile === 'good') &&
              failingItemScoresForCorrection.length < 4
            ) {
              failingItemScoresForCorrection.push({
                callId,
                callScoreId,
                callItemScoreId: cisRow!.id,
                scorecardItemId: item.id,
                itemLabel: item.label,
                originalScore: 0,
              });
            }
          }
        }
      }
    }
  }
  console.log(`[calls] ${totalCalls} calls generated`);
  console.log(`[breaches] ${totalBreaches} breaches auto-created`);

  // 7. Exemplar: mark Neha's top-scoring call
  if (nehaTopCall) {
    await query(
      `UPDATE calls SET is_exemplar = true, exemplar_reason = $2 WHERE id = $1`,
      [nehaTopCall.callId, 'Firm gold standard: full FCA disclosure, open-ended discovery, linked recommendation']
    );
    console.log(`[exemplar] Neha Patel's top call (${nehaTopCall.score.toFixed(0)}%) marked as firm exemplar`);
  }

  // 8. Score corrections (compliance officer overrides)
  const correctionReasons = [
    'Agent did explicitly confirm this on the call - AI missed the phrasing. Pass.',
    'On replay, the client acknowledged this clearly. Marking as compliant.',
    'Borderline case but meets our firm\'s interpretation of the rule. Pass.',
    'Mitigating context in prior conversation; compliant per our policy.',
  ];
  let correctionsCreated = 0;
  for (let i = 0; i < failingItemScoresForCorrection.length; i++) {
    const fis = failingItemScoresForCorrection[i]!;
    const reason = correctionReasons[i % correctionReasons.length]!;

    // Flip to pass
    await query(
      `UPDATE call_item_scores
         SET score = 1, normalized_score = 100
       WHERE id = $1`,
      [fis.callItemScoreId]
    );

    // Record the correction
    await query(
      `INSERT INTO score_corrections (
         organization_id, call_id, call_item_score_id, scorecard_item_id, corrected_by,
         original_score, corrected_score, original_pass, corrected_pass, reason, transcript_excerpt
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        orgId,
        fis.callId,
        fis.callItemScoreId,
        fis.scorecardItemId,
        adminId,
        fis.originalScore,
        100,
        false,
        true,
        reason,
        `[demo transcript excerpt relevant to: ${fis.itemLabel}]`,
      ]
    );

    // Remove the breach that was auto-created for this item
    await query(
      `DELETE FROM breaches WHERE call_item_score_id = $1`,
      [fis.callItemScoreId]
    );

    correctionsCreated++;
  }
  console.log(`[corrections] ${correctionsCreated} human score corrections recorded`);

  // 9. Sample AI Insights digest
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sampleSummary = `This week's call volume (${totalCalls} calls scored) shows a healthy pass rate overall, but two patterns deserve attention. First, Marcus Webb has accumulated ${AGENTS.length > 0 ? 3 : 0} critical fails on capacity-for-loss assessment - a fundamental COBS 9.2 requirement. This is a pattern, not isolated, and warrants urgent intervention before his next advice call. Second, 'Capacity for loss assessed' appears as a top breach across the team, suggesting a process gap rather than an individual issue.

On the positive side, ${correctionsCreated} compliance corrections were logged this period, meaning the AI is actively learning your interpretation of borderline cases. Neha Patel's recent call was tagged as a firm exemplar and is now part of the reference set for scoring future calls. Coaching acceptance across the team is trending upward.

Looking ahead: the charges-disclosure items are borderline-passing for multiple advisers. A team-wide refresher on combined monetary illustrations (not just percentages) would likely lift the overall pass rate by 4-6 points within two weeks.`;
  const sampleRecommendations = [
    {
      title: 'Escalate Marcus Webb to supervised calls this week',
      detail: '3 critical fails on capacity-for-loss in the last 7 days. Do not allow independent advice calls until supervised retraining is complete. Compliance should review his next 5 calls before any transfer proceeds.',
      priority: 'critical',
      cta: { label: 'View Marcus on Adviser Risk', href: '/adviser-risk' },
    },
    {
      title: 'Run team-wide refresher on capacity-for-loss',
      detail: 'This item is the #1 breach type across multiple advisers - suggests a training gap, not an individual issue. Schedule a 30-minute team session covering the £20k drop scenario and how to document the client response.',
      priority: 'high',
      cta: { label: 'Open breach register', href: '/breaches' },
    },
    {
      title: 'Upgrade charges disclosure script to combined £ illustration',
      detail: "Multiple advisers are passing this item marginally by stating percentages alone. Update the firm script to require a combined annual £ figure - this should lift pass rates 4-6 points and strengthen Consumer Duty evidence.",
      priority: 'medium',
    },
    {
      title: 'Share Neha Patel\'s exemplar call in next team meeting',
      detail: "Her recent high-scoring call is now in your exemplar library and is being used to calibrate future AI scoring. Playing a clip during the team meeting reinforces what 'good' looks like, especially for the mid-tier advisers.",
      priority: 'info',
    },
  ];
  const sampleMetrics = {
    period_days: 7,
    total_calls: totalCalls,
    scored_calls: totalCalls - 2,
    avg_score_current: 78.4,
    avg_score_prior: 75.9,
    pass_rate_current: 72.1,
    pass_rate_prior: 68.3,
    top_breaches: [
      { label: 'Capacity for loss assessed', count: 7 },
      { label: 'Vulnerable client indicators screened', count: 4 },
      { label: 'Charges and costs disclosed clearly', count: 3 },
      { label: 'Attitude to investment risk explored', count: 2 },
      { label: 'No high-pressure or urgency language used', count: 2 },
    ],
    adviser_risk: { high_risk: 1, elevated: 1, monitor: 2, low_risk: 3, compliant: 1 },
    corrections_count: correctionsCreated,
    exemplars_count: nehaTopCall ? 1 : 0,
  };
  await query(
    `INSERT INTO insight_digests (
       organization_id, period_start, period_end, summary, recommendations, metrics,
       generated_by, model_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orgId,
      periodStart,
      periodEnd,
      sampleSummary,
      JSON.stringify(sampleRecommendations),
      JSON.stringify(sampleMetrics),
      adminId,
      'claude-sonnet-4-demo',
    ]
  );
  console.log('[insights] 1 sample AI insights digest created');

  // 10. Alert rule
  await query(
    `INSERT INTO alert_rules
       (organization_id, name, description, trigger_type, trigger_config, channels, is_active, created_by)
     VALUES ($1, $2, $3, 'low_overall_score', $4, $5, true, $6)`,
    [
      orgId,
      'Critical overall score fail',
      'Fires when a call scores below 60% overall',
      JSON.stringify({ threshold: 60 }),
      JSON.stringify({ in_app: { user_ids: 'all_admins' } }),
      adminId,
    ]
  );
  console.log(`[alerts] 1 alert rule created`);

  // 8. Notifications (3 unread, 5 read)
  const notifTitles = [
    'Low score: call-2026-04-14-marcus-webb.mp3',
    'Low score: call-2026-04-12-marcus-webb.mp3',
    'Low score: call-2026-04-10-marcus-webb.mp3',
    'Low score: call-2026-04-08-tom-richards.mp3',
    'Low score: call-2026-04-05-tom-richards.mp3',
    'Processing failed: call-2026-04-03-david-park.mp3',
    'Low score: call-2026-03-30-amy-blackwell.mp3',
    'Low score: call-2026-03-28-rachel-kim.mp3',
  ];
  for (let i = 0; i < notifTitles.length; i++) {
    const isUnread = i < 3;
    const createdAt = hoursAgo(i * 18);
    await query(
      `INSERT INTO notifications
         (organization_id, user_id, title, body, severity, read_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId,
        adminId,
        notifTitles[i],
        `Call scored below the 60% threshold. Review required.`,
        'critical',
        isUnread ? null : hoursAgo(i * 18 - 1),
        createdAt,
      ]
    );
  }
  console.log(`[notifications] ${notifTitles.length} notifications (3 unread)`);

  console.log('\n=== Demo seed complete ===');
  console.log(`Login:     ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);
  console.log(`Agent pw:  agent123`);
  console.log(`Dashboard: http://localhost:5173/`);

  await pool.end();
}

function buildDemoCoaching(agent: string, score: number, failingItems: number) {
  if (score >= 90) {
    return {
      summary: `Excellent call. ${agent} handled this with textbook skill - exactly the kind of interaction we should use as a training example.`,
      strengths: [
        'Opened with full FCA disclosure and call recording notice inside 30 seconds',
        'Used open-ended discovery questions to uncover real client objectives',
        'Explicitly linked the recommendation back to stated objectives before closing',
      ],
      improvements: [
        'Consider pausing slightly longer after key disclosures to confirm client understanding',
        'On complex charges explanations, try using a concrete monetary illustration',
      ],
      next_actions: [
        'Share this call with the wider team as a positive exemplar',
        'Nominate for the quarterly compliance recognition review',
      ],
    };
  }
  if (score >= 70) {
    return {
      summary: `Solid call overall - compliant on the essentials but with a few coachable moments around depth of exploration.`,
      strengths: [
        'Identity and FCA disclosure delivered promptly',
        'Took time to explore client circumstances before recommending',
        'Cooling-off rights stated clearly at the close',
      ],
      improvements: [
        'Risk tolerance was confirmed with a closed question - try open-ended scenario testing instead',
        'Charges disclosure could benefit from a combined annual £ figure, not just percentages',
      ],
      next_actions: [
        'Review the firm ATR script and practise the "£20k drop scenario" opener',
        'Add a combined monetary charges illustration to your standard closing',
      ],
    };
  }
  if (score >= 50) {
    return {
      summary: `Marginal call - several compliance items were partially covered but not to the standard required. Coaching needed before next similar advice case.`,
      strengths: [
        'Call opened correctly with FCA authorisation and recording notice',
        'Rapport with the client was professional and respectful throughout',
      ],
      improvements: [
        'Capacity for loss was not explicitly discussed - this is fundamental for any investment recommendation',
        'Vulnerability signals were brushed past rather than triggering the formal protocol',
        'Recommendation was made before all fact-find elements were complete',
      ],
      next_actions: [
        'Schedule a 1:1 coaching session covering capacity for loss and vulnerable client handling',
        'Re-read FG21/1 vulnerable client guidance before next advice call',
        'Use the firm fact-find checklist for the next three calls without exception',
      ],
    };
  }
  // Critical fail
  return {
    summary: `Critical fail. Multiple fundamental compliance elements were missed. This call must be escalated to compliance before any transfer/trade is executed.`,
    strengths: [
      'Call recording disclosure was stated',
      'The client was given opportunity to ask questions near the end',
    ],
    improvements: [
      'Capacity for loss was never assessed - this is a CRITICAL fail under COBS 9.2',
      'Attitude to risk was confirmed with a single closed question - nowhere near sufficient for the advice given',
      'Urgency / pressure language was used ("window is closing") which is a Consumer Duty breach',
      `${failingItems} scorecard criteria were not met - pattern suggests a process issue, not isolated`,
    ],
    next_actions: [
      'Escalate immediately to compliance officer - do NOT proceed to transfer',
      'Suspend from independent advice calls until supervised retraining is complete',
      'Complete the ATR + capacity for loss refresher module within 7 days',
    ],
  };
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
