import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import { recordUsage } from './usage.js';
import { CACHE_1H, CACHE_TTL_HEADERS } from './scoring.js';

// The model's content-based verdict on the Agent/Customer labels:
// - 'swapped'     — clear evidence the labels were inverted throughout; corrected.
// - 'confirmed'   — clear evidence the labels were already correct.
// - 'unclear'     — no strong evidence either way; labels left as given.
// - 'not_checked' — speakerAttributionConfidence was 1.0 (exact channel pin),
//                   so the speaker check was skipped entirely.
// Only ever 'swapped'/'confirmed'/'unclear' when the check runs
// (speakerAttributionConfidence < 1 — see needsSpeakerCheck below).
export type SpeakerVerdict = 'swapped' | 'confirmed' | 'unclear' | 'not_checked';

export interface CleanupResult {
  text: string;
  // Retained for callers that only care whether labels were flipped.
  // Equivalent to speakerVerdict === 'swapped'.
  speakerLabelsSwapped: boolean;
  speakerVerdict: SpeakerVerdict;
}

// A swap or a positive content-confirmation both mean the labels are now
// content-verified — a strong enough signal to lift the stored attribution
// confidence above the consent-gate floor (checkpoint-classification.ts) so a
// genuinely-correct mono transcript no longer routes every consent gate to
// manual review. 'unclear' (no strong evidence either way) and 'not_checked'
// leave the base confidence untouched, preserving the false-pass protection
// for calls we genuinely can't attribute.
export function resolveSpeakerConfidence(
  baseConfidence: number,
  verdict: SpeakerVerdict
): number {
  return verdict === 'swapped' || verdict === 'confirmed'
    ? Math.max(baseConfidence, 0.75)
    : baseConfidence;
}

// Mechanically flip every Agent:/Customer: turn label. Used when the model's
// one-time swap decision is known but its cleaned output can't be trusted
// (truncated at max_tokens) — a raw-but-correctly-attributed transcript beats
// a cleaned-but-inverted one for scoring.
function swapSpeakerLabels(transcript: string): string {
  return transcript.replace(/^(Agent|Customer):/gm, (_m, who: string) =>
    who === 'Agent' ? 'Customer:' : 'Agent:'
  );
}

