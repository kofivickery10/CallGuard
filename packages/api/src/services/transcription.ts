import { config } from '../config.js';
import { readFile } from './storage.js';
import type { TranscriptionMode, MonoFirstSpeaker, DeepgramRegion } from '@callguard/shared';

interface TranscriptionResult {
  raw: unknown;
  text: string;
  duration_seconds: number;
  // How reliable the adviser/customer split is (0-1) — see
  // computeSpeakerAttributionConfidence below. Persisted on calls
  // (migration 040) and read by services/scoring.ts to decide whether a
  // consent_gate item can be auto-scored or must go to manual_review.
  speaker_attribution_confidence: number;
}

const DEEPGRAM_BASE_URLS: Record<DeepgramRegion, string> = {
  eu: 'https://api.eu.deepgram.com',
  us: 'https://api.deepgram.com',
};

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

/**
 * How reliable the adviser/customer speaker split is (0-1). Deterministic
 * (1.0) only when a per-tenant stereo channel is pinned — everything else is
 * a heuristic guess, most so when diarisation on a mono recording finds a
 * speaker count other than 2 (transfers, hold music, a third party on the
 * line). services/scoring.ts routes consent_gate items to manual_review
 * rather than auto-scoring them below a threshold, since a mislabelled
 * speaker on a consent checkpoint is a false-pass risk (spec §6).
 */
function computeSpeakerAttributionConfidence(
  isMultichannel: boolean,
  pinnedAdviserChannel: number | null,
  speakerCount: number
): number {
  if (isMultichannel) return pinnedAdviserChannel !== null ? 1.0 : 0.7;
  if (speakerCount === 2) return 0.6;
  return 0.3;
}

export async function transcribeCall(
  fileKey: string,
  extraKeyterms: string[] = [],
  encryptedAtRest: boolean = false,
  adviserChannel: number | null = null,
  transcriptionMode: TranscriptionMode = 'mono_diarize',
  deepgramRegion: DeepgramRegion = 'eu',
  monoFirstSpeaker: MonoFirstSpeaker = 'agent'
): Promise<TranscriptionResult> {
  if (!config.deepgram.apiKey) {
    throw new Error('DEEPGRAM_API_KEY is not set in .env - needed for transcription');
  }

  // config.deepgram.baseUrl already resolves the EU default (or a DEEPGRAM_URL
  // env override) — only override it here for a tenant explicitly on 'us'.
  const baseUrl = deepgramRegion === 'us' ? DEEPGRAM_BASE_URLS.us : config.deepgram.baseUrl;
  const { createClient } = await import('@deepgram/sdk');
  const deepgram = createClient(config.deepgram.apiKey, {
    global: { url: baseUrl },
  });

  const audioBuffer = await readFile(fileKey, encryptedAtRest);

  // Deepgram Nova-3 supports `keyterm` (up to 100 terms) to boost recognition
  const keyterms = [...DOMAIN_KEYTERMS, ...extraKeyterms].slice(0, 100);

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('Audio file is empty (0 bytes after read/decrypt)');
  }

  // CloudTalk (and most dialers CallGuard ingests from) records mono — the
  // default. Multichannel is only requested for the small minority of
  // tenants set to 'stereo_multichannel' (split-stereo recordings with the
  // adviser and customer on separate channels), where per-channel
  // attribution is exact instead of a diarisation guess.
  const useMultichannel = transcriptionMode === 'stereo_multichannel';

  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: 'nova-3',
      // Opt out of Deepgram's Model Improvement Program: call audio (containing
      // customers' financial/health disclosures) is not retained or used to
      // train their models — required for FCA/DPA compliance. Unconditional
      // floor, not a tenant-facing toggle — no UI path sets this false.
      mip_opt_out: true,
      smart_format: true,
      multichannel: useMultichannel,
      diarize: true,
      punctuate: true,
      utterances: true,
      // en-GB (matches the live path): UK date formatting (DD/MM, not MM/DD),
      // postcodes, number and spelling conventions.
      language: 'en-GB',
      profanity_filter: false,
      // Redact PII/PCI/PHI at source so customers' personal identifiers, payment
      // details and health disclosures never enter our stored transcripts, the
      // Haiku cleanup pass, or the Claude scoring pass. Deepgram replaces each
      // entity with a typed tag (e.g. [CREDIT_CARD_1], [PHONE_NUMBER_1]), so the
      // scorer can still confirm an item was collected without seeing its value.
      // Prices/durations/percentages are left intact for disclosure scoring.
      redact: ['pci', 'pii', 'phi'],
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
  // Otherwise (mono) fall back to the diarized speaker label. Guarded by
  // useMultichannel too, in case a 'mono_diarize' tenant's file is
  // unexpectedly stereo — the per-tenant setting still governs the branch.
  const isMultichannel = useMultichannel && new Set(utts.map((u) => u.channel ?? 0)).size > 1;
  const speakerCount = new Set(utts.map((u) => u.speaker ?? 0)).size;

  // Order by time so interleaved channels read as one conversation.
  const ordered = [...utts].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  // Which party is the adviser. For split-stereo the adviser is consistently on
  // one channel, so we pin it deterministically (no guessing). Precedence:
  // the per-tenant setting (adviserChannel arg) > the global ADVISER_CHANNEL env
  // fallback > "whoever speaks first" (they usually greet).
  const envChannel =
    process.env.ADVISER_CHANNEL === '0' || process.env.ADVISER_CHANNEL === '1'
      ? Number(process.env.ADVISER_CHANNEL)
      : null;
  const pinnedAdviserChannel = adviserChannel === 0 || adviserChannel === 1 ? adviserChannel : envChannel;

  // Mono has no channel to pin, so the adviser is guessed from who speaks
  // first — correct for inbound calls (the adviser greets), backwards for
  // outbound calling (the customer answers "Hello?" before the adviser
  // speaks). monoFirstSpeaker flips which role that first speaker is taken
  // to be; when it's 'customer' the adviser is the next distinct speaker.
  const firstSpeakerKey = ordered[0]?.speaker ?? 0;
  const agentKey = isMultichannel
    ? pinnedAdviserChannel ?? (ordered[0]?.channel ?? 0)
    : monoFirstSpeaker === 'customer'
      ? ordered.find((u) => (u.speaker ?? 0) !== firstSpeakerKey)?.speaker ?? firstSpeakerKey
      : firstSpeakerKey;

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
    speaker_attribution_confidence: computeSpeakerAttributionConfidence(
      isMultichannel,
      isMultichannel ? pinnedAdviserChannel : null,
      speakerCount
    ),
  };
}
