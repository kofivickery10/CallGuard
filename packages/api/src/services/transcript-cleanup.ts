import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import { recordUsage } from './usage.js';
import { CACHE_1H, CACHE_TTL_HEADERS } from './scoring.js';

export interface CleanupResult {
  text: string;
  // true only when the model found clear content evidence (self-introduction,
  // fact-find questions, product/compliance explanation) that the Agent/
  // Customer labels were swapped throughout, and corrected them. Only ever
  // set when speakerAttributionConfidence < 1 — see needsSpeakerCheck below.
  speakerLabelsSwapped: boolean;
}

export async function cleanupTranscript(
  rawTranscript: string,
  organizationId?: string,
  kbContext: string = '',
  callId?: string,
  // 1.0 (deterministic split-stereo channel pin) skips the speaker-label
  // check entirely — that assignment is already exact, so there's nothing
  // for the model to second-guess. Below 1.0 (mono-diarisation guess) the
  // model verifies the labels against conversational content as a safety
  // net independent of the tenant/call-direction heuristic in transcription.ts.
  speakerAttributionConfidence: number = 1.0
): Promise<CleanupResult> {
  if (!config.anthropic.apiKey) {
    return { text: rawTranscript, speakerLabelsSwapped: false };
  }

  const needsSpeakerCheck = speakerAttributionConfidence < 1;

  // Fetch agent names for this org so Claude can correct misheard names
  let agentNames: string[] = [];
  if (organizationId) {
    const agents = await query<{ name: string }>(
      "SELECT name FROM users WHERE organization_id = $1 AND role = 'adviser'",
      [organizationId]
    );
    agentNames = agents.map((a) => a.name).filter(Boolean);
  }

  // The org's industry frames the cleanup in the right vocabulary (e.g. protection
  // insurance vs broadband) instead of a hardcoded telecom assumption. The
  // knowledge base supplies the firm-specific product/brand terms.
  let industry: string | null = null;
  if (organizationId) {
    const orgRow = await queryOne<{ industry: string | null }>(
      'SELECT industry FROM organizations WHERE id = $1',
      [organizationId]
    );
    industry = orgRow?.industry ?? null;
  }
  const domain = industry?.trim();
  const callDescriptor = domain
    ? `a UK ${domain} call`
    : 'a UK sales or customer-service call';

  const agentNamesBlock = agentNames.length > 0
    ? `\n\n**Known agent names in this organization (may appear in the call):**\n${agentNames.map((n) => `- ${n}`).join('\n')}`
    : '';

  const kbBlock = kbContext.trim()
    ? `\n\n## Business Context (Knowledge Base)\n\nUse this business-specific context to correctly identify product names, brand names, and industry jargon in the transcript.\n\n${kbContext}`
    : '';

  const speakerCheckBlock = needsSpeakerCheck
    ? `\n\n## Speaker label verification\n\nThe Agent/Customer labels below come from an automated guess (based on who speaks first in a mono recording) and can be swapped throughout — check them against conversational content before cleaning up:\n\n- The **Agent** usually introduces themselves and their company by name, asks fact-find/discovery questions, and explains products, pricing or compliance wording.\n- The **Customer** usually answers personal questions, reacts to what's proposed, and is the one being sold to or advised.\n\nIf the labels are clearly swapped throughout — strong, unambiguous evidence, not a hunch — swap every "Agent:"/"Customer:" label in your output (one full swap, decided once; never reorder turns or swap only some of them). If it's not clearly wrong, leave the labels exactly as given.`
    : '';

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  // Cleanup is an enhancement over the raw transcript, not a required step —
  // if it errors (or truncates, see stop_reason check below), scoring against
  // the original transcript is far better than either failing the whole call
  // or silently scoring a cut-off "cleaned" transcript (which reads as if the
  // call simply ended early — missed end-of-call disclosures become false
  // breaches).
  // Everything except the transcript is stable for a given org (instructions,
  // agent names, KB, the speaker-check block) — split it into a cacheable
  // prefix so back-to-back calls from the same tenant bill it at the cache-
  // read rate instead of full price. 1-hour TTL: calls arrive minutes-to-an-
  // hour apart in production, which the 5-minute TTL would always miss.
  // (Haiku's minimum cacheable prefix is 4096 tokens — orgs with a small/empty
  // KB fall below it and silently skip caching, which is harmless.)
  const cachedPrefix = `You are cleaning up an auto-generated transcript of ${callDescriptor} between an Agent/Adviser and a Customer. The speech-to-text ran on low-quality 8kHz mono telephony audio, so there are transcription errors.

## Domain context

Use the business context below to correctly identify product names, brand names, and industry jargon, and to correct words that were clearly misheard in this domain. Customers typically provide details such as name, address, postcode, phone number and bank/payment details.${agentNamesBlock}${kbBlock}${speakerCheckBlock}

## Common transcription errors to fix (UK telephony)

- UK postcodes get mangled (e.g. "S O twenty three" → **SO23**) — restore standard UK postcode format
- UK phone numbers: restore space-free 11-digit format (e.g. "0 7 4 7 3..." → **07473...**)
- Spelled-out acronyms/brands (e.g. "B T" → **BT**, "E E" → **EE**, "D P A" → **DPA**) — restore as written
- "cooling of" → **cooling off**; "cash back" → **cashback**; prices with pound signs (**£19.99**)
- Misheard product/brand names → correct them using the Business Context above

## Your task

Fix the transcript while following these rules STRICTLY:

1. **Fix mishearings** using domain context and the examples above
2. **Fix grammar and punctuation** - clean up sentence structure without changing meaning
3. **Speaker labels**: ${needsSpeakerCheck ? 'apply the one-time full-swap decision from the Speaker label verification section above, consistently across every turn' : 'keep every speaker label exactly as-is - do not change "Agent:" or "Customer:" labels'} - do not reorder or remove any turns
4. **Do not add, remove, or fabricate any content** - only fix what's clearly wrong
5. **Keep the exact same format** - each turn starts with "Agent: " or "Customer: " followed by their text, separated by blank lines
6. **Preserve UK English** spelling (e.g. "organise", "colour", "centre")
7. **Format numbers properly** - postcodes uppercase with correct spacing, phone numbers without spaces, prices with pound signs (£19.99)
8. **If genuinely unclear, leave it alone** - don't guess wildly; only correct when context makes the correct word obvious
9. **Preserve redaction tags exactly** - sensitive details (names, addresses, phone numbers, card/bank details, dates of birth, health information) have been redacted to typed tags like [PII_NAME_1], [PHONE_NUMBER_1] or [CREDIT_CARD_1]. Keep these tags verbatim - never expand, "restore", guess at, merge or remove them. They mark where personal data was spoken.

## Output

${needsSpeakerCheck
  ? 'Start your response with exactly one line: `SPEAKER_LABELS: unchanged` or `SPEAKER_LABELS: swapped` (your decision from the Speaker label verification section above), then a blank line, then the cleaned transcript. No other preamble, explanation, or markdown code blocks.'
  : 'Return ONLY the cleaned transcript, nothing else. No preamble, no explanation, no markdown code blocks.'}`;

  let response;
  try {
    response = await client.messages.create({
      model: CLAUDE_MODELS.HAIKU,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: cachedPrefix, cache_control: CACHE_1H },
            { type: 'text', text: `## Transcript to clean up\n\n${rawTranscript}` },
          ],
        },
      ],
    }, CACHE_TTL_HEADERS);
  } catch (err) {
    console.error(`[TranscriptCleanup] Claude request failed for call ${callId ?? 'unknown'}, using raw transcript:`, (err as Error).message);
    return { text: rawTranscript, speakerLabelsSwapped: false };
  }

  await recordUsage({
    organizationId: organizationId ?? null,
    callId: callId ?? null,
    provider: 'anthropic',
    operation: 'cleanup',
    modelId: CLAUDE_MODELS.HAIKU,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
  });

  // A truncated "cleaned" transcript (hit the output token cap) is worse than
  // the untruncated raw one — it reads as if the call simply ended early, and
  // scoring against it can miss end-of-call disclosures entirely.
  if (response.stop_reason === 'max_tokens') {
    console.error(`[TranscriptCleanup] Cleanup output truncated at max_tokens for call ${callId ?? 'unknown'}, using raw transcript`);
    return { text: rawTranscript, speakerLabelsSwapped: false };
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { text: rawTranscript, speakerLabelsSwapped: false };
  }

  const output = textBlock.text.trim();
  if (!needsSpeakerCheck) {
    return { text: output, speakerLabelsSwapped: false };
  }

  const match = output.match(/^SPEAKER_LABELS:\s*(unchanged|swapped)\s*\n+([\s\S]*)$/i);
  if (!match) {
    // Model didn't follow the prefix format — safer to use its output as-is
    // (still cleaned) than to guess at a swap that wasn't clearly signalled.
    console.warn(`[TranscriptCleanup] Call ${callId ?? 'unknown'}: missing SPEAKER_LABELS prefix, treating as unchanged`);
    return { text: output, speakerLabelsSwapped: false };
  }
  const speakerLabelsSwapped = match[1]!.toLowerCase() === 'swapped';
  return { text: match[2]!.trim(), speakerLabelsSwapped };
}
