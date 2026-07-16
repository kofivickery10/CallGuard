/**
 * Demo data seed script — Protection edition (Brookfield Protection).
 *
 * Creates a fully populated PROTECTION-advice demo environment:
 *   - Org: "Brookfield Protection"
 *   - Admin: demo@callguardai.co.uk / (DEMO_ADMIN_PASSWORD env, else a printed random one)
 *   - 8 protection advisers with varying risk profiles
 *   - 1 scorecard: "Protection Advice QA (ICOBS / Consumer Duty)" with 15 items
 *   - KB content (protection: products + compliance)
 *   - A spread of protection calls with scores + breaches + item scores
 *   - 1 hero call (Emma Reynolds / Daniel Brooks) with a controlled, fully
 *     written transcript and per-item evidence — the call the demo videos film
 *   - 1 alert rule, AI insights digest, score corrections, notifications
 *
 * Usage:
 *   DEMO_ADMIN_PASSWORD='choose-a-strong-one' npm run seed-demo --workspace=packages/api -- --reset
 *   (omit DEMO_ADMIN_PASSWORD and a strong random password is generated and printed)
 */

import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { randomBytes } from 'crypto';
import { deriveSeverity, callPasses } from '@callguard/shared';
import { pool, query, queryOne } from '../db/client.js';
import { deleteOrganizationCascade } from '../services/tenant-deletion.js';

const DEMO_ORG = 'Brookfield Protection';
const DEMO_ADMIN_EMAIL = 'demo@callguardai.co.uk';
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || randomBytes(9).toString('base64url');

const AGENTS = [
  { name: 'Priya Sharma', email: 'priya.sharma@brookfield.example', profile: 'star' },        // 0 breaches
  { name: 'Daniel Brooks', email: 'daniel.brooks@brookfield.example', profile: 'good' },        // owns the hero call
  { name: 'James Okafor', email: 'james.okafor@brookfield.example', profile: 'good' },
  { name: 'Amy Blackwell', email: 'amy.blackwell@brookfield.example', profile: 'average' },
  { name: 'David Park', email: 'david.park@brookfield.example', profile: 'average' },
  { name: 'Rachel Kim', email: 'rachel.kim@brookfield.example', profile: 'average' },
  { name: 'Tom Richards', email: 'tom.richards@brookfield.example', profile: 'elevated' },       // 2 high
  { name: 'Marcus Webb', email: 'marcus.webb@brookfield.example', profile: 'high_risk' },        // critical
];

// Protection scorecard: ICOBS demands-and-needs, CIDRA disclosure duty,
// FG21/1 vulnerability, Consumer Duty outcomes. label / description (rubric) / weight / severity.
const SCORECARD_ITEMS = [
  { label: 'Status & FCA disclosure', description: 'Adviser states their name, firm, that the firm is FCA-regulated, that this is advised, and whether independent or restricted, early in the call.', weight: 1.0, severity: 'medium' },
  { label: 'Recording & data disclosure', description: 'Adviser discloses the call is recorded and how the customer\'s data will be used.', weight: 1.0, severity: 'medium' },
  { label: 'Demands and needs established', description: 'Adviser explores what the customer needs protection for and why (mortgage, family income, children) before recommending. The need is established, not assumed.', weight: 2.0, severity: 'critical' },
  { label: 'Existing cover reviewed', description: 'Adviser checks existing protection, including employer death-in-service and current policies, to avoid duplicate or excess cover.', weight: 1.5, severity: 'high' },
  { label: 'Affordability & sustainability', description: 'Adviser checks the premium is affordable now and sustainable over the term, referencing the customer\'s budget.', weight: 1.5, severity: 'high' },
  { label: 'Sum assured & term matched to need', description: 'Recommended amount and term match the established need (mortgage balance and remaining term; income to children\'s independence).', weight: 1.5, severity: 'high' },
  { label: 'Disclosure duty explained (CIDRA)', description: 'Adviser clearly explains the customer must answer all medical and lifestyle questions fully and accurately, and that non-disclosure could cause a claim to be declined.', weight: 2.0, severity: 'critical' },
  { label: 'Vulnerability screened & responded (FG21/1)', description: 'Adviser identifies indicators of vulnerability (health, recent bereavement, financial stress, capability) and responds appropriately. A cue must be acknowledged and acted on, not passed over.', weight: 2.0, severity: 'critical' },
  { label: 'Features, exclusions & limitations explained', description: 'Adviser explains key features, definitions, exclusions and limitations (critical-illness condition definitions, survival period, what is not covered).', weight: 1.5, severity: 'high' },
  { label: 'Premium basis explained', description: 'Adviser explains whether premiums are guaranteed or reviewable over the term.', weight: 1.0, severity: 'medium' },
  { label: 'Fair value (Consumer Duty)', description: 'Cover recommended represents fair value: not over-insured, no unnecessary extras.', weight: 1.0, severity: 'high' },
  { label: 'Policy in trust / beneficiaries', description: 'Adviser raises writing the policy in trust or nominating beneficiaries, so any payout reaches the right people quickly and outside the estate.', weight: 1.0, severity: 'medium' },
  { label: 'Recommendation linked to demands and needs', description: 'The specific product recommended is explicitly justified against the customer\'s stated needs.', weight: 1.5, severity: 'high' },
  { label: 'Understanding checked & questions invited', description: 'Adviser checks the customer understood and invites questions.', weight: 1.0, severity: 'medium' },
  { label: 'No pressure or urgency language', description: 'No high-pressure tactics or false urgency. Protection must be sold without pressure.', weight: 2.0, severity: 'critical' },
];

