import { config } from '../config.js';
import { queryOne } from '../db/client.js';
import { readFile } from './storage.js';
import { identifyAdviserCluster, type ClusterSpeech } from './speaker-integrity.js';
import { redactBankDetails, redactBankDetailsInRaw } from './digit-redaction.js';
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
  // Whether the adviser's cluster was established from what was actually said,
  // rather than from a positional guess. Callers need this to decide whether a
  // later "labels look right" verdict is independent corroboration or just the
  // same weak signal a second time — see resolveSpeakerConfidence.
  adviser_identified_by_content: boolean;
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
  speakerCount: number,
  // True when the adviser's cluster was identified from what it actually said
  // across the call, rather than from who happened to speak first.
  adviserIdentifiedByContent: boolean
): number {
  if (isMultichannel) return pinnedAdviserChannel !== null ? 1.0 : 0.7;
  // Content identification is a materially stronger basis than the positional
  // guess: it aggregates adviser-specific behaviour over the whole call instead
  // of betting everything on the first utterance. High enough to clear the
  // consent-gate floor on its own, so a correctly-attributed mono call no longer
  // depends on the cleanup model blessing it.
  //
  // Deliberately short of the stereo pin's 1.0: this fixes which CLUSTER is the
  // adviser, but Deepgram can still misassign individual utterances between
  // clusters, which is what assessSpeakerIntegrity checks for afterwards.
  if (adviserIdentifiedByContent) return 0.8;
  // Content identification ABSTAINED, so which cluster is the adviser rests
  // entirely on the positional guess — and the comment above is not rhetorical:
  // measured over three real calls that rule got 1 of 3 right.
  //
  // This used to return 0.6, above CONSENT_SPEAKER_CONFIDENCE_FLOOR (0.5), so a
  // coin-flip attribution still had its consent gates auto-scored. Measured on
  // Trust Point: content abstains on 18 of 29 transcribed calls, 15 of which
  // were sitting at or above the floor. One (97701e4c) had its confidence
  // LIFTED to 0.75 by the cleanup pass while its adviser markers got worse —
  // the cleanup model reports the labels are self-consistent, which they are;
  // they are consistently attached to the wrong cluster.
  //
  // 0.45 keeps the ordering (a two-speaker guess is better evidenced than a
  // three-way one) while sitting below the floor, so a call we cannot actually
  // attribute sends its consent gates to a person instead of guessing. That is
  // the whole purpose of the floor.
  if (speakerCount === 2) return 0.45;
  return 0.3;
}

/**
 * Every redaction category CallGuard asks Deepgram for. See the long comment at
 * the `redact:` call site for why this is an explicit list rather than the broad
 * `pii` group.
 */
export const REDACTION_CATEGORIES = [
  'pci',
  'phi',
  'numbers',
  'name', 'name_given', 'name_family',
  'dob',
  'email_address',
  'location_address', 'location_city', 'location_state', 'location_zip', 'location_country',
] as const;

/**
 * Categories no tenant may ever keep in the clear, whatever their config says.
 *
 * `pci` only. Card and bank details have no legitimate reason to exist
 * unredacted in this system, DPIA or not, and keeping them out is what keeps the
 * platform outside PCI DSS scope. Enforced here AND by a CHECK constraint in
 * migration 079, so neither a bad config write nor a bug in this file alone can
 * expose payment data.
 *
 * Note that `numbers` is deliberately NOT here. It used to be the category
 * actually catching bank details spoken aloud, because the per-entity tokens miss
 * them (see the `redact:` comment) — so permitting it was unsafe until something
 * else did that job. services/digit-redaction.ts now does, anchored on the
 * spoken phrase rather than on the shape of the number, which is what lets the
 * short numeric answers reconciliation needs survive. It runs unconditionally on
 * every transcript before storage, so `numbers` is permittable with that in
 * place and not before.
 */
const NEVER_UNREDACTED: ReadonlySet<string> = new Set(['pci']);

/**
 * Resolve a tenant's permitted-in-the-clear list into the redact list actually
 * sent to Deepgram. Anything not explicitly permitted stays redacted, so the
 * failure mode of an unknown or malformed category is "redact it", not "expose
 * it".
 */
export function resolveRedactCategories(unredactedCategories: string[] = []): string[] {
  const permitted = new Set(
    unredactedCategories.filter((c) => !NEVER_UNREDACTED.has(c))
  );
  return REDACTION_CATEGORIES.filter((c) => !permitted.has(c));
}

