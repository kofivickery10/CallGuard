import { config } from '../config.js';
import { query } from '../db/client.js';

export async function cleanupTranscript(
  rawTranscript: string,
  organizationId?: string,
  kbContext: string = ''
): Promise<string> {
  if (!config.anthropic.apiKey) {
    return rawTranscript;
  }

  // Fetch agent names for this org so Claude can correct misheard names
  let agentNames: string[] = [];
  if (organizationId) {
    const agents = await query<{ name: string }>(
      "SELECT name FROM users WHERE organization_id = $1 AND role = 'member'",
      [organizationId]
    );
    agentNames = agents.map((a) => a.name).filter(Boolean);
  }

  const agentNamesBlock = agentNames.length > 0
    ? `\n\n**Known agent names in this organization (may appear in the call):**\n${agentNames.map((n) => `- ${n}`).join('\n')}`
    : '';

  const kbBlock = kbContext.trim()
    ? `\n\n## Business Context (Knowledge Base)\n\nUse this business-specific context to correctly identify product names, brand names, and industry jargon in the transcript.\n\n${kbContext}`
    : '';

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `You are cleaning up an auto-generated transcript of a UK telecom/broadband/utilities sales call between an Agent and a Customer. The speech-to-text was done on low quality 8kHz mono telephony audio, so there are transcription errors.

## Domain context

- UK sales calls for broadband, mobile, energy, and utility services
- Common products and brands: **KOA** (product name), **Utility Warehouse**, **Telecare**
- UK providers: BT, Sky, Virgin Media, TalkTalk, Vodafone, EE, O2, Three
- Common call elements: DPA (Data Protection Act) verification, compliance statements, cooling-off period, T&Cs, one-touch switch, cashback card, energy hotkey transfer
- Customers typically provide: name, address, postcode, bill payer status, phone number, bank/payment details${agentNamesBlock}${kbBlock}

## Common transcription errors to fix

Apply context to correct words that were clearly misheard. Examples of typical mishearings in this domain:

- "care", "coa", "koala", "cola" → likely **KOA** (when discussing broadband packages)
- "health care" / "health care association" → likely a company/product name from context
- "iLove Savings" / "I love saving" → likely the actual brand name
- "tell a care" / "tele care" → **Telecare**
- "bill pair" / "bill pay" → **bill payer**
- "one touch swish" / "one touch swift" → **one touch switch**
- "cash back" vs "cashback" → use **cashback** (one word)
- "cooling of" → **cooling off**
- "DPI" / "DPR" / "GPA" → likely **DPA** (Data Protection Act)
- "BT" may be transcribed as "B T" or "beatee" → restore as **BT**
- "EE" as "E E" or "easy" → **EE**
- UK postcodes get mangled (e.g. "S O twenty three" → **SO23**) - restore standard UK postcode format
- UK phone numbers: restore space-free 11-digit format (e.g. "0 7 4 7 3..." → **07473...**)

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

## Transcript to clean up

${rawTranscript}

## Output

Return ONLY the cleaned transcript, nothing else. No preamble, no explanation, no markdown code blocks.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return rawTranscript;
  }

  return textBlock.text.trim();
}