const KB_SECTIONS: Record<string, string> = {
  company_overview: `Brookfield Protection is a UK FCA-regulated protection advice firm. We give advice on life cover, critical illness and income protection for individuals and families, primarily mortgage and family protection. Our tone is professional, plain-English and client-first. We do not advise on investments or pensions.`,
  products: `We advise on the retail protection range across a panel of insurers:
- **Life cover**: level term, decreasing (mortgage) term, and whole of life. Sum assured matched to mortgage balance and/or family income need; term matched to the mortgage term or to children's independence.
- **Critical illness cover (CIC)**: lump sum on diagnosis of a listed condition. Cover is defined by the policy's specific condition definitions and a survival period (typically 14 days). It is not cover for any illness.
- **Income protection (IP)**: replaces a proportion of income if the client cannot work. Key features: the deferred period, and whether the definition is "own occupation" or "any occupation".
- **Trusts**: life policies should normally be considered for writing in trust so the payout passes to beneficiaries quickly and outside the estate.`,
  compliance: `## Mandatory elements of every protection advice call (ICOBS + Consumer Duty)

1. Adviser identity, firm name, FCA-regulated status (advised; independent or restricted).
2. Call recording and data-use disclosure.
3. **Demands and needs** established before any recommendation (ICOBS 5.2).
4. Existing cover reviewed (employer death-in-service, current policies) to avoid duplication.
5. Affordability and sustainability of the premium over the term.
6. Sum assured and term matched to the established need.
7. **Duty of disclosure (CIDRA)**: the client must answer all medical/lifestyle questions fully and accurately; non-disclosure can void a claim. This MUST be explained. Missing it is a CRITICAL fail.
8. **Vulnerability (FG21/1)**: screen for health, bereavement, financial-stress or capability indicators and respond. A disclosed cue (e.g. recent bereavement) must be acknowledged and acted on. CRITICAL.
9. Features, exclusions and limitations explained (CIC definitions, survival period, IP deferred period).
10. Premium basis (guaranteed vs reviewable) explained.
11. Fair value (Consumer Duty): no over-insurance or unnecessary extras.
12. Policy in trust / beneficiary nomination raised.
13. Recommendation explicitly linked back to the demands and needs.
14. Understanding checked and questions invited.
15. NO urgency or pressure language - CRITICAL FAIL.`,
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

// ── Hero call: a controlled, fully written protection call for the demo videos ──
// Emma Reynolds (life + critical illness) advised by Daniel Brooks. Mostly good,
// with three honest misses the tool catches: disclosure duty (CIDRA), a
// vulnerability cue (bereavement), and no trust conversation.
const HERO_TRANSCRIPT = `Agent: Good afternoon, am I speaking with Emma Reynolds? Hi Emma, it's Daniel Brooks calling from Brookfield Protection. We're an FCA-regulated protection advice firm. Thanks for booking some time in. Just so you know, the call's recorded for training and compliance, and we'll only use your details to advise you and arrange any cover. Is that okay?

Customer: Yes, that's fine.

Agent: Lovely. So the purpose today is to look at protecting you and your family financially, work out what makes sense, and I'll give you a personal recommendation at the end. There's no obligation to take anything. To start, can you tell me what's prompted you to look at this now?

Customer: Honestly, my dad passed away last year, very suddenly, and it was a really hard time. He had nothing in place and it was a nightmare sorting it all out. We've just moved to a bigger house too, bigger mortgage, and I've got two little ones. It made me realise we've got nothing if anything happened to me or my husband.

Agent: Sorry to hear that. Okay, so let's get you sorted. You've got a mortgage and two children. What's the outstanding mortgage, and how long is left on it?

Customer: It's £280,000, over 25 years.

Agent: And if the worst happened to either of you, what would you want to happen? The mortgage cleared, money for the children, replacing an income?

Customer: Definitely the mortgage cleared so they could stay in the house. And something for the kids.

Agent: Makes sense. How old are the children?

Customer: Four and six.

Agent: Do either of you have cover already, anything through work, death-in-service, existing policies?

Customer: I get three times my salary through work, I think. My husband doesn't have anything.

Agent: Good, three times salary through your employer. We'll factor that in so we're not over-insuring you. And roughly what monthly budget feels comfortable? I don't want to set up something you can't keep going.

Customer: Maybe forty or fifty pounds a month?

Agent: That's realistic for what you need. Based on what you've told me, I'd recommend level term life cover of £280,000 over 25 years, so the mortgage is fully cleared whoever it happens to, matched to your mortgage term. I'd also suggest critical illness cover of around £50,000, which pays a lump sum if you're diagnosed with one of the serious conditions the policy lists, things like cancer, heart attack or stroke, so you've a buffer if you're ill but still here. That comes to about forty-five pounds a month for both of you.

Agent: With the critical illness, it's important to understand it only covers the specific conditions and definitions in the policy, and there's usually a fourteen-day survival period. It's not cover for any illness, only the listed ones. The life cover is straightforward: it pays out if either of you passes away during the 25 years.

Agent: The premiums are guaranteed, so they're fixed from day one and won't change over the term. And I'm recommending level cover rather than anything pricier because your main aim is clearing that mortgage and protecting the kids, and this does exactly that without paying for extras you don't need.

Agent: To set it up there's an application with some health and lifestyle questions, height, weight, whether you smoke, that sort of thing. I'll go through those with you and it goes off to the insurer.

Agent: Does all that make sense? Any questions on any of it?

Customer: No, I think that's clear, thank you.

Agent: Great. Once it's set up you'll have a 30-day cooling-off period where you can cancel and get any premium back. I'll email you the personal recommendation and the product details, and we can do the application whenever suits. No pressure at all, have a think and we'll speak soon. Take care, Emma.`;

// Per-item result for the hero call, keyed by scorecard label.
const HERO_ITEMS: Record<string, { pass: boolean; evidence: string; reasoning: string }> = {
  'Status & FCA disclosure': { pass: true, evidence: '"it\'s Daniel Brooks calling from Brookfield Protection. We\'re an FCA-regulated protection advice firm."', reasoning: 'Adviser gave name, firm and FCA-regulated status at the open.' },
  'Recording & data disclosure': { pass: true, evidence: '"the call\'s recorded for training and compliance, and we\'ll only use your details to advise you and arrange any cover."', reasoning: 'Recording and data use disclosed and consent sought.' },
  'Demands and needs established': { pass: true, evidence: '"if the worst happened to either of you, what would you want to happen? The mortgage cleared, money for the children..."', reasoning: 'Need (mortgage clearance, family provision) established before any recommendation.' },
  'Existing cover reviewed': { pass: true, evidence: '"Do either of you have cover already... I get three times my salary through work."', reasoning: 'Employer death-in-service identified and explicitly factored in.' },
  'Affordability & sustainability': { pass: true, evidence: '"what monthly budget feels comfortable? ... forty or fifty pounds a month."', reasoning: 'Budget confirmed and recommendation kept within it.' },
  'Sum assured & term matched to need': { pass: true, evidence: '"level term life cover of £280,000 over 25 years... matched to your mortgage term."', reasoning: 'Cover amount and term matched to the mortgage need.' },
  'Disclosure duty explained (CIDRA)': { pass: false, evidence: '"there\'s an application with some health and lifestyle questions... I\'ll go through those with you and it goes off to the insurer."', reasoning: 'Adviser introduced the medical questions but never explained the client\'s duty to answer fully and accurately, or that non-disclosure can void a claim (CIDRA). This is a critical omission in protection.' },
  'Vulnerability screened & responded (FG21/1)': { pass: false, evidence: '"my dad passed away last year, very suddenly..." → "Sorry to hear that. Okay, so let\'s get you sorted."', reasoning: 'Client disclosed a recent, sudden bereavement (a clear FG21/1 vulnerability indicator). The adviser acknowledged it in passing but did not screen, adapt the approach, or check she was comfortable to proceed. Critical.' },
  'Features, exclusions & limitations explained': { pass: true, evidence: '"it only covers the specific conditions and definitions in the policy, and there\'s usually a fourteen-day survival period. It\'s not cover for any illness."', reasoning: 'CIC definitions, survival period and limitations explained clearly.' },
  'Premium basis explained': { pass: true, evidence: '"The premiums are guaranteed, so they\'re fixed from day one and won\'t change over the term."', reasoning: 'Guaranteed premium basis explained.' },
  'Fair value (Consumer Duty)': { pass: true, evidence: '"recommending level cover rather than anything pricier because your main aim is clearing that mortgage... without paying for extras you don\'t need."', reasoning: 'Cover matched to need with no unnecessary extras; fair value addressed.' },
  'Policy in trust / beneficiaries': { pass: false, evidence: '(no mention of writing the policy in trust or nominating beneficiaries anywhere in the call)', reasoning: 'Adviser did not raise placing the policy in trust, so any payout could fall into the estate and be delayed in reaching the family.' },
  'Recommendation linked to demands and needs': { pass: true, evidence: '"Based on what you\'ve told me, I\'d recommend level term life cover of £280,000... and critical illness cover of around £50,000."', reasoning: 'Recommendation explicitly tied to the stated needs.' },
  'Understanding checked & questions invited': { pass: true, evidence: '"Does all that make sense? Any questions on any of it?"', reasoning: 'Adviser checked understanding and invited questions.' },
  'No pressure or urgency language': { pass: true, evidence: '"No pressure at all, have a think and we\'ll speak soon."', reasoning: 'No urgency or pressure tactics used.' },
};

const HERO_COACHING = {
  summary: 'A capable, well-structured protection call. Daniel covered demands and needs, affordability and the recommendation well, and the call passes on overall score. But it contains two critical breaches that must be addressed before they become a pattern: the client\'s duty of disclosure was never explained, and a clear vulnerability indicator (a recent, sudden bereavement) was passed over. A percentage alone would hide both.',
  strengths: [
    'Established demands and needs clearly before recommending',
    'Checked existing employer cover and kept the premium within the client\'s stated budget',
    'Explained the critical-illness definitions, survival period and the guaranteed premium basis',
  ],
  improvements: [
    'Always explain the duty to answer medical questions fully and accurately - non-disclosure can void a claim (CIDRA). This was missed entirely.',
    'The client mentioned a recent, sudden bereavement. Acknowledge it, check she is comfortable to continue, and apply the vulnerability protocol (FG21/1) - do not move straight on.',
    'Raise writing the policy in trust so any payout reaches the family quickly and outside the estate.',
  ],
  next_actions: [
    'Re-do the disclosure-duty explanation with this client before the application is submitted',
    'Complete the FG21/1 vulnerability refresher before the next advice call',
    'Add a trust conversation to the standard close',
  ],
};

async function main() {
  const { reset } = parseArgs();
  console.log('CallGuard demo seed (Protection edition) starting...\n');

  // Find any prior demo to clear: by org name AND by the demo admin email. The
  // email lookup also catches an older demo org (e.g. "Acme Financial Planning")
  // that reused demo@callguardai.co.uk — the global unique on users.email would
  // otherwise block the new admin insert.
  const priorOrgIds = new Set<string>();
  const byName = await queryOne<{ id: string }>(`SELECT id FROM organizations WHERE name = $1`, [DEMO_ORG]);
  if (byName) priorOrgIds.add(byName.id);
  const byEmail = await queryOne<{ organization_id: string }>(`SELECT organization_id FROM users WHERE email = $1`, [DEMO_ADMIN_EMAIL]);
  if (byEmail) priorOrgIds.add(byEmail.organization_id);

  if (priorOrgIds.size > 0) {
    if (!reset) {
      console.log(`A demo for ${DEMO_ADMIN_EMAIL} (or "${DEMO_ORG}") already exists.`);
      console.log('Run with --reset to wipe and recreate:');
      console.log('  npm run seed-demo --workspace=packages/api -- --reset\n');
      process.exit(0);
    }
    for (const id of priorOrgIds) {
      console.log(`[reset] Wiping prior demo org ${id.slice(0, 8)}...`);
      await wipeOrg(id);
    }
    console.log('  Deleted. Related rows cleared.\n');
  }

  // 1. Create org (Pro plan so demo shows all features)
  const org = await queryOne<{ id: string }>(
    `INSERT INTO organizations (name, plan) VALUES ($1, 'enterprise') RETURNING id`,
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
  console.log(`[admin] ${DEMO_ADMIN_EMAIL}`);

  // 3. Agents (advisers). Random unguessable password — they are data, not demo logins.
  const agentHash = await bcrypt.hash(randomBytes(16).toString('base64url'), 12);
  const agents: { id: string; name: string; profile: string }[] = [];
  for (const a of AGENTS) {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'adviser') RETURNING id`,
      [orgId, a.email, a.name, agentHash]
    );
    agents.push({ id: row!.id, name: a.name, profile: a.profile });
  }
  console.log(`[agents] ${agents.length} advisers created`);

  // 4. Scorecard
  const sc = await queryOne<{ id: string }>(
    `INSERT INTO scorecards (organization_id, name, description, is_active, created_by)
     VALUES ($1, $2, $3, true, $4) RETURNING id`,
    [orgId, 'Protection Advice QA (ICOBS / Consumer Duty)', 'Scorecard for protection advice calls: ICOBS demands-and-needs, CIDRA disclosure duty, FG21/1 vulnerability and the Consumer Duty outcomes.', adminId]
  );
  const scorecardId = sc!.id;
  const scorecardItems: { id: string; label: string; weight: number; severity: string }[] = [];
  for (let i = 0; i < SCORECARD_ITEMS.length; i++) {
    const item = SCORECARD_ITEMS[i]!;
    const row = await queryOne<{ id: string }>(
      `INSERT INTO scorecard_items (scorecard_id, label, description, score_type, weight, sort_order, severity)
       VALUES ($1, $2, $3, 'binary', $4, $5, $6) RETURNING id`,
      [scorecardId, item.label, item.description, item.weight, i, item.severity]
    );
    scorecardItems.push({ id: row!.id, label: item.label, weight: item.weight, severity: item.severity });
  }
  console.log(`[scorecard] Protection Advice QA (${scorecardItems.length} items)`);

  // 5. KB sections
  for (const [type, content] of Object.entries(KB_SECTIONS)) {
    await query(
      `INSERT INTO knowledge_base_sections (organization_id, section_type, content)
       VALUES ($1, $2, $3)`,
      [orgId, type, content]
    );
  }
  console.log(`[kb]    3 sections filled`);

  // ── 6a. Hero call (Emma Reynolds / Daniel Brooks) ──
  const daniel = agents.find((a) => a.name === 'Daniel Brooks')!;
  const heroCallId = uuid();
  const heroCreatedAt = hoursAgo(2); // most recent → top of the calls list
  await query(
    `INSERT INTO calls (
       id, organization_id, uploaded_by, file_name, file_key,
       file_size_bytes, mime_type, agent_id, agent_name,
       duration_seconds, status, transcript_text,
       created_at, updated_at, ingestion_source, encrypted_at_rest
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scored',$11,$12,$12,'upload',true)`,
    [
      heroCallId, orgId, adminId,
      'emma-reynolds-life-cic.mp3', `demo/${orgId}/${heroCallId}/placeholder.mp3`,
      1_840_000, 'audio/mpeg', daniel.id, daniel.name, 312, HERO_TRANSCRIPT, heroCreatedAt,
    ]
  );
  // Weighted overall from the hero item results
  let heroWeighted = 0;
  let heroTotalWeight = 0;
  for (const item of scorecardItems) {
    heroTotalWeight += item.weight;
    if (HERO_ITEMS[item.label]?.pass) heroWeighted += item.weight;
  }
  const heroScore = Math.round((heroWeighted / heroTotalWeight) * 100);
  // Pass uses the shared gate (overall threshold + no critical breach), matching score.ts.
  const heroFailingSeverities = scorecardItems
    .filter((it) => !HERO_ITEMS[it.label]?.pass)
    .map((it) => deriveSeverity(it.weight, it.severity));
  const heroScoreRow = await queryOne<{ id: string }>(
    `INSERT INTO call_scores (
       call_id, scorecard_id, overall_score, pass, scored_at,
       model_id, prompt_tokens, completion_tokens, coaching, prior_coaching_count, created_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$5) RETURNING id`,
    [heroCallId, scorecardId, heroScore, callPasses(heroScore, heroFailingSeverities), heroCreatedAt, 'claude-sonnet-4-demo', 5100, 2100, JSON.stringify(HERO_COACHING), 0]
  );
  for (const item of scorecardItems) {
    const r = HERO_ITEMS[item.label]!;
    const cis = await queryOne<{ id: string }>(
      `INSERT INTO call_item_scores (
         call_score_id, scorecard_item_id, score, normalized_score, confidence, evidence, reasoning
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [heroScoreRow!.id, item.id, r.pass ? 1 : 0, r.pass ? 100 : 0, r.pass ? 0.93 : 0.9, r.evidence, r.reasoning]
    );
    if (!r.pass) {
      await query(
        `INSERT INTO breaches (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, status, detected_at)
         VALUES ($1,$2,$3,$4,$5,'new',$6)`,
        [orgId, heroCallId, cis!.id, item.id, item.severity, heroCreatedAt]
      );
    }
  }
  console.log(`[hero]  Emma Reynolds call scored ${heroScore}% (2 critical + 1 medium breach)`);

  // ── 6b. Spread of protection calls for a realistic dashboard / list ──
  const transcriptTemplates = [
    `Agent: Good morning, this is {name} from Brookfield Protection, we're FCA-regulated. Just to let you know the call's recorded for compliance. How can I help today?

Customer: Hi, I want to sort out some life cover for my mortgage.

Agent: Of course. Before I recommend anything, can I ask a few questions about what you'd want to protect and your circumstances?`,
    `Agent: Hello, you're through to {name} at Brookfield Protection. This call is recorded for training and compliance. You were looking at protecting the family?

Customer: Yes, life and maybe critical illness.

Agent: Great. Let's start with what's prompted this and what you'd want to happen if the worst occurred...`,
  ];

  type CallSpec = { status: 'scored' | 'failed' | 'processing'; overallScore?: number; failingItems?: number };

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
    if (Math.random() < 0.15) specs.push({ status: 'processing' });
    if (Math.random() < 0.08) specs.push({ status: 'failed' });
    return specs;
  }

  let totalCalls = 1; // hero already counted
  let totalBreaches = 3; // hero breaches
  let topCall: { callId: string; score: number } | null = null;
  const failingItemScoresForCorrection: Array<{
    callId: string; callScoreId: string; callItemScoreId: string;
    scorecardItemId: string; itemLabel: string; originalScore: number;
  }> = [];

  for (const agent of agents) {
    const specs = agentCallSpecs(agent.profile);
    let priorCoachingForAgent = 0;
    for (const spec of specs) {
      const callId = uuid();
      const createdAt = hoursAgo(randBetween(5, 60 * 24));
      const duration = randBetween(280, 900);
      const template = pick(transcriptTemplates).replace('{name}', agent.name);

      await query(
        `INSERT INTO calls (
           id, organization_id, uploaded_by, file_name, file_key,
           file_size_bytes, mime_type, agent_id, agent_name,
           duration_seconds, status, transcript_text,
           created_at, updated_at, ingestion_source, encrypted_at_rest
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'upload',true)`,
        [
          callId, orgId, adminId,
          `call-${createdAt.toISOString().slice(0, 10)}-${agent.name.replace(/\s/g, '-').toLowerCase()}.mp3`,
          `demo/${orgId}/${callId}/placeholder.mp3`,
          randBetween(500_000, 2_000_000), 'audio/mpeg', agent.id, agent.name,
          duration, spec.status === 'processing' ? 'scoring' : spec.status,
          spec.status === 'failed' ? null : template, createdAt, createdAt,
        ]
      );
      totalCalls++;

      if (spec.status === 'scored') {
        // Decide failing items first so the critical-fail gate can be applied to `pass`.
        const failingItemCount = spec.failingItems || 0;
        const shuffledItems = [...scorecardItems].sort(() => Math.random() - 0.5);
        const failingItems = shuffledItems.slice(0, failingItemCount);
        const failingItemSet = new Set(failingItems.map((i) => i.id));
        // Derive the overall score from the items that actually failed (same
        // weighting as the real scorer), so the headline score, the per-item
        // badges and pass/fail are always consistent. Otherwise a randomly
        // high score could show next to a FAIL with mostly-green items.
        const totalWeight = scorecardItems.reduce((s, i) => s + i.weight, 0);
        const failedWeight = failingItems.reduce((s, i) => s + i.weight, 0);
        const overallScore = Math.round(((totalWeight - failedWeight) / totalWeight) * 100);
        const pass = callPasses(overallScore, failingItems.map((i) => deriveSeverity(i.weight, i.severity)));

        const coaching = buildDemoCoaching(agent.name, overallScore, failingItemCount);
        const priorCoachingCount = Math.min(priorCoachingForAgent, 3);
        const callScoreRow = await queryOne<{ id: string }>(
          `INSERT INTO call_scores (
             call_id, scorecard_id, overall_score, pass, scored_at,
             model_id, prompt_tokens, completion_tokens, coaching, prior_coaching_count, created_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$5) RETURNING id`,
          [callId, scorecardId, overallScore, pass, createdAt, 'claude-sonnet-4-demo', 4200, 1800, JSON.stringify(coaching), priorCoachingCount]
        );
        priorCoachingForAgent++;
        const callScoreId = callScoreRow!.id;

        if (agent.profile === 'star' && (!topCall || overallScore > topCall.score)) {
          topCall = { callId, score: overallScore };
        }

        for (const item of scorecardItems) {
          const failed = failingItemSet.has(item.id);
          const cisRow = await queryOne<{ id: string }>(
            `INSERT INTO call_item_scores (
               call_score_id, scorecard_item_id, score, normalized_score, confidence, evidence, reasoning
             ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              callScoreId, item.id, failed ? 0 : 1, failed ? 0 : 100, 0.85 + Math.random() * 0.15,
              failed
                ? `[demo] Expected to hear "${item.label.toLowerCase()}" but found no clear evidence in the transcript.`
                : `[demo] Confirmed in call: adviser addressed ${item.label.toLowerCase()}.`,
              failed
                ? `The adviser did not adequately cover "${item.label}". This is required under the scorecard.`
                : `Criterion met - adviser handled this appropriately.`,
            ]
          );
          if (failed) {
            await query(
              `INSERT INTO breaches (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, status, detected_at)
               VALUES ($1,$2,$3,$4,$5,'new',$6)`,
              [orgId, callId, cisRow!.id, item.id, item.severity, createdAt]
            );
            totalBreaches++;
            if ((agent.profile === 'average' || agent.profile === 'good') && failingItemScoresForCorrection.length < 4) {
              failingItemScoresForCorrection.push({
                callId, callScoreId, callItemScoreId: cisRow!.id,
                scorecardItemId: item.id, itemLabel: item.label, originalScore: 0,
              });
            }
          }
        }
      }
    }
  }
  console.log(`[calls] ${totalCalls} calls generated`);
  console.log(`[breaches] ${totalBreaches} breaches auto-created`);

  // 7. Exemplar: mark the top star-adviser call
  if (topCall) {
    await query(
      `UPDATE calls SET is_exemplar = true, exemplar_reason = $2 WHERE id = $1`,
      [topCall.callId, 'Firm gold standard: full ICOBS demands-and-needs, disclosure duty explained, vulnerability handled, recommendation linked to needs']
    );
    console.log(`[exemplar] Top adviser call (${topCall.score.toFixed(0)}%) marked as firm exemplar`);
  }

  // 8. Score corrections (compliance officer overrides)
  const correctionReasons = [
    'Adviser did explicitly cover this on the call - AI missed the phrasing. Pass.',
    'On replay, the client acknowledged this clearly. Marking as compliant.',
    'Borderline case but meets our firm\'s interpretation of the rule. Pass.',
    'Mitigating context earlier in the call; compliant per our policy.',
  ];
  let correctionsCreated = 0;
  for (let i = 0; i < failingItemScoresForCorrection.length; i++) {
    const fis = failingItemScoresForCorrection[i]!;
    const reason = correctionReasons[i % correctionReasons.length]!;
    await query(`UPDATE call_item_scores SET score = 1, normalized_score = 100 WHERE id = $1`, [fis.callItemScoreId]);
    await query(
      `INSERT INTO score_corrections (
         organization_id, call_id, call_item_score_id, scorecard_item_id, corrected_by,
         original_score, corrected_score, original_pass, corrected_pass, reason, transcript_excerpt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orgId, fis.callId, fis.callItemScoreId, fis.scorecardItemId, adminId, fis.originalScore, 100, false, true, reason, `[demo transcript excerpt relevant to: ${fis.itemLabel}]`]
    );
    await query(`DELETE FROM breaches WHERE call_item_score_id = $1`, [fis.callItemScoreId]);
    correctionsCreated++;
  }
  console.log(`[corrections] ${correctionsCreated} human score corrections recorded`);

  // 9. Sample AI Insights digest (protection-themed)
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sampleSummary = `This week's protection advice calls (${totalCalls} scored) show a solid overall pass rate, but two patterns deserve attention. First, the duty of disclosure (CIDRA) and vulnerability handling (FG21/1) are the most common breaches across the team - both critical, and both the kind that void claims or fail a Consumer Duty review. Even calls that pass on overall score, such as Daniel Brooks' recent Emma Reynolds call, are missing the disclosure-duty explanation. Second, Marcus Webb has accumulated critical fails on demands-and-needs and vulnerability and should not take independent advice calls until retrained.

On the positive side, ${correctionsCreated} compliance corrections were logged this period, so the AI is actively learning the firm's interpretation of borderline items. A top call has been tagged as a firm exemplar and is now part of the reference set for future scoring.

Looking ahead: a short team refresher on (1) always explaining the duty of disclosure and (2) acknowledging and screening vulnerability cues would lift the critical-breach rate fastest.`;
  const sampleRecommendations = [
    { title: 'Team refresher: always explain the duty of disclosure (CIDRA)', detail: 'The #1 critical breach this week. Every adviser must explain that medical/lifestyle questions need full, accurate answers and that non-disclosure can void a claim. Add it to the standard application step.', priority: 'critical', cta: { label: 'Open breach register', href: '/breaches' } },
    { title: 'Coach the team on vulnerability cues (FG21/1)', detail: 'Several calls passed over disclosed vulnerability indicators (bereavement, ill-health). Acknowledge, check the client is comfortable to proceed, and apply the protocol - do not move straight on.', priority: 'high', cta: { label: 'Open review queue', href: '/review-queue' } },
    { title: 'Escalate Marcus Webb to supervised calls', detail: 'Critical fails on demands-and-needs and vulnerability in the last 7 days. Review his next calls before any application proceeds.', priority: 'high', cta: { label: 'View Adviser Risk', href: '/adviser-risk' } },
    { title: 'Add a trust conversation to the standard close', detail: 'Policy-in-trust is being missed on otherwise-strong calls. A one-line prompt at the close would close this gap and speed payouts to beneficiaries.', priority: 'info' },
  ];
  const sampleMetrics = {
    period_days: 7,
    total_calls: totalCalls,
    scored_calls: totalCalls - 2,
    avg_score_current: 79.1,
    avg_score_prior: 76.4,
    pass_rate_current: 74.0,
    pass_rate_prior: 70.2,
    top_breaches: [
      { label: 'Disclosure duty explained (CIDRA)', count: 6 },
      { label: 'Vulnerability screened & responded (FG21/1)', count: 5 },
      { label: 'Demands and needs established', count: 3 },
      { label: 'Policy in trust / beneficiaries', count: 3 },
      { label: 'No pressure or urgency language', count: 2 },
    ],
    adviser_risk: { high_risk: 1, elevated: 1, monitor: 2, low_risk: 3, compliant: 1 },
    corrections_count: correctionsCreated,
    exemplars_count: topCall ? 1 : 0,
  };
  await query(
    `INSERT INTO insight_digests (organization_id, period_start, period_end, summary, recommendations, metrics, generated_by, model_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orgId, periodStart, periodEnd, sampleSummary, JSON.stringify(sampleRecommendations), JSON.stringify(sampleMetrics), adminId, 'claude-sonnet-4-demo']
  );
  console.log('[insights] 1 sample AI insights digest created');

  // 10. Alert rule
  await query(
    `INSERT INTO alert_rules (organization_id, name, description, trigger_type, trigger_config, channels, is_active, created_by)
     VALUES ($1,$2,$3,'low_overall_score',$4,$5,true,$6)`,
    [orgId, 'Critical overall score fail', 'Fires when a call scores below 60% overall', JSON.stringify({ threshold: 60 }), JSON.stringify({ in_app: { user_ids: 'all_admins' } }), adminId]
  );
  console.log(`[alerts] 1 alert rule created`);

  // 11. Notifications
  const notifTitles = [
    'Critical breach: emma-reynolds-life-cic.mp3 (disclosure duty)',
    'Critical breach: emma-reynolds-life-cic.mp3 (vulnerability)',
    'Low score: call-marcus-webb.mp3',
    'Low score: call-marcus-webb.mp3',
    'Low score: call-tom-richards.mp3',
    'Processing failed: call-david-park.mp3',
    'Low score: call-amy-blackwell.mp3',
    'Low score: call-rachel-kim.mp3',
  ];
  for (let i = 0; i < notifTitles.length; i++) {
    const isUnread = i < 3;
    const createdAt = hoursAgo(i * 18 + 1);
    await query(
      `INSERT INTO notifications (organization_id, user_id, title, body, severity, read_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, adminId, notifTitles[i], 'Review required.', 'critical', isUnread ? null : hoursAgo(i * 18), createdAt]
    );
  }
  console.log(`[notifications] ${notifTitles.length} notifications (3 unread)`);

  console.log('\n=== Demo seed complete ===');
  console.log(`Org:       ${DEMO_ORG}`);
  console.log(`Login:     ${DEMO_ADMIN_EMAIL}`);
  console.log(`Password:  ${DEMO_ADMIN_PASSWORD}${process.env.DEMO_ADMIN_PASSWORD ? '' : '   <-- generated, save this'}`);
  console.log(`Hero call: Emma Reynolds (life + CIC), top of the Calls list`);

  await pool.end();
}

async function wipeOrg(orgId: string) {
  // Full, FK-safe, transactional teardown lives in the shared tenant-deletion
  // service (also used by the superadmin "delete tenant" endpoint) so re-seeding
  // and real tenant deletion can't drift apart. It removes every org-scoped table
  // and guards against any newer table being missed.
  await deleteOrganizationCascade(orgId);
}

function buildDemoCoaching(agent: string, score: number, failingItems: number) {
  if (score >= 90) {
    return {
      summary: `Excellent protection call. ${agent} handled this to the firm standard - a good training example.`,
      strengths: [
        'Opened with FCA-regulated status and recording disclosure',
        'Established demands and needs before recommending',
        'Explained the duty of disclosure and handled the application step properly',
      ],
      improvements: [
        'Consider confirming understanding again after the exclusions explanation',
        'Mention writing the policy in trust as standard',
      ],
      next_actions: ['Share this call with the team as a positive exemplar', 'Nominate for the quarterly compliance review'],
    };
  }
  if (score >= 70) {
    return {
      summary: `Solid call overall - compliant on the essentials with a few coachable moments.`,
      strengths: [
        'Identity, FCA status and recording disclosure delivered promptly',
        'Explored the client\'s protection need before recommending',
        'Cooling-off and next steps stated at the close',
      ],
      improvements: [
        'Be explicit about the duty of disclosure - non-disclosure can void a claim (CIDRA)',
        'Raise writing the policy in trust',
      ],
      next_actions: ['Add the disclosure-duty explanation to your standard application step', 'Add a trust prompt to your close'],
    };
  }
  if (score >= 50) {
    return {
      summary: `Marginal call - several items partially covered but not to the required standard. Coaching needed before the next similar case.`,
      strengths: [
        'Call opened correctly with FCA status and recording notice',
        'Rapport with the client was professional throughout',
      ],
      improvements: [
        'Demands and needs were not fully established before recommending',
        'A vulnerability cue was passed over rather than triggering the protocol (FG21/1)',
        'The duty of disclosure was not explained (CIDRA)',
      ],
      next_actions: [
        'Schedule a 1:1 covering demands-and-needs and vulnerability handling',
        'Re-read FG21/1 vulnerability guidance before the next advice call',
        'Use the firm protection checklist on the next three calls',
      ],
    };
  }
  return {
    summary: `Critical fail. Multiple fundamental items were missed. Escalate to compliance before any application proceeds.`,
    strengths: ['Call recording disclosure was stated', 'The client was given the opportunity to ask questions'],
    improvements: [
      'Demands and needs were never properly established - fundamental for any protection recommendation',
      'The duty of disclosure (CIDRA) was not explained - this can void a claim',
      'A clear vulnerability indicator was not screened or acted on (FG21/1)',
      `${failingItems} scorecard criteria were not met - a pattern, not isolated`,
    ],
    next_actions: [
      'Escalate immediately to the compliance officer - do NOT submit the application',
      'Suspend from independent advice calls until supervised retraining is complete',
      'Complete the ICOBS demands-and-needs and FG21/1 refresher within 7 days',
    ],
  };
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
