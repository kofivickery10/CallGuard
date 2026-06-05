import { config } from '../config.js';
import { readFile } from './storage.js';

interface TranscriptionResult {
  raw: unknown;
  text: string;
  duration_seconds: number;
}

// Domain-specific terms Deepgram may mishear without boosting.
// Tuned for UK protection & mortgage advice: identity/verification terms,
// products, FCA/ICOBS compliance vocabulary, and common insurers.
// NOTE: this is a global list; per-tenant keyterms are a separate piece of work.
const DOMAIN_KEYTERMS = [
  // Brand
  'CallGuard',
  'CallGuard AI',
  'Trust Point',

  // Identity / verification (commonly misheard, and the items advisers must capture)
  'postcode',
  'date of birth',
  'sort code',
  'account number',
  'direct debit',
  'National Insurance number',
  'first line of address',
  'surname',
  'middle name',

  // Protection products & features
  'life cover',
  'level term',
  'decreasing term',
  'whole of life',
  'critical illness',
  'critical illness cover',
  'income protection',
  'family income benefit',
  'waiver of premium',
  'total permanent disability',
  'terminal illness',
  'sum assured',
  'survival period',
  'deferred period',
  'own occupation',
  'any occupation',
  'guaranteed premiums',
  'reviewable premiums',
  'indexation',
  'in trust',
  'beneficiaries',
  'underwriting',

  // Mortgage
  'mortgage',
  'remortgage',
  'repayment',
  'interest only',
  'fixed rate',
  'loan to value',
  'decision in principle',
  'affordability',
  'stamp duty',

  // FCA / ICOBS compliance vocabulary
  'FCA',
  'ICOBS',
  'COBS',
  'MCOB',
  'demands and needs',
  'fact find',
  'attitude to risk',
  'capacity for loss',
  'vulnerability',
  'vulnerable customer',
  'Consumer Duty',
  'fair value',
  'suitability',
  'disclosure',
  'non-disclosure',
  'cooling off',
  'cooling-off',
  'CIDRA',
  'IPID',
  'GDPR',

  // Common UK protection insurers / providers
  'Aviva',
  'Legal and General',
  'Royal London',
  'Vitality',
  'Zurich',
  'AIG',
  'LV',
  'Guardian',
  'Scottish Widows',
  'Aegon',
];

export async function transcribeCall(
  fileKey: string,
  extraKeyterms: string[] = [],
  encryptedAtRest: boolean = false,
  adviserChannel: number | null = null
): Promise<TranscriptionResult> {
  if (!config.deepgram.apiKey) {
    throw new Error('DEEPGRAM_API_KEY is not set in .env - needed for transcription');
  }

  const { createClient } = await import('@deepgram/sdk');
  const deepgram = createClient(config.deepgram.apiKey);

  const audioBuffer = await readFile(fileKey, encryptedAtRest);

  // Deepgram Nova-3 supports `keyterm` (up to 100 terms) to boost recognition
  const keyterms = [...DOMAIN_KEYTERMS, ...extraKeyterms].slice(0, 100);

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('Audio file is empty (0 bytes after read/decrypt)');
  }

  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: 'nova-3',
      smart_format: true,
      // Transcribe each channel separately. Split-stereo call recordings put the
      // adviser and customer on separate channels, so per-channel attribution is
      // exact (no guessing) and each voice is transcribed without the other
      // bleeding over it (sharper postcodes / names). diarize stays on as the
      // fall-back for mono recordings, which come back as a single channel.
      multichannel: true,
      diarize: true,
      punctuate: true,
      utterances: true,
      // en-GB (matches the live path): UK date formatting (DD/MM, not MM/DD),
      // postcodes, number and spelling conventions.
      language: 'en-GB',
      profanity_filter: false,
      redact: false,
      numerals: true,
      keyterm: keyterms,
    }
  );

  if (error) {
    const detail = (error as { message?: string }).message || JSON.stringify(error);
    throw new Error(`Deepgram error: ${detail} (audio bytes=${audioBuffer.length})`);
  }

  if (!result) {
    throw new Error(`Deepgram returned no result and no error (audio bytes=${audioBuffer.length})`);
  }

  const utterances = result.results?.utterances || [];
  type Utt = { transcript: string; speaker?: number; channel?: number; start?: number };
  const utts = utterances as unknown as Utt[];

  // Split-stereo recordings come back with utterances tagged by channel. When
  // more than one channel is present, attribute by channel (exact, no guessing).
  // Otherwise (mono) fall back to the diarized speaker label.
  const isMultichannel = new Set(utts.map((u) => u.channel ?? 0)).size > 1;

  // Order by time so interleaved channels read as one conversation.
  const ordered = [...utts].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  // Which party is the adviser. For split-stereo the adviser is consistently on
  // one channel, so we pin it deterministically (no guessing). Precedence:
  // the per-tenant setting (adviserChannel arg) > the global ADVISER_CHANNEL env
  // fallback > "whoever speaks first" (they usually greet). Mono recordings
  // always fall back to the first-speaker guess via diarisation.
  const envChannel =
    process.env.ADVISER_CHANNEL === '0' || process.env.ADVISER_CHANNEL === '1'
      ? Number(process.env.ADVISER_CHANNEL)
      : null;
  const pinnedAdviserChannel = adviserChannel === 0 || adviserChannel === 1 ? adviserChannel : envChannel;
  const agentKey = isMultichannel
    ? pinnedAdviserChannel ?? (ordered[0]?.channel ?? 0)
    : ordered[0]?.speaker ?? 0;

  // Merge consecutive utterances from the same party into single blocks
  const merged: { speaker: string; text: string }[] = [];

  for (const u of ordered) {
    const key = isMultichannel ? u.channel ?? 0 : u.speaker ?? 0;
    const speaker = key === agentKey ? 'Agent' : 'Customer';
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