// Read the leading `SPEAKER_LABELS: <verdict>` line the model is asked to emit.
// Returns null when the line is absent or unrecognised. 'unchanged' is accepted
// as a backward-compatible alias for 'unclear' (older prompt / stale model).
function parseSpeakerVerdict(
  text: string
): 'swapped' | 'confirmed' | 'unclear' | null {
  const m = text
    .trimStart()
    .match(/^SPEAKER_LABELS:\s*(swapped|confirmed|unclear|unchanged)/i);
  if (!m) return null;
  const v = m[1]!.toLowerCase();
  return v === 'unchanged' ? 'unclear' : (v as 'swapped' | 'confirmed' | 'unclear');
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
    return { text: rawTranscript, speakerLabelsSwapped: false, speakerVerdict: 'not_checked' };
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
    ? `\n\n## Speaker label verification\n\nThe Agent/Customer labels below come from an automated guess (based on who speaks first in a mono recording) and can be swapped throughout — check them against conversational content before cleaning up:\n\n- The **Agent** usually introduces themselves and their company by name, asks fact-find/discovery questions, and explains products, pricing or compliance wording.\n- The **Customer** usually answers personal questions, reacts to what's proposed, and is the one being sold to or advised.\n\nDecide one of three verdicts from the conversational content:

- **swapped** — strong, unambiguous evidence the labels are inverted throughout (e.g. the turns labelled "Customer" are clearly the one introducing the company and asking the fact-find questions). Swap every "Agent:"/"Customer:" label in your output — one full swap, decided once; never reorder turns or swap only some of them.
- **confirmed** — clear, positive evidence the labels are already correct: the "Agent" turns really are the one who introduces themselves/the company, asks fact-find questions and explains products/compliance, and the "Customer" turns really are the one answering personal questions and reacting. Leave the labels exactly as given.
- **unclear** — the content doesn't give strong evidence either way (too short, ambiguous, or heavily redacted). Leave the labels exactly as given. Do NOT report "confirmed" unless you actually see the evidence — a guess is "unclear".`
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
  ? 'Start your response with exactly one line: `SPEAKER_LABELS: confirmed`, `SPEAKER_LABELS: swapped`, or `SPEAKER_LABELS: unclear` (your decision from the Speaker label verification section above), then a blank line, then the cleaned transcript. No other preamble, explanation, or markdown code blocks.'
  : 'Return ONLY the cleaned transcript, nothing else. No preamble, no explanation, no markdown code blocks.'}`;

  let response;
  try {
    // Streamed with a 64k output ceiling (Haiku 4.5's max): the cleaned
    // transcript is roughly as long as the input, and long fact-find calls
    // (45+ min ≈ 13k+ tokens) blew straight past the old 8192 cap — every
    // such call silently lost both the cleanup and the speaker-label repair.
    // Streaming is required above ~16k max_tokens to avoid SDK HTTP timeouts.
    const stream = client.messages.stream({
      model: CLAUDE_MODELS.HAIKU,
      max_tokens: 64000,
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
    response = await stream.finalMessage();
  } catch (err) {
    console.error(`[TranscriptCleanup] Claude request failed for call ${callId ?? 'unknown'}, using raw transcript:`, (err as Error).message);
    return { text: rawTranscript, speakerLabelsSwapped: false, speakerVerdict: needsSpeakerCheck ? 'unclear' : 'not_checked' };
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
  // scoring against it can miss end-of-call disclosures entirely. But the
  // SPEAKER_LABELS verdict is the FIRST line of the output, so it survives any
  // truncation — salvage it and apply the swap mechanically to the raw
  // transcript rather than discarding the one decision that matters most.
  if (response.stop_reason === 'max_tokens') {
    const partial = response.content.find((b) => b.type === 'text');
    const verdict =
      needsSpeakerCheck && partial?.type === 'text'
        ? parseSpeakerVerdict(partial.text)
        : null;
    if (verdict === 'swapped') {
      console.error(`[TranscriptCleanup] Cleanup output truncated at max_tokens for call ${callId ?? 'unknown'}, but SPEAKER_LABELS verdict was 'swapped' — using raw transcript with labels swapped`);
      return { text: swapSpeakerLabels(rawTranscript), speakerLabelsSwapped: true, speakerVerdict: 'swapped' };
    }
    // The cleaned body is unusable, but the verdict line survives truncation
    // (it's the first line) — carry a 'confirmed' through so a positively-
    // verified call still clears the consent-gate floor even though we fall
    // back to the raw transcript for scoring.
    console.error(`[TranscriptCleanup] Cleanup output truncated at max_tokens for call ${callId ?? 'unknown'}, using raw transcript (speaker verdict: ${verdict ?? 'none'})`);
    return {
      text: rawTranscript,
      speakerLabelsSwapped: false,
      speakerVerdict: verdict ?? (needsSpeakerCheck ? 'unclear' : 'not_checked'),
    };
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { text: rawTranscript, speakerLabelsSwapped: false, speakerVerdict: needsSpeakerCheck ? 'unclear' : 'not_checked' };
  }

  const output = textBlock.text.trim();
  if (!needsSpeakerCheck) {
    return { text: output, speakerLabelsSwapped: false, speakerVerdict: 'not_checked' };
  }

  const match = output.match(/^SPEAKER_LABELS:\s*(unchanged|swapped|confirmed|unclear)\s*\n+([\s\S]*)$/i);
  if (!match) {
    // Model didn't follow the prefix format — safer to use its output as-is
    // (still cleaned) and treat the split as unverified (no confidence lift)
    // than to guess at a swap/confirmation that wasn't clearly signalled.
    console.warn(`[TranscriptCleanup] Call ${callId ?? 'unknown'}: missing SPEAKER_LABELS prefix, treating as unclear`);
    return { text: output, speakerLabelsSwapped: false, speakerVerdict: 'unclear' };
  }
  const rawVerdict = match[1]!.toLowerCase();
  const speakerVerdict: SpeakerVerdict =
    rawVerdict === 'swapped' ? 'swapped'
    : rawVerdict === 'confirmed' ? 'confirmed'
    : 'unclear'; // 'unchanged' (legacy alias) and 'unclear' both map here
  return { text: match[2]!.trim(), speakerLabelsSwapped: speakerVerdict === 'swapped', speakerVerdict };
}