/**
 * The one place that decides a tenant's redaction policy for what Deepgram is
 * asked to redact. Loads organizations.pii_unredacted_categories, fails
 * closed (redacts everything) if that load fails, and resolves the result
 * into the actual Deepgram category list via resolveRedactCategories above.
 *
 * Both transcription paths call this instead of querying `organizations`
 * themselves: the batch path (jobs/processors/transcribe.ts, which then
 * passes the result into transcribeCall below) and the live path
 * (stream-worker.ts, which configures Deepgram's *streaming* redaction
 * directly and so never goes through transcribeCall at all). This drifted
 * twice before — each path independently re-implementing "fetch the org row,
 * decide what happens if that fails" — because there was nowhere that owned
 * both halves of the decision. There is now exactly one.
 *
 * An unreadable config is not grounds to loosen redaction: the catch here
 * redacts everything, the same as an empty permitted-categories list, not
 * nothing.
 */
export async function resolveTenantRedactCategories(organizationId: string): Promise<string[]> {
  try {
    const orgRow = await queryOne<{ pii_unredacted_categories: string[] | null }>(
      'SELECT pii_unredacted_categories FROM organizations WHERE id = $1',
      [organizationId]
    );
    return resolveRedactCategories(orgRow?.pii_unredacted_categories ?? []);
  } catch (err) {
    console.error(
      `[Transcription] Failed to load redaction settings for org ${organizationId}, redacting everything:`,
      (err as Error).message
    );
    return resolveRedactCategories([]);
  }
}

/**
 * The other half of tenant redaction: CallGuard's in-house bank-detail pass
 * (services/digit-redaction.ts — see the long comment there for why it
 * exists alongside Deepgram's own redaction), applied to a transcript and,
 * when supplied, its raw Deepgram payload together.
 *
 * This exists so a caller reaches for ONE function rather than remembering to
 * call redactBankDetails AND redactBankDetailsInRaw itself — forgetting the
 * raw-payload half was exactly the kind of drift Fix 1 is closing off. Both
 * transcription paths call this at every point new transcript text becomes
 * available: once, over the whole assembled transcript, in transcribeCall
 * below; per finalised segment AND again over the joined whole at session end
 * in stream-worker.ts (redacting text that's already clean a second time is
 * inert, so the repeated calls there are safe, not wasteful).
 *
 * One function, not one call SHAPE: `raw` is optional rather than required,
 * because the live path has no raw Deepgram payload to redact at all (it
 * only ever has text) — passing `undefined` there is honest about that,
 * rather than inventing a payload just to satisfy a required parameter.
 */
export function redactForTenant(
  text: string,
  raw?: unknown
): { text: string; textRedactions: number; raw: unknown; rawRedactions: number } {
  const textResult = redactBankDetails(text);
  const rawResult = raw !== undefined ? redactBankDetailsInRaw(raw) : null;
  return {
    text: textResult.text,
    textRedactions: textResult.redactions,
    raw: rawResult ? rawResult.raw : raw,
    rawRedactions: rawResult ? rawResult.redactions : 0,
  };
}

// Deepgram's utterance/word shape, as consumed by assembleTranscript below.
// Kept minimal and structural (not the SDK's own types) so the pure function
// can be unit-tested against hand-built fixtures without pulling in Deepgram.
export type TranscriptWord = { word: string; punctuated_word?: string; speaker?: number };
export type TranscriptUtterance = {
  transcript: string;
  speaker?: number;
  channel?: number;
  start?: number;
  words?: TranscriptWord[];
};

export interface AssembleTranscriptInput {
  utterances: TranscriptUtterance[];
  // True when BOTH this tenant is configured for split-stereo AND this file
  // actually came back with more than one channel — transcribeCall folds
  // both conditions together before calling in (a 'mono_diarize' tenant's
  // unexpectedly-stereo file still takes the mono path here).
  isMultichannel: boolean;
  // Which channel is the adviser on a stereo file: the per-tenant pin (or the
  // ADVISER_CHANNEL env fallback), resolved by the caller. Null falls back to
  // whichever channel's first utterance comes first.
  pinnedAdviserChannel: number | null;
  // Direction of the positional mono heuristic ("who spoke first") when
  // content identification abstains.
  monoFirstSpeaker: MonoFirstSpeaker;
  // Deepgram's raw, unlabelled per-channel transcript (channel 0) — the last
  // resort when nothing could be assembled from utterances at all.
  channelFallbackText: string;
}

