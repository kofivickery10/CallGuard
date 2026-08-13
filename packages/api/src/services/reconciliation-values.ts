import { config } from '../config.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import { CACHE_TTL_HEADERS } from './scoring.js';

// ============================================================
// Extracting what the customer actually said, for questions the deterministic
// pass has already LOCATED in the transcript.
//
// WHY THIS IS A SEPARATE, NARROW PASS
//
// Everything up to here is deterministic: which questions the application asked,
// whether each was put to the customer, and whether absence is meaningful. That
// matters because a reconciliation flag is an allegation about an adviser, and
// "these words appear nowhere in the call" is reproducible in a way a model's
// opinion is not.
//
// Pulling a customer's answer out of surrounding speech is the one part a model
// is genuinely better at — "about seventeen and a half stone" against
// "111.1kg or 17 stone 7 pounds" needs reading, not matching. So the model is
// given exactly that job and nothing else.
//
// It sees only the EXCERPTS around already-located questions, never the whole
// transcript. For a fifty-question application that is roughly 4k tokens rather
// than 30k, and it keeps the model away from the parts of the call it has no
// business reading.
// ============================================================

const DEFAULT_VALUE_MODEL = CLAUDE_MODELS.HAIKU;

/**
 * Whether this model still accepts `temperature`.
 *
 * An ALLOWLIST, deliberately. Anthropic removed the sampling parameters on
 * Opus 4.7 and every model since — sending one is a 400, not a warning — and
 * the direction of travel is that newer models keep dropping them. Listing what
 * accepts them means an unrecognised model simply runs at its default instead
 * of failing every extraction on the tenant that adopts it.
 */
function acceptsTemperature(model: string): boolean {
  return /^claude-(haiku-4-5|sonnet-4-6|opus-4-6)\b/.test(model);
}

export interface ValueExtractionRequest {
  /** Stable key so answers can be matched back. Use the question's sort order. */
  key: string;
  question: string;
  /**
   * The options the question offered, where it had any.
   *
   * Required for the same reason the search needs them: a list-selection health
   * question carries almost none of its meaning in its own wording. Sent
   * "Have you ever:" with no list, the model answered — correctly — that it
   * "lacks clear context about what specific items are being asked about", and
   * the item resolved undetermined even though the passage in front of it held
   * the adviser reading the list out and the customer answering.
   */
  choices?: string[];
  /** What the insurer recorded, for context on what kind of answer to look for. */
  applicationAnswer: string;
  /**
   * The passages of call where this question's topic appears, in order.
   *
   * Plural deliberately. A topic is commonly named more than once — the adviser
   * previews what they are about to cover, then asks — and only one of those
   * places holds the answer. Sending the first alone reported perfectly good
   * answers as never given.
   */
  excerpts: string[];
}

export interface ExtractedValue {
  key: string;
  /**
   * What the customer said, normalised to the shape of the application answer.
   * Null when the excerpt does not actually contain the customer answering — the
   * deterministic pass located the TOPIC, which is not the same thing.
   */
  value: string | null;
  /** True when the topic was discussed but the value itself was redacted out. */
  redacted: boolean;
  /**
   * True only when the exchange can be read through and the customer plainly
   * did not answer — they deflected, changed the subject, or the adviser moved
   * on. NOT the same as "no answer could be read", which is the ordinary null
   * and means only that we could not tell.
   *
   * This is what promotes an item to a finding against an adviser, so it is
   * asked for as its own judgement rather than inferred from value === null.
   */
  customerDidNotAnswer: boolean;
  confidence: number;
  reasoning: string;
}

const TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: ['string', 'null'] },
          redacted: { type: 'boolean' },
          customer_did_not_answer: {
            type: 'boolean',
            description:
              'True ONLY if you can read the exchange through and the customer plainly did not answer — they deflected, changed the subject, or the adviser moved on without an answer. False if you simply could not tell, including when a passage is cut off mid-sentence.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reasoning: { type: 'string' },
        },
        required: ['key', 'value', 'redacted', 'customer_did_not_answer', 'confidence', 'reasoning'],
      },
    },
  },
  required: ['answers'],
};

