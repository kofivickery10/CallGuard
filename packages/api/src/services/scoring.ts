import { config } from '../config.js';
import { CLAUDE_MODELS, isItemPass } from '@callguard/shared';
import type { CallCoaching } from '@callguard/shared';

// 1-hour prompt-cache TTL (2x write, 0.1x read). The pinned SDK's types
// predate the GA `ttl` field, hence the cast; the beta header below is the
// pre-GA opt-in — harmless now, and keeps this working if the account is
// still gated on it.
export const CACHE_1H = { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' };
export const CACHE_TTL_HEADERS = { headers: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } };

interface ScorecardItemInput {
  id: string;
  label: string;
  description: string | null;
  score_type: 'binary' | 'scale_1_5' | 'scale_1_10';
  // Checkpoint model additions (spec §8) — only 'ai' items with these
  // populated are ever passed to this function; 'manual' and branch-excluded
  // ('na') items are filtered out by the caller before scoring.
  expectation?: string | null;
  ai_check?: string | null;
  consent_gate?: boolean;
}

export interface ItemScoreOutput {
  scorecard_item_id: string;
  score: number;
  confidence: number;
  evidence: string;
  reasoning: string;
}

export interface ScoringOutput {
  items: ItemScoreOutput[];
  coaching?: CallCoaching;
}

export interface LearningContext {
  // Per-scorecard-item list of past corrections
  correctionsByItem: Record<string, Array<{
    corrected_pass: boolean;
    reason: string | null;
    transcript_excerpt: string | null;
  }>>;
  // Firm exemplar transcript excerpts
  exemplars: Array<{ excerpt: string; reason: string | null }>;
  // Prior coaching given to this agent
  priorCoaching: Array<{ created_at: string; coaching: CallCoaching }>;
}