export type AssembleTranscriptOutcome = 'assembled' | 'channel_fallback' | 'empty';

export interface AssembleTranscriptResult {
  text: string;
  speaker_attribution_confidence: number;
  adviser_identified_by_content: boolean;
  // Which of the three text sources ended up in `text` — see the fallback-
  // chain comment below. The caller (transcribeCall) logs on this instead of
  // this function performing I/O itself, which is what keeps it pure and
  // unit-testable without capturing console output.
  outcome: AssembleTranscriptOutcome;
  speakerCount: number;
  // The cluster content identification picked, or null if it abstained — the
  // caller logs the override (or the fallback to the positional guess) from
  // this and positionalAgentKey below.
  contentPick: { key: number; detail: string } | null;
  positionalAgentKey: number;
  agentKey: number;
}

/**
 * Turn Deepgram's utterances into a single labelled Agent/Customer
 * transcript. Pure: no I/O, no logging — see AssembleTranscriptResult's
 * `outcome` and `contentPick` fields for what the caller needs to reproduce
 * the same log lines transcribeCall always emitted.
 *
 * Split-stereo recordings come back with utterances tagged by channel — when
 * `isMultichannel`, attribute by channel (exact, no guessing) using
 * `pinnedAdviserChannel`. Otherwise (mono) the adviser cluster has to be
 * worked out.
 *
 * The positional heuristic ("who speaks first", flipped by monoFirstSpeaker)
 * rests entirely on ONE utterance, which makes it as fragile as that
 * utterance's diarisation. Observed failure: on an outbound call Deepgram put
 * the customer's opening "Hello?" (at 2s) into the ADVISER's cluster. That
 * made the adviser look like the first speaker, monoFirstSpeaker='customer'
 * concluded the adviser must be the OTHER cluster, and the whole call came out
 * inverted — a critical "adviser led the customer" breach was then raised on
 * the customer's own words. Measured over three real calls the positional
 * rule got 1 of 3 right.
 *
 * So content is tried first: score each cluster's whole speech for
 * adviser-specific behaviour (reading scripts, compliance wording, quoting
 * prices) via identifyAdviserCluster — dozens of signals across the call
 * rather than one word at 2 seconds, and got 3 of 3 on the same calls. It
 * abstains rather than guess when no single cluster is clearly the adviser,
 * and only then does the positional rule run.
 *
 * Turns are built from WORD-level speakers, not utterance-level: Deepgram's
 * utterance segmentation regularly runs across a speaker change (measured on
 * one tenant's corpus, 18.1% of utterances contain words from more than one
 * speaker), which misattributes one party's words to the other under a single
 * label. The boundary that fixes it does not exist at utterance level — it
 * DOES exist at word level, where Deepgram labels each word and gets it
 * right. Multichannel is untouched: a stereo pin is exact, and channel is
 * carried on the utterance rather than the word.
 *
 * The text returned follows a fallback chain, reported via `outcome`:
 *  1. 'assembled' — the word-level, speaker-labelled turns built here. The
 *     normal case, and the only one with an Agent/Customer split.
 *  2. 'channel_fallback' — reached only when NOTHING was assembled (0
 *     utterances, or every utterance came back with no word-level speakers
 *     to key off). Carries no speaker labels, so every turn-based checkpoint
 *     on the call is flying blind even though there may be real content.
 *  3. 'empty' — Deepgram returned no usable transcript at any level: silence,
 *     corrupted audio, or pure hold music/dead air. The caller
 *     (jobs/processors/transcribe.ts) treats this as a dedicated non-scoring
 *     'skipped' outcome rather than an evidence-bearing transcript — an empty
 *     transcript fed to scoring reads as "every disclosure went unaddressed"
 *     rather than "there was nothing to hear", a false breach manufactured
 *     from silence.
 */