const INSTRUCTIONS = `You are reading short excerpts from a recorded protection-insurance
sale. For each excerpt you are told the question the insurer asked and the answer
recorded on the submitted application. Your ONLY job is to report what the
CUSTOMER said in that excerpt.

Rules:

1. Report the CUSTOMER's answer, never the adviser's. The adviser asking "so no
   heart problems?" is not the customer answering.

2. You may be given SEVERAL passages for one question, because the topic comes
   up more than once in the call. They are places in the same conversation, not
   alternatives: read all of them and report the answer from whichever one
   actually contains the customer answering. The adviser commonly previews the
   topics they are about to cover before asking about any of them, so an early
   passage with no answer in it means nothing on its own — check the later ones
   before concluding the question went unanswered.

3. Return value: null when NONE of the passages contains the customer answering
   that question. Locating the topic is not the same as an answer being given —
   the adviser may have mentioned it in passing, read a list aloud, or moved on.
   A null is a correct and useful result. Do not reach for an answer that is not
   there.

   Note the customer may answer several questions at once ("no to all of those"
   after a list is read out). That IS an answer to each question in the list.

4. NEVER let the application answer influence what you report. It is given only
   so you know what kind of value to look for (a yes/no, a number, a condition
   name). If the customer said something different, report what they said. The
   entire purpose of this exercise is to find those disagreements, so anchoring
   on the application answer defeats it.

5. Set redacted: true when the topic is clearly being answered but the value
   itself has been removed, which appears as a tag in square brackets such as
   [CONDITION_7], [DRUG_3] or [NUMBER]. In that case also return value: null. We
   know they answered; we cannot see what they said.

6. Normalise to the form the question invites: "yeah, never touched them" for a
   smoking question is "No". Keep numbers as the customer gave them.

   People answer in their own terms, and an answer given in different words is
   still an answer. "I'm full time" answers "are you working 16 hours or more a
   week?" — nobody says "yes, sixteen hours or more". "I gave up years ago"
   answers a smoking question. Report the plain meaning of what they said, say
   in reasoning which words you took it from, and set confidence to reflect how
   direct it was: an explicit answer is high, a clear implication is moderate,
   and something you had to reason around is low enough to be discarded.

   The limit is that the implication must be theirs and not yours. If the
   customer described only their PREVIOUS job, or gave a figure that could fall
   either side of the threshold, that is not an answer to the question asked.

7. ANSWER THE QUESTION ASKED, INCLUDING ITS CONDITIONS. Insurers write long
   questions with a threshold or a qualifier inside them, and the plain fact the
   customer mentions is often NOT an answer to it.

   "Do you have any existing life cover, or are you applying for other cover,
   which would mean your total cover would exceed £1,500,000?" is not asking
   whether they have life insurance. A customer saying "I've got a policy with
   Royal London" has told you nothing about the total — so the answer is null,
   not Yes.

   The same goes for any question qualified by an amount, a period ("in the last
   12 months"), a place, or a degree of severity. If what the customer said does
   not settle the qualifier, return null and say so in reasoning. Answering the
   simpler question hiding inside a longer one is how a correct application
   answer gets contradicted by a customer who never disagreed with it.

   Follow-up questions like "Are you fully recovered?" or "When did symptoms
   last occur?" are about ONE specific condition — the one named in the
   question, its Section line, or the application answer's context. The
   customer talking about a DIFFERENT ailment is not an answer to it: a rash
   that is "just not going" says nothing about whether they recovered from
   bowel polyps. If you cannot tell which condition the passage is about,
   return null.

   This is a case of a wider rule: the passage located is sometimes about a
   DIFFERENT QUESTION entirely, not merely a different condition — a customer
   agreeing to their GP being contacted is not the same as them disclosing a
   health condition, even though both passages might mention a doctor. If your
   own reasoning would describe the passage as being about something other than
   what this question asks, that is your answer: return null. Do not let a
   shared word (both mention "GP", both say "yeah") stand in for the passage
   actually addressing the question.

   Hardest of all: two facts that are RELATED BUT NOT THE SAME, where one is
   chosen because of the other. The date a customer is PAID is not the date
   their premium is COLLECTED — the adviser hears "I get paid on the 5th" and
   deliberately sets collection a few days later, so a form saying the 8th is
   the adviser doing their job, not contradicting the customer. The same trap:
   the cover a customer ASKED about against the cover they TOOK, the premium
   QUOTED against the premium AGREED, the job they used to do against the job
   they do now. These feel like answers because the passage really is about the
   right subject. Ask whether the customer stated THE fact the question asks
   for. If they stated something the answer was merely derived from, return
   null — you have found the reason for the answer, not the answer.

8. customer_did_not_answer is a separate judgement from value, and a heavier
   one: it says the adviser recorded an answer the customer never gave, which
   goes in front of a compliance reviewer. Set it true only when you can read
   the exchange through and see them deflect, change the subject, or the adviser
   move on. If a passage is cut off mid-sentence, or the conversation simply
   goes somewhere you cannot follow, set it FALSE — "I could not tell" is a
   perfectly good answer and is treated as such.

9. Be honest in confidence. Below 0.6 means you are guessing, and a guess here
   becomes an allegation against an adviser.`;

/**
 * Extract customer answers from located excerpts.
 *
 * Returns an empty array rather than throwing when there is nothing to do, so
 * callers need no special case for a sale where every question was missed.
 */