function buildScoringPrompt(
  transcript: string,
  items: ScorecardItemInput[],
  kbContext: string | null | undefined = '',
  withCoaching: boolean = false,
  learning?: LearningContext | null,
  industry?: string | null,
  journeyMode: boolean = false,
  // Product-aware scoring: the products this sale covered. Goes in the dynamic
  // (per-call) part of the prompt, not the cached prefix — it varies per
  // journey, so caching it would bust the per-scorecard cache. Criteria not
  // relevant to these products are already filtered out before scoring; this
  // just gives the model the context to judge the ones that remain.
  productsSold: string[] = [],
  // True when the speaker-integrity check found the Agent/Customer labels
  // contradicted by conversational content (services/speaker-integrity.ts).
  // Escalates the standing "labels may be swapped" caveat into a per-call
  // instruction. Lives in the DYNAMIC block, not the cached prefix — it varies
  // per call, so caching it would bust the per-scorecard cache.
  speakerLabelsUnreliable: boolean = false
): { cached: string; dynamic: string } {
  const criteriaBlock = items
    .map((item, i) => {
      const scaleDesc = {
        binary: 'Score 1 if yes, 0 if no.',
        scale_1_5: 'Score from 1 (poor) to 5 (excellent).',
        scale_1_10: 'Score from 1 (poor) to 10 (excellent).',
      }[item.score_type];

      // Append any past corrections for this specific criterion
      const corrections = learning?.correctionsByItem[item.id] || [];
      const correctionsBlock = corrections.length > 0
        ? `\n  Tenant calibration (past human corrections):\n${corrections
            .slice(0, 5)
            .map((c, idx) => {
              const excerpt = (c.transcript_excerpt || '').slice(0, 200);
              return `    ${idx + 1}. Human judged: ${c.corrected_pass ? 'PASS' : 'FAIL'}${c.reason ? ` - ${c.reason}` : ''}${excerpt ? ` (evidence: "${excerpt}")` : ''}`;
            })
            .join('\n')}`
        : '';

      const expectationLine = item.expectation ? `\n  Expectation: ${item.expectation}` : '';
      const aiCheckLine = item.ai_check
        ? `\n  Presence-and-meaning check: ${item.ai_check} — a keyword match alone is not enough; confirm the substance was actually conveyed.`
        : '';
      const consentLine = item.consent_gate
        ? '\n  CONSENT GATE: only score this as met if the customer gives an explicit, affirmative response (e.g. "yes", "that\'s fine", "I agree"). Do NOT infer consent from silence, from the call continuing, or from the adviser proceeding as if consent were given. If the transcript does not show an explicit customer affirmative, score it as not met.'
        : '';

      return `Criterion ${i + 1} (ID: ${item.id}):
  Label: ${item.label}
  ${item.description ? `Rubric: ${item.description}` : ''}${expectationLine}${aiCheckLine}${consentLine}
  Scoring: ${scaleDesc}${correctionsBlock}`;
    })
    .join('\n\n');

  const kbBlock = kbContext?.trim()
    ? `\n\n## Business Knowledge Base\n\nThis is the business-specific context you should use when evaluating. Use this to understand the company's products, compliance requirements, expected call flow, and industry-specific language.\n\n${kbContext}\n`
    : '';

  const exemplarBlock = learning?.exemplars && learning.exemplars.length > 0
    ? `\n\n## Firm Exemplars (What Good Looks Like Here)\n\nThe following excerpts are from calls this firm has marked as exemplars - representative of the quality bar. Score the current call against this standard:\n\n${learning.exemplars
        .map((e, i) => `**Exemplar ${i + 1}${e.reason ? ` - ${e.reason}` : ''}:**\n${e.excerpt.slice(0, EXEMPLAR_EXCERPT_CHARS)}`)
        .join('\n\n')}\n`
    : '';

  const priorCoachingBlock = withCoaching && learning?.priorCoaching && learning.priorCoaching.length > 0
    ? `\n\n## Prior Coaching Given To This Agent\n\nBelow is the most recent coaching this agent received. When producing coaching for the current call:\n- If they have improved on prior flagged areas, explicitly acknowledge it\n- If they have NOT improved, escalate the tone (firmer language, clearer action)\n- Avoid repeating the same improvements verbatim unless the issue has recurred\n\n${learning.priorCoaching
        .slice(0, 3)
        .map((pc, i) => {
          return `**${i + 1}. ${new Date(pc.created_at).toLocaleDateString('en-GB')}:**\n- Summary: ${pc.coaching.summary}\n- Improvements flagged: ${pc.coaching.improvements.slice(0, 3).join('; ')}\n- Actions requested: ${pc.coaching.next_actions.slice(0, 2).join('; ')}`;
        })
        .join('\n\n')}\n`
    : '';

  const domain = industry?.trim();
  const callHeadline = domain
    ? `a UK ${domain} call`
    : 'a UK sales or customer-service call';
  const domainContextLine = domain
    ? `- This is ${callHeadline} between an agent/adviser and the customer. Evaluate it against the standards, disclosures and regulatory expectations of that sector, using the Business Knowledge Base below for the firm's specifics.`
    : '- This is a sales or customer-service call between an agent and a customer. Use the Business Knowledge Base below to understand the products, expected call flow, and context.';

  // Split into a stable, cacheable prefix (system framing + KB + exemplars +
  // criteria + instructions — identical for every call scored against the same
  // scorecard for this org) and a volatile suffix (this agent's prior coaching +
  // this call's transcript). Prompt caching then bills the big prefix once per
  // ~1-hour window (see the cache_control ttl below) instead of on every call.
  const cached = `You are a call quality and compliance analyst evaluating ${callHeadline}. You will evaluate the transcript against specific scoring criteria.

## Important Context

${domainContextLine}
- Speaker labels ("Agent" / "Customer") are auto-generated and may occasionally be swapped. Use context to determine who is actually the agent vs customer. The agent is the one asking verification questions, presenting products, reading disclaimers, and guiding the call flow. The customer is asking questions, confirming details, and making decisions.
- The audio quality may be low, so some words may be transcribed incorrectly. Consider near-homophones and phonetic similarities when evaluating.
- Personal/sensitive data is redacted to typed tags like [PII_NAME_1], [LOCATION_1], [PHONE_NUMBER_1], [CREDIT_CARD_1] or [PHI_...]. A tag is positive evidence that the customer DID provide (and/or the agent DID collect) that piece of information - treat it as the information being present, and quote the tag as evidence. Do NOT mark a criterion unmet merely because the value is redacted. The one limit: when a criterion requires the agent to read a value back and confirm it MATCHES what the customer gave, you cannot verify the values are identical (each redacted instance is numbered independently) - score that on whether the read-back/confirmation step occurred, and note the limitation in your reasoning.${kbBlock}${exemplarBlock}

## Scoring Criteria

${criteriaBlock}

## Instructions

Evaluate the call transcript${journeyMode ? '(s)' : ''} (provided below) against each criterion listed above. For each criterion:
1. Determine the appropriate score based on the scoring type
2. Provide a direct quote from the transcript as evidence. Where the topic was discussed but falls short of what the criterion requires, quote what WAS said and name the missing element — the verdict in that case is still NOT MET. Finding related discussion is not the same as the criterion being satisfied; quoting it only makes your reasoning checkable. Reserve "No relevant evidence found" for criteria the call genuinely never touches, because a reviewer who can see the topic being discussed will not trust a verdict claiming it never was.
3. Explain your reasoning in 1-2 sentences
4. Assess your confidence from 0.0 to 1.0
${journeyMode ? `
This is a customer JOURNEY spanning multiple calls, each delimited by a header like "=== Call 2 (2026-01-15, agent: Jane) ===". Score each criterion against the whole journey, not any single call in isolation — a statement, disclosure or consent counts as met if it was given anywhere across the calls, even if the criterion's specific call ended without it. When you cite evidence, prefix the quote with the matching call marker in brackets exactly as shown, e.g. \`[Call 2] "...quote..."\`, so it's clear which call it came from.
` : ''}
Where a criterion requires SEVERAL things — "explained the exclusions and the 30-day cancellation rights", "confirmed the name, address and date of birth" — it is met only if the transcript shows EVERY element. Partial satisfaction is not a pass: score it as not met and name the missing element in your reasoning. Delivering one half of a two-part disclosure convincingly is the single most common way a criterion gets wrongly marked as met.

Be strict but fair, and be equally sceptical in both directions. A wrong failure puts a breach on a regulated firm's compliance register that the adviser will have to dispute. A wrong pass is quieter and worse: it tells the firm a mandatory disclosure was given when it was not, and nobody ever appeals being told they are compliant. Do not mark a criterion met just because the adviser covered the topic — check they actually did the thing the criterion asks for.

Only score based on what is explicitly present in the transcript${journeyMode ? '(s)' : ''}.
If the transcript${journeyMode ? '(s are)' : ' is'} unclear or the criterion cannot be evaluated, give the lowest score and note low confidence.${withCoaching ? `

## Coaching Output (REQUIRED)

In addition to the scoring, produce a coaching brief for the agent:

- **summary**: 1-2 sentences describing the overall call quality in plain, motivating language
- **strengths**: 2-4 specific things the agent did well (reference exact moments where possible)
- **improvements**: 2-4 specific things to work on next time (be constructive, not punitive)
- **next_actions**: 1-3 concrete, practical actions the agent should take next (e.g. "Practice open-ended ATR questioning using the scenario: 'If your portfolio fell 20%, how would that affect your plans?'")

Coaching tone: supportive, specific, actionable. Avoid generic platitudes like "keep up the good work" - be concrete. If the call was a critical fail, focus coaching on the most impactful 2-3 things the agent must change, not a laundry list.` : ''}`;

  const productsBlock = productsSold.length > 0
    ? `\n\n## Products Sold On This Sale\n\nThe customer bought: ${productsSold.join(', ')}. Judge each criterion in the context of these products. The criteria you have been given are already scoped to what's relevant to this sale.\n`
    : '';

  // An automated check found adviser-specific content (scripted questions,
  // compliance wording, pricing) sitting under "Customer:" turns. Attributing a
  // customer's own words to the adviser has produced false CRITICAL breaches —
  // e.g. failing "the adviser did not lead the customer" on evidence that was
  // the customer speaking — so on these calls the model must judge role from
  // content and decline to score anything that hinges on an unresolvable label.
  const speakerWarningBlock = speakerLabelsUnreliable
    ? `\n\n## ⚠ Speaker labels on THIS transcript are unreliable\n\nAn automated check found content that only an adviser would say appearing under "Customer:" turns (and/or the reverse). The labels below are NOT trustworthy — they may be inverted for part or all of the call.\n\n- Work out who is actually speaking from the CONTENT of each turn, not the label. The adviser reads scripted questions, quotes prices, gives compliance wording and drives the call; the customer answers about their own health, money and circumstances.\n- Where a criterion depends on WHO said something and you cannot establish that from content, score it as not met and set confidence at or below 0.4, stating in your reasoning that speaker attribution was unreliable.\n- Do NOT raise a failure that rests solely on attributing a turn to the adviser when the content suggests it was the customer.\n`
    : '';

  const dynamic = `${priorCoachingBlock}${productsBlock}${speakerWarningBlock}

## Call Transcript${journeyMode ? 's (this customer\'s journey)' : ''}

<transcript>
${transcript}
</transcript>`;

  return { cached, dynamic };
}

