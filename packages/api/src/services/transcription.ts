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

// Industry-neutral terms Deepgram may mishear without boosting, applicable to
// any tenant's calls: brand, identity/verification vocabulary, and compliance
// terms that apply across FCA-regulated sectors. Domain- and tenant-specific
// vocabulary (products, sector regulations, provider names, the org's own
// name) is per-tenant config — organizations.keyterms (migration 058), passed
// in via extraKeyterms and boosted AHEAD of this list so the tenant's own
// vocabulary always wins the 100-term cap.
const GENERIC_KEYTERMS = [
  // Brand
  'CallGuard',
  'CallGuard AI',

  // Identity / verification (commonly misheard, and the items agents must capture)
  'postcode',
  'date of birth',
  'sort code',
  'account number',
  'direct debit',
  'National Insurance number',
  'first line of address',
  'surname',
  'middle name',

  // Cross-sector compliance vocabulary
  'FCA',
  // The scripted FCA regulatory intro is rattled off fast on 8kHz audio and gets
  // mangled without boosting — "authorised and regulated" was heard as "all fine
  // and regulated", failing the mandatory-disclosure scorecard items. Boost the
  // exact phrasing so Nova-3 recognises it.
  'authorised and regulated',
  'authorised and regulated by the FCA',
  'fully advised',
  'whole of market',
  'Consumer Duty',
  'vulnerability',
  'vulnerable customer',
  'fair value',
  'suitability',
  'disclosure',
  'non-disclosure',
  'cooling off',
  'cooling-off',
  'GDPR',
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
  monoFirstSpeaker: MonoFirstSpeaker = 'agent',
  // organizations.pii_redaction_exempt (migration 065) — an explicit,
  // superadmin-set, DPIA-backed exception for a tenant whose Data Capture
  // reconciliation needs the customer's actual health/identity answers, not
  // just confirmation they were given. Defaults to false (redact everything).
  piiRedactionExempt: boolean = false
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

  // Deepgram Nova-3 supports `keyterm` (up to 100 terms) to boost recognition.
  // Tenant terms take priority, but the generic core (identity/verification +
  // cross-sector compliance vocabulary) is always guaranteed a slot: cap the
  // tenant list to what remains after the core. Without the reservation, 80
  // org keyterms + the org name + a long adviser roster could evict the entire
  // core (postcode, date of birth, sort code…) before Deepgram sees it.
  // extraKeyterms arrives priority-ordered (org name, org keyterms, then agent
  // names — see jobs/processors/transcribe.ts), so trailing agent names are
  // what gets trimmed first.
  const tenantBudget = 100 - GENERIC_KEYTERMS.length;
  const tenantTerms = [...new Set(extraKeyterms)].slice(0, tenantBudget);
  const keyterms = [...new Set([...tenantTerms, ...GENERIC_KEYTERMS])].slice(0, 100);

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
      // Redact customers' personal identifiers, payment details and health
      // disclosures at source so they never enter our stored transcripts, the
      // Haiku cleanup pass, or the Claude scoring pass. Deepgram replaces each
      // entity with a typed tag (e.g. [CREDIT_CARD_1], [PHONE_NUMBER_1]), so the
      // scorer can still confirm an item was collected without seeing its value.
      //
      // We do NOT use Deepgram's broad `pii` group: it is aggressive named-entity
      // redaction that also tags organisation and regulator names (turning "FCA"
      // and the firm's own name into [ORGANIZATION_n]) and prices/durations/dates
      // ([MONEY]/[DURATION]/[DATE]) — none of which are personal data, and all of
      // which the scorer must actually SEE to verify disclosure items (e.g. "state
      // you are authorised and regulated by the FCA", "disclose the £X price / the
      // 14-day cooling-off period"). Redacting them silently broke those items.
      //
      // Instead we redact:
      //  - `pci` (group): full payment-card coverage — no organisation entity.
      //  - `phi` (group): full health coverage (conditions, drugs, doses, medical
      //    facility names) — kept as a group because the health entity set is the
      //    dangerous one to under-enumerate (special-category data), and `phi`
      //    does not pull in the generic firm/regulator organisation entity.
      //  - `numbers` (group): sensitive number sequences — bank sort codes and
      //    account numbers, phone numbers, etc. This group is REQUIRED: the
      //    per-entity `account_number`/`numerical_pii` tokens are unreliable for
      //    numbers spoken aloud (a sort code read as "one one, oh six" slips past
      //    them), so without `numbers` real bank details leak through. Verified
      //    against a live call with scripts/verify-redaction.ts.
      //  - an explicit list of the genuine identity PII the `pii` group used to
      //    provide and we still want gone (names, DOB, contact details, address).
      // This keeps every real identifier redacted while letting organisation and
      // regulator names (FCA, the firm) through to the scorer.
      //
      // `pci` and `numbers` are an unconditional floor and are never affected by
      // piiRedactionExempt: card and bank details have no legitimate reason to
      // exist unredacted in this system, DPIA or not. The rest of this list
      // (health + identity) is dropped in full for an org with a signed-off
      // redaction exemption (organizations.pii_redaction_exempt, migration
      // 065) — see there for why this can only be an org-wide, not per-question,
      // exception.
      redact: piiRedactionExempt
        ? ['pci', 'numbers']
        : [
            'pci',
            'phi',
            'numbers',
            'name', 'name_given', 'name_family',
            'dob',
            'email_address',
            'location_address', 'location_city', 'location_state', 'location_zip', 'location_country',
          ],
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