export function assembleTranscript({
  utterances,
  isMultichannel,
  pinnedAdviserChannel,
  monoFirstSpeaker,
  channelFallbackText,
}: AssembleTranscriptInput): AssembleTranscriptResult {
  const speakerCount = new Set(utterances.map((u) => u.speaker ?? 0)).size;

  // Order by time so interleaved channels read as one conversation.
  const ordered = [...utterances].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  const speechByKey = new Map<number, string[]>();
  for (const u of ordered) {
    const words = u.words?.filter((w) => w.speaker !== undefined) ?? [];
    if (words.length === 0) {
      const k = u.speaker ?? 0;
      (speechByKey.get(k) ?? speechByKey.set(k, []).get(k)!).push(u.transcript);
      continue;
    }
    for (const w of words) {
      const k = w.speaker!;
      (speechByKey.get(k) ?? speechByKey.set(k, []).get(k)!).push(w.punctuated_word ?? w.word);
    }
  }
  const clusterSpeech: ClusterSpeech[] = [...speechByKey.entries()].map(([key, parts]) => ({
    key,
    text: parts.join(' '),
  }));
  const contentPick = isMultichannel ? null : identifyAdviserCluster(clusterSpeech);

  const firstSpeakerKey = ordered[0]?.speaker ?? 0;
  const positionalAgentKey =
    monoFirstSpeaker === 'customer'
      ? ordered.find((u) => (u.speaker ?? 0) !== firstSpeakerKey)?.speaker ?? firstSpeakerKey
      : firstSpeakerKey;

  const agentKey = isMultichannel
    ? pinnedAdviserChannel ?? (ordered[0]?.channel ?? 0)
    : contentPick?.key ?? positionalAgentKey;

  const merged: { speaker: string; text: string }[] = [];
  const pushWord = (key: number, text: string) => {
    const speaker = key === agentKey ? 'Agent' : 'Customer';
    const last = merged[merged.length - 1];
    if (last && last.speaker === speaker) last.text += ' ' + text;
    else merged.push({ speaker, text });
  };

  for (const u of ordered) {
    if (isMultichannel) {
      pushWord(u.channel ?? 0, u.transcript);
      continue;
    }
    // Fall back to the utterance label when word-level speakers are absent
    // (an older stored payload, or a provider that does not emit them).
    const words = u.words?.filter((w) => w.speaker !== undefined) ?? [];
    if (words.length === 0) {
      pushWord(u.speaker ?? 0, u.transcript);
      continue;
    }
    for (const w of words) pushWord(w.speaker!, w.punctuated_word ?? w.word);
  }

  const assembled = merged
    .map((m) => `${m.speaker}: ${m.text}`)
    .join('\n\n');

  let text: string;
  let outcome: AssembleTranscriptOutcome;
  if (assembled) {
    text = assembled;
    outcome = 'assembled';
  } else if (channelFallbackText) {
    text = channelFallbackText;
    outcome = 'channel_fallback';
  } else {
    text = '';
    outcome = 'empty';
  }

  return {
    text,
    speaker_attribution_confidence: computeSpeakerAttributionConfidence(
      isMultichannel,
      isMultichannel ? pinnedAdviserChannel : null,
      speakerCount,
      contentPick !== null
    ),
    // A stereo pin is a stronger form of the same thing: the adviser is known
    // from the channel, not guessed.
    adviser_identified_by_content: contentPick !== null || (isMultichannel && pinnedAdviserChannel !== null),
    outcome,
    speakerCount,
    contentPick,
    positionalAgentKey,
    agentKey,
  };
}