// How much of an exemplar transcript to feed the scoring prompt. Lives in the
// cached prefix (billed once per ~1h window), so a generous cap costs little
// but lets the model actually see the good behaviour — a compliant close often
// sits well past the opening 400 chars, especially for a whole-sale exemplar.
export const EXEMPLAR_EXCERPT_CHARS = 1500;

// One strong pass, not a cheap pass plus a second opinion.
//
// The pipeline used to score on Haiku and re-check flagged items on Sonnet. That
// made sense when the second opinion touched a handful of items, but it never
// paid off in practice: the verify stage broke twice on output budgeting, both
// times silently, and on the sale that exposed it Haiku produced a false breach
// at 0.95 confidence ("no evidence of GP contact" on a call where it was
// explained four times), missed two explicit consent "yes" responses, and passed
// a compound criterion on half its content. Every human correction on record is
// a Haiku error.
//
// Scoring once on Sonnet costs roughly half the two-pass design (~$0.16 vs
// ~$0.30 per sale on a 44-item scorecard), removes an entire stage and its
// failure modes, and applies the strictness and compound-criteria rules that
// used to live in the verify prompt to EVERY item on the first pass rather than
// only to items that reached a second one.
const DEFAULT_SCORING_MODEL = CLAUDE_MODELS.SONNET_5;

