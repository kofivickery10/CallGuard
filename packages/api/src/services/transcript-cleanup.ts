import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import { recordUsage } from './usage.js';

export async function cleanupTranscript(
  rawTranscript: string,
  organizationId?: string,
  kbContext: string = '',
  callId?: string
): Promise<string> {
  if (!config.anthropic.apiKey) {
    return rawTranscript;
  }

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

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  // Cleanup is an enhancement over the raw transcript, not a required step —
  // if it errors (or truncates, see stop_reason check below), scoring against
  // the original transcript is far better than either failing the whole call
  // or silently scoring a cut-off "cleaned" transcript (which reads as if the
  // call simply ended early — missed end-of-call disclosures become false
  // breaches).
  let response;
  try {
    response = await client.messages.create({
      model: CLAUDE_MODELS.HAIKU,
      max_tokens: 8192,
      messages: [
      {
        role: 'user',
        content: `You are cleaning up an auto-generated transcript of ${callDescriptor} between an Agent/Adviser and a Customer. The speech-to-text ran on low-quality 8kHz mono telephony audio, so there are transcription errors.

## Domain context

Use the business context below to correctly identify product names, brand names, and industry jargon, and to correct words that were clearly misheard in this domain. Customers typically provide details such as name, address, postcode, phone number and bank/payment details.${agentNamesBlock}${kbBlock}

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
3. **Keep every speaker label exactly as-is** - do not change "Agent:" or "Customer:" labels, do not reorder or remove any turns
4. **Do not add, remove, or fabricate any content** - only fix what's clearly wrong
5. **Keep the exact same format** - each turn starts with "Agent: " or "Customer: " followed by their text, separated by blank lines
6. **Preserve UK English** spelling (e.g. "organise", "colour", "centre")
7. **Format numbers properly** - postcodes uppercase with correct spacing, phone numbers without spaces, prices with pound signs (£19.99)
8. **If genuinely unclear, leave it alone** - don't guess wildly; only correct when context makes the correct word obvious
9. **Preserve redaction tags exactly** - sensitive details (names, addresses, phone numbers, card/bank details, dates of birth, health information) have been redacted to typed tags like [PII_NAME_1], [PHONE_NUMBER_1] or [CREDIT_CARD_1]. Keep these tags verbatim - never expand, "restore", guess at, merge or remove them. They mark where personal data was spoken.

## Transcript to clean up

${rawTranscript}

## Output

Return ONLY the cleaned transcript, nothing else. No preamble, no explanation, no markdown code blocks.`,
      },
      ],
    });
  } catch (err) {
    console.error(`[TranscriptCleanup] Claude request failed for call ${callId ?? 'unknown'}, using raw transcript:`, (err as Error).message);
    return rawTranscript;
  }

  await recordUsage({
    organizationId: organizationId ?? null,
    callId: callId ?? null,
    provider: 'anthropic',
    operation: 'cleanup',
    modelId: CLAUDE_MODELS.HAIKU,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  // A truncated "cleaned" transcript (hit the output token cap) is worse than
  // the untruncated raw one — it reads as if the call simply ended early, and
  // scoring against it can miss end-of-call disclosures entirely.
  if (response.stop_reason === 'max_tokens') {
    console.error(`[TranscriptCleanup] Cleanup output truncated at max_tokens for call ${callId ?? 'unknown'}, using raw transcript`);
    return rawTranscript;
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return rawTranscript;
  }

  return textBlock.text.trim();
}
