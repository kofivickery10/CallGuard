import { config } from '../config.js';
import { readFile } from './storage.js';

interface TranscriptionResult {
  raw: unknown;
  text: string;
  duration_seconds: number;
}

// Domain-specific terms that Deepgram may mishear without boosting
// Covers UK telecom/broadband sales, compliance terminology, and products
const DOMAIN_KEYTERMS = [
  // Product / brand names
  'KOA',
  'Utility Warehouse',
  'CallGuard',

  // Compliance / regulatory
  'DPA',
  'Data Protection Act',
  'Ofcom',
  'GDPR',
  'Telecare',
  'cooling off',
  'cooling-off',
  'mandatory statement',
  'one touch switch',
  'cashback card',

  // Sales / product terms
  'broadband',
  'bill payer',
  'contract buyout',
  'energy hotkey',
  'exit fees',
  'price rise',
  'bundle',
  'bundling',

  // UK-specific
  'postcode',
  'sort code',
  'direct debit',

  // Telecom providers often mentioned
  'BT',
  'Sky',
  'Virgin Media',
  'TalkTalk',
  'Vodafone',
  'EE',
  'O2',
  'Three',
];

export async function transcribeCall(
  fileKey: string,
  extraKeyterms: string[] = [],
  encryptedAtRest: boolean = false
): Promise<TranscriptionResult> {
  if (!config.deepgram.apiKey) {
    throw new Error('DEEPGRAM_API_KEY is not set in .env - needed for transcription');
  }

  const { createClient } = await import('@deepgram/sdk');
  const deepgram = createClient(config.deepgram.apiKey);

  const audioBuffer = await readFile(fileKey, encryptedAtRest);

  // Deepgram Nova-3 supports `keyterm` (up to 100 terms) to boost recognition
  const keyterms = [...DOMAIN_KEYTERMS, ...extraKeyterms].slice(0, 100);

  const { result } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: 'nova-3',
      smart_format: true,
      diarize: true,
      punctuate: true,
      utterances: true,
      language: 'en',
      multichannel: false,
      profanity_filter: false,
      redact: false,
      numerals: true,
      keyterm: keyterms,
    }
  );

  if (!result) {
    throw new Error('Deepgram returned no result');
  }

  // The first speaker is typically the agent (they greet)
  const utterances = result.results?.utterances || [];
  let agentSpeakerId: number | null = null;

  if (utterances.length > 0) {
    agentSpeakerId = utterances[0].speaker ?? 0;
  }

  // Merge consecutive utterances from the same speaker into single blocks
  const merged: { speaker: string; text: string }[] = [];

  for (const u of utterances) {
    const speakerId = u.speaker ?? 0;
    const speaker = speakerId === agentSpeakerId ? 'Agent' : 'Customer';
    const last = merged[merged.length - 1];

    if (last && last.speaker === speaker) {
      last.text += ' ' + u.transcript;
    } else {
      merged.push({ speaker, text: u.transcript });
    }
  }

  const text = merged
    .map((m) => `${m.speaker}: ${m.text}`)
    .join('\n\n');

  const duration = result.metadata?.duration || 0;

  return {
    raw: result,
    text: text || result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '',
    duration_seconds: duration,
  };
}