// How many times to re-sample the scoring call when the model returns a valid
// but incomplete item set (see the coverage retry in scoreTranscript).
const SCORING_COVERAGE_ATTEMPTS = 3;

export async function scoreTranscript(
  transcript: string,
  items: ScorecardItemInput[],
  modelOverride: string | null = null,
  kbContext: string | null = null,
  learning?: LearningContext | null,
  withCoaching: boolean = false,
  industry: string | null = null,
  // True for journey scoring (spec §9): the transcript spans multiple calls
  // delimited by "=== Call N ===" markers — see services/journey.ts, which
  // asks Claude to prefix evidence quotes with the matching marker so the
  // journey processor can attribute each checkpoint back to its source call.
  journeyMode: boolean = false,
  // Product-aware scoring: names of the products this sale covered, surfaced to
  // the model as context (see buildScoringPrompt).
  productsSold: string[] = [],
  // The speaker-integrity check flagged this transcript's Agent/Customer labels
  // as contradicted by content — see buildScoringPrompt.
  speakerLabelsUnreliable: boolean = false
): Promise<{ output: ScoringOutput; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }; model: string }> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for scoring');
  }

  // Dynamic import to avoid SDK initializing at startup
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const model = modelOverride ?? DEFAULT_SCORING_MODEL;

  const prompt = buildScoringPrompt(transcript, items, kbContext, withCoaching, learning, industry, journeyMode, productsSold, speakerLabelsUnreliable);

  // Scale the output budget to the scorecard size: each scored item returns an
  // id + score + confidence + an evidence quote + reasoning (~300-400 tokens).
  // A fixed 4096 truncated the submit_scores tool call mid-JSON on large
  // scorecards (e.g. 47 items), so output.items came back undefined. Haiku 4.5
  // supports up to 64k output; cap generously.
  const perItemBudget = 400;
  const maxTokens = Math.min(
    32000,
    (withCoaching ? 6144 : 2048) + items.length * perItemBudget
  );

  // The model occasionally returns a valid, complete submit_scores tool-call
  // that simply OMITS one item on a large scorecard. The 1:1 coverage guards in
  // score.ts / score-journey.ts then reject the whole result and fail the job —
  // which, mid BullMQ retry, leaves a journey wedged in 'scoring'. Temperature
  // is unpinned, so a fresh sample almost always returns the full set: re-sample
  // here on incomplete coverage rather than burning job retries. Usage is summed
  // across attempts so billing reflects the real spend.
  const requestedIds = new Set(items.map((i) => i.id));
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let output: ScoringOutput | null = null;

  for (let attempt = 1; attempt <= SCORING_COVERAGE_ATTEMPTS; attempt++) {
    // Stream rather than a plain create: journey scoring builds a large output
    // budget (up to 32k on big scorecards), and the SDK now hard-errors on a
    // non-streaming request whose max_tokens implies it could run past 10 minutes
    // ("Streaming is strongly recommended..."). finalMessage() returns the same
    // Message shape.
    // NOTE ON THINKING — deliberately not set.
    //
    // Sonnet 5 runs adaptive thinking by default when the parameter is omitted
    // (Sonnet 4.6 and Haiku do not). Scoring therefore runs WITH thinking, and
    // that is the configuration measured in scripts/eval-scoring-models.ts:
    // 8/8 against hand-checked ground truth, ~5.5k output tokens, 76s.
    //
    // It is left implicit rather than stated explicitly because the pinned SDK
    // predates adaptive thinking — its types only admit 'enabled' | 'disabled',
    // so setting it would mean casting around the type system to send a field
    // the SDK does not model. Not worth the risk for a parameter whose value is
    // already the default. Make it explicit when the SDK is next upgraded.
    //
    // The consequence to remember: max_tokens caps thinking AND response
    // together. The per-item budget above has ample headroom (a measured 44-item
    // run used ~5.5k of ~23.7k), but a model change or a much larger scorecard
    // should be re-measured rather than assumed.
    const response = await client.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            // Stable prefix (scorecard + KB + instructions) — cached across
            // calls. 1-hour TTL (2x write vs 1.25x for 5-min, reads 0.1x
            // either way): production calls arrive minutes-to-an-hour apart,
            // which the 5-minute TTL misses on all but tight batches — one
            // extra hit within the hour already pays for the dearer write.
            { type: 'text', text: prompt.cached, cache_control: CACHE_1H },
            // Per-call suffix (this agent's coaching + this transcript).
            { type: 'text', text: prompt.dynamic },
          ],
        },
      ],
      tools: [
        {
          name: 'submit_scores',
          description: 'Submit the evaluation scores for all criteria',
          input_schema: {
            type: 'object' as const,
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    scorecard_item_id: { type: 'string' },
                    score: { type: 'number' },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    evidence: { type: 'string' },
                    reasoning: { type: 'string' },
                  },
                  required: [
                    'scorecard_item_id',
                    'score',
                    'confidence',
                    'evidence',
                    'reasoning',
                  ],
                },
              },
              ...(withCoaching ? {
                coaching: {
                  type: 'object',
                  description: 'Coaching brief for the agent - strengths, improvements, and next actions',
                  properties: {
                    summary: { type: 'string', description: '1-2 sentence overall assessment' },
                    strengths: {
                      type: 'array',
                      items: { type: 'string' },
                      minItems: 2,
                      maxItems: 4,
                    },
                    improvements: {
                      type: 'array',
                      items: { type: 'string' },
                      minItems: 2,
                      maxItems: 4,
                    },
                    next_actions: {
                      type: 'array',
                      items: { type: 'string' },
                      minItems: 1,
                      maxItems: 3,
                    },
                  },
                  required: ['summary', 'strengths', 'improvements', 'next_actions'],
                },
              } : {}),
            },
            required: withCoaching ? ['items', 'coaching'] : ['items'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_scores' },
    }, CACHE_TTL_HEADERS).finalMessage();

    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

    const toolUse = response.content.find(
      (block) => block.type === 'tool_use'
    );
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Claude did not return structured scores');
    }

    // If the model hit the token ceiling mid tool-call, the input JSON is
    // incomplete and `items` is missing — fail clearly here rather than letting
    // an undefined `output.items` blow up downstream (score.ts / score-journey.ts).
    //
    // Report what actually happened rather than assuming truncation. The
    // previous message asserted "likely truncated" unconditionally, which sent
    // a real investigation down the wrong path: the failure it was diagnosing
    // had stop_reason=tool_use, meaning the model finished normally and the
    // problem was the payload shape, not the budget. On a thinking model
    // max_tokens covers reasoning AND output together, so genuine exhaustion is
    // worth distinguishing from a malformed result.
    const candidate = toolUse.input as ScoringOutput;
    if (!candidate || !Array.isArray(candidate.items)) {
      const truncated = response.stop_reason === 'max_tokens';
      const shape = candidate ? `keys=[${Object.keys(candidate).join(',')}]` : 'no tool input';
      throw new Error(
        truncated
          ? `Claude ran out of output budget before finishing the scores ` +
            `(max_tokens=${maxTokens}, requested ${items.length} items). On a thinking model this ` +
            `budget covers reasoning as well as output — raise it or score fewer items at once.`
          : `Claude returned a malformed submit_scores payload — expected an "items" array, got ` +
            `${shape} (stop_reason=${response.stop_reason}, requested ${items.length} items). ` +
            `Not a truncation: the model stopped of its own accord.`
      );
    }
    output = candidate;

    // Coverage retry (the flaky-omission case above). A complete set is the
    // common outcome, so this usually runs once.
    //
    // This must test exactly what the callers' 1:1 guards test (score.ts /
    // score-journey.ts): missing ids, duplicated ids, AND ids that weren't
    // requested. Checking only for missing ones let a duplicate or hallucinated
    // id sail past here and get rejected downstream instead — throwing away the
    // whole job and burning a BullMQ retry to re-sample something this loop
    // exists to re-sample for free.
    const got = new Set(candidate.items.map((it) => it.scorecard_item_id));
    const missing = [...requestedIds].filter((id) => !got.has(id));
    const duplicated = candidate.items.length - got.size;
    const unknown = candidate.items.filter((it) => !requestedIds.has(it.scorecard_item_id)).length;
    if (missing.length === 0 && duplicated === 0 && unknown === 0) break;

    const faults = [
      missing.length > 0 ? `${missing.length} missing` : null,
      duplicated > 0 ? `${duplicated} duplicated` : null,
      unknown > 0 ? `${unknown} unrequested` : null,
    ].filter(Boolean).join(', ');
    if (attempt < SCORING_COVERAGE_ATTEMPTS) {
      console.warn(`[Scoring] attempt ${attempt}/${SCORING_COVERAGE_ATTEMPTS} returned ${faults} of ${requestedIds.size} item(s) — re-sampling`);
    } else {
      console.error(`[Scoring] still ${faults} after ${SCORING_COVERAGE_ATTEMPTS} attempts — returning incomplete set (caller coverage guard will reject)`);
    }
  }

  return {
    // output is assigned on every iteration; the loop runs at least once.
    output: output!,
    usage,
    model,
  };
}