export async function extractCallAnswers(
  requests: ValueExtractionRequest[],
  modelOverride: string | null = null
): Promise<{
  values: ExtractedValue[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}> {
  if (requests.length === 0) {
    return { values: [], usage: { input_tokens: 0, output_tokens: 0 }, model: '' };
  }
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for reconciliation');
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = modelOverride ?? DEFAULT_VALUE_MODEL;

  const body = requests
    .map((r) => {
      const passages = r.excerpts
        .map((e, i) =>
          r.excerpts.length > 1 ? `Passage ${i + 1} of ${r.excerpts.length}:\n${e}` : e
        )
        .join('\n\n');
      // The options go directly under the question, because for a stub like
      // "Have you ever:" they ARE the question.
      const options =
        r.choices && r.choices.length > 0
          ? `Options the question offered: ${r.choices.join(', ')}\n`
          : '';
      return (
        `--- key: ${r.key}\nQuestion: ${r.question}\n${options}` +
        `Recorded on the application: ${r.applicationAnswer}\n` +
        `Passages from the call where this topic comes up:\n${passages}`
      );
    })
    .join('\n\n');

  // Budget per question, capped — the same truncation-avoidance shape as scoring
  // and capture. A truncated tool call would silently drop the tail of the
  // question set, which would read as "not answered" for every one of them.
  const maxTokens = Math.min(16000, 1024 + requests.length * 180);

  const response = await client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      // Read the passage the same way twice.
      //
      // This ran at the model's default sampling, and the cost was measurable:
      // the same sale, re-run twice with identical code, document and
      // transcript, differed on 7 of 17 items — including three that moved
      // between 'undetermined' and 'asked_no_answer', i.e. between "we could
      // not tell" and an allegation about how an adviser conducted a call. A
      // finding that changes when you press the button again cannot be defended
      // to the firm it is about.
      //
      // Not a guarantee. Zero temperature has never promised identical output,
      // so this narrows the variance rather than removing it — the durable fix
      // is to require two agreeing passes before an item may become actionable,
      // the same corroboration rule already used before a document format goes
      // live. Gated by model because sending it to Opus 4.7 or later is a 400.
      ...(acceptsTemperature(model) ? { temperature: 0 } : {}),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: INSTRUCTIONS },
            { type: 'text', text: body },
          ],
        },
      ],
      tools: [
        {
          name: 'submit_answers',
          description: 'Report what the customer said for each excerpt',
          input_schema: TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_answers' },
    },
    CACHE_TTL_HEADERS
  ).finalMessage();

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return structured call answers');
  }
  const output = toolUse.input as { answers?: unknown };
  if (!Array.isArray(output.answers)) {
    throw new Error(
      `Claude returned incomplete call answers (stop_reason=${response.stop_reason}, requests=${requests.length}) — likely truncated`
    );
  }

  return {
    values: sanitiseValues(output.answers, requests),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    model,
  };
}

/** Redaction placeholders, which must never be reported as a customer's answer. */
const REDACTION_TAG = /\[[A-Z][A-Z_]*(_\d+)?\]/;

/**
 * Coerce and defend the model's output.
 *
 * Two things are enforced in code rather than trusted to the prompt: an answer
 * that is really a redaction placeholder is downgraded to redacted-with-no-value,
 * and any key the model invented is discarded. A hallucinated key would attach an
 * answer to the wrong question, which is worse than no answer at all.
 */
export function sanitiseValues(
  raw: unknown[],
  requests: ValueExtractionRequest[]
): ExtractedValue[] {
  const validKeys = new Set(requests.map((r) => r.key));
  const seen = new Set<string>();
  const out: ExtractedValue[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === 'string' ? e.key : null;
    if (!key || !validKeys.has(key) || seen.has(key)) continue;
    seen.add(key);

    let value = typeof e.value === 'string' && e.value.trim() !== '' ? e.value.trim() : null;
    let redacted = e.redacted === true;
    // Defaults to false, so a model that omits the field can never promote an
    // item to a finding by accident. The claim has to be made explicitly.
    let didNotAnswer = e.customer_did_not_answer === true;

    // The value IS a placeholder — the topic was answered, the content is gone.
    if (value && REDACTION_TAG.test(value)) {
      value = null;
      redacted = true;
    }
    // Answered and did-not-answer are contradictory. An answer read from the
    // call is the stronger evidence, so the flag yields to it rather than the
    // pair being stored in a state nothing downstream can interpret.
    if (value !== null || redacted) didNotAnswer = false;

    const confidence =
      typeof e.confidence === 'number' && e.confidence >= 0 && e.confidence <= 1
        ? e.confidence
        : 0.5;

    out.push({
      key,
      value,
      redacted,
      customerDidNotAnswer: didNotAnswer,
      confidence,
      reasoning: typeof e.reasoning === 'string' ? e.reasoning : '',
    });
  }
  return out;
}