export async function transcribeCall(
  fileKey: string,
  extraKeyterms: string[] = [],
  encryptedAtRest: boolean = false,
  adviserChannel: number | null = null,
  transcriptionMode: TranscriptionMode = 'mono_diarize',
  deepgramRegion: DeepgramRegion = 'eu',
  monoFirstSpeaker: MonoFirstSpeaker = 'agent',
  // The Deepgram categories to actually redact for this tenant — already
  // resolved from organizations.pii_unredacted_categories (migration 079) by
  // resolveTenantRedactCategories, the one place that decides tenant
  // redaction policy (see its comment for why). Callers must resolve before
  // calling in, not pass the tenant's raw permitted-in-the-clear list here:
  // this parameter is what goes straight into the `redact:` option below.
  // Defaults to redacting everything, the same default resolveRedactCategories
  // produces for an empty permitted list.
  redactCategories: string[] = [...REDACTION_CATEGORIES]
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
      // Which of these a tenant may keep in the clear is per-organisation
      // (migration 079), already resolved by the caller via
      // resolveTenantRedactCategories — see resolveRedactCategories for the
      // resolution rule and its `pci` floor.
      redact: redactCategories,
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
  const utts = utterances as unknown as TranscriptUtterance[];

  // Split-stereo recordings come back with utterances tagged by channel. When
  // more than one channel is present, attribute by channel (exact, no guessing).
  // Otherwise (mono) fall back to the diarized speaker label. Guarded by
  // useMultichannel too, in case a 'mono_diarize' tenant's file is
  // unexpectedly stereo — the per-tenant setting still governs the branch.
  const isMultichannel = useMultichannel && new Set(utts.map((u) => u.channel ?? 0)).size > 1;

  // Which party is the adviser. For split-stereo the adviser is consistently on
  // one channel, so we pin it deterministically (no guessing). Precedence:
  // the per-tenant setting (adviserChannel arg) > the global ADVISER_CHANNEL env
  // fallback > "whoever speaks first" (they usually greet).
  const envChannel =
    process.env.ADVISER_CHANNEL === '0' || process.env.ADVISER_CHANNEL === '1'
      ? Number(process.env.ADVISER_CHANNEL)
      : null;
  const pinnedAdviserChannel = adviserChannel === 0 || adviserChannel === 1 ? adviserChannel : envChannel;

  const channelFallbackText = result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

  // The actual speaker-cluster-to-Agent/Customer assembly (stereo pin, mono
  // content-vs-positional heuristic, word-level turn merging, confidence
  // calculation and the text fallback chain) lives in the pure
  // assembleTranscript above — see its doc comment for the rationale. Kept
  // pure and I/O-free so it's unit-testable against hand-built fixtures;
  // logging on its result below reproduces exactly what this function always
  // logged.
  const assembly = assembleTranscript({
    utterances: utts,
    isMultichannel,
    pinnedAdviserChannel,
    monoFirstSpeaker,
    channelFallbackText,
  });

  if (assembly.contentPick) {
    if (assembly.contentPick.key !== assembly.positionalAgentKey) {
      // Worth its own line: this is the inversion the old code shipped silently.
      console.warn(
        `[Transcription] Adviser identified by content as cluster ${assembly.contentPick.key}, ` +
          `overriding the positional guess of ${assembly.positionalAgentKey} — ${assembly.contentPick.detail}`
      );
    }
  } else {
    console.log(
      `[Transcription] No cluster clearly identifiable as the adviser; falling back to the ` +
        `positional heuristic (cluster ${assembly.positionalAgentKey}, monoFirstSpeaker=${monoFirstSpeaker})`
    );
  }

  if (assembly.outcome === 'channel_fallback') {
    console.warn(
      `[Transcription] No speaker-labelled turns were assembled (0 utterances, or none carried ` +
        `word-level speakers) — falling back to Deepgram's unlabelled channel transcript ` +
        `(${channelFallbackText.length} chars, no Agent/Customer split).`
    );
  } else if (assembly.outcome === 'empty') {
    console.warn(
      `[Transcription] Deepgram returned no usable transcript at any level (no speaker turns, no ` +
        `raw channel transcript) — audio is likely silent, corrupted, or entirely off-topic noise.`
    );
  }

  const preRedactionText = assembly.text;
  const duration = result.metadata?.duration || 0;

  // Bank details out, here and nowhere later.
  //
  // This is the last point at which one function owns both the text and the raw
  // payload. Everything downstream — the Claude cleanup pass, storage, scoring,
  // exports — consumes what this returns, so redacting here means there is no
  // path around it. Doing it in the transcribe processor instead would leave the
  // cleanup call, which runs BEFORE storage, reading unredacted digits and
  // sending them to Anthropic.
  //
  // Cheap and inert when nothing matches (including on an empty string), so it
  // runs unconditionally rather than only for tenants with `numbers` permitted:
  // a config change must not be able to turn this off by accident, and when
  // `numbers` IS redacted at source there are no digit runs left for it to find.
  const { text, textRedactions, raw, rawRedactions } = redactForTenant(preRedactionText, result);
  if (textRedactions > 0 || rawRedactions > 0) {
    console.log(
      `[Transcription] Redacted bank details: ${textRedactions} in the transcript, ` +
        `${rawRedactions} in the raw payload`
    );
  }

  return {
    raw,
    text,
    duration_seconds: duration,
    speaker_attribution_confidence: assembly.speaker_attribution_confidence,
    adviser_identified_by_content: assembly.adviser_identified_by_content,
  };
}