/** One checkpoint's verdict after voting across independent scoring runs. */
export interface ConsensusItem extends ItemScoreOutput {
  // Fraction of runs that reached this verdict (1.0 = unanimous).
  agreement: number;
  // True when the runs did not all agree. The caller routes these to manual
  // review rather than auto-scoring them, which is the entire point: a
  // checkpoint the model cannot decide consistently should be decided by a
  // person, not by whichever sample happened to be drawn.
  disputed: boolean;
}

export interface ConsensusResult {
  items: ConsensusItem[];
  coaching?: CallCoaching;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  model: string;
  samples: number;
}

/**
 * Score a transcript several times and let the runs vote on each checkpoint.
 *
 * Why this exists, measured rather than assumed: across three Trust Point sales
 * at four runs each, ~85% of checkpoints scored identically every time and the
 * remaining ~15% produced a consistent ~7-point spread in the headline score.
 * One checkpoint split exactly 6/6 on all three sales — a pure coin toss, on a
 * compliance register.
 *
 * The sampling cannot be disabled. Sonnet 5 rejects `temperature` outright, and
 * even where it is accepted, temperature 0 never guaranteed identical output —
 * it would simply return the same side of a 55/45 judgement every time, which
 * is stable but arbitrary and conceals the ambiguity.
 *
 * Voting uses the distribution instead. Where runs agree, the verdict is solid.
 * Where they disagree, the checkpoint is genuinely ambiguous and is marked
 * `disputed` so the caller can send it to a human. Because disputed items are
 * then excluded from the weighted denominator, the resulting score is computed
 * only over unanimous verdicts and is stable by construction.
 *
 * Runs are sequential, not parallel: the prompt's cached prefix is written by
 * the first call and read by the rest, which firing them together would miss.
 */
export async function scoreTranscriptConsensus(
  samples: number,
  ...args: Parameters<typeof scoreTranscript>
): Promise<ConsensusResult> {
  const runs: ScoringOutput[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let model = '';

  for (let i = 0; i < Math.max(1, samples); i++) {
    const r = await scoreTranscript(...args);
    runs.push(r.output);
    model = r.model;
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
    usage.cache_creation_input_tokens += r.usage.cache_creation_input_tokens;
    usage.cache_read_input_tokens += r.usage.cache_read_input_tokens;
  }

  const items = args[1];
  const byType = new Map(items.map((i) => [i.id, i.score_type]));
  const out: ConsensusItem[] = [];

  for (const item of items) {
    const verdicts = runs
      .map((r) => r.items.find((it) => it.scorecard_item_id === item.id))
      .filter((v): v is ItemScoreOutput => !!v);
    if (verdicts.length === 0) continue;

    // Vote on the pass/fail outcome rather than the raw number: a 1-5 item
    // scored 4 and 5 by two runs agrees on the verdict even though the numbers
    // differ, and it is the verdict that drives the breach register.
    const scoreType = byType.get(item.id) ?? 'binary';
    const passes = verdicts.filter((v) => isItemPass(normalizeScore(v.score, scoreType)));
    const majorityPassed = passes.length * 2 > verdicts.length;
    const agreeing = majorityPassed ? passes : verdicts.filter((v) => !passes.includes(v));

    // Represent the majority with its most confident run, so the stored
    // evidence quote and reasoning come from a run that actually reached the
    // recorded verdict rather than being stitched together across runs.
    const representative = agreeing.reduce((best, v) => (v.confidence > best.confidence ? v : best), agreeing[0]!);
    const agreement = agreeing.length / verdicts.length;

    out.push({
      ...representative,
      agreement,
      disputed: agreeing.length !== verdicts.length,
    });
  }

  // Coaching is narrative rather than a verdict, so there is nothing to vote
  // on — take the first run's.
  return { items: out, coaching: runs[0]?.coaching, usage, model, samples: runs.length };
}

// Clamped to [0, 100] — Claude's raw score is expected within the scale's
// range (e.g. 1-5), but an out-of-range or malformed value (0, a negative
// number, a hallucinated 6 on a 1-5 scale) would otherwise normalize outside
// [0, 100] and skew the weighted average / auto-exemplar check silently.
export function normalizeScore(score: number, scoreType: string): number {
  const normalized = (() => {
    switch (scoreType) {
      case 'binary':
        return score * 100;
      case 'scale_1_5':
        return ((score - 1) / 4) * 100;
      case 'scale_1_10':
        return ((score - 1) / 9) * 100;
      default:
        return score;
    }
  })();
  return Math.min(100, Math.max(0, normalized));
}
