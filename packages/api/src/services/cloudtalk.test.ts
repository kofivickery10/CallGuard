import { describe, it, expect } from 'vitest';
import { cloudTalkCallIdFromRecordingUrl, resolveCloudTalkCallId, natSig } from './cloudtalk.js';

// The numeric CDR id recovered here is the only key shared between the two
// ingest routes (live webhook stores call_uuid, history API stores the numeric
// id). If this decode is wrong, a backfill silently duplicates every call
// already captured live and the sale is scored twice over the same
// conversations — see migration 075.
describe('cloudTalkCallIdFromRecordingUrl', () => {
  // Both fixtures are real production pointers, cross-checked against the ids
  // CloudTalk's history API returns for the same two calls.
  it('recovers the id from a live-capture pointer (URL-encoded padding)', () => {
    expect(
      cloudTalkCallIdFromRecordingUrl(
        'https://my.cloudtalk.io/pub/r/MTI0NzQwMDM1NA%3D%3D/ZDljZGEwNTNmNzFiZWNjZDY4ZmQ1ZjdmNTYwYzA4ODI4ZmNhMTg1NWQ1OThlMmQ3MDMyMDVmMTE2NmEzYTY4Mg%3D%3D.wav'
      )
    ).toBe('1247400354');
  });

  it('recovers the id when the padding is not URL-encoded', () => {
    expect(
      cloudTalkCallIdFromRecordingUrl('https://my.cloudtalk.io/pub/r/MTI1MTEyNDE2Ng==/abc.wav')
    ).toBe('1251124166');
  });

  it('returns null for a missing or empty URL', () => {
    expect(cloudTalkCallIdFromRecordingUrl(null)).toBeNull();
    expect(cloudTalkCallIdFromRecordingUrl(undefined)).toBeNull();
    expect(cloudTalkCallIdFromRecordingUrl('')).toBeNull();
  });

  it('returns null for a URL that is not a CloudTalk recording pointer', () => {
    expect(cloudTalkCallIdFromRecordingUrl('https://example.com/audio/call.wav')).toBeNull();
    // Right host, wrong path shape — no trailing segment after the id.
    expect(cloudTalkCallIdFromRecordingUrl('https://my.cloudtalk.io/pub/r/MTI0NzQwMDM1NA==')).toBeNull();
  });

  it('returns null rather than a junk key when the segment decodes to non-digits', () => {
    // "aGVsbG8=" -> "hello". Storing that as a dedupe key would be worse than
    // storing nothing: it could collide across unrelated calls.
    expect(cloudTalkCallIdFromRecordingUrl('https://my.cloudtalk.io/pub/r/aGVsbG8=/x.wav')).toBeNull();
  });

  it('returns null on undecodable input instead of throwing', () => {
    expect(cloudTalkCallIdFromRecordingUrl('https://my.cloudtalk.io/pub/r/%%%/x.wav')).toBeNull();
  });
});

describe('resolveCloudTalkCallId', () => {
  it('prefers a payload id that is already numeric', () => {
    expect(resolveCloudTalkCallId('1247400354', 'https://my.cloudtalk.io/pub/r/MTI1MTEyNDE2Ng==/x.wav'))
      .toBe('1247400354');
  });

  it('falls back to the recording URL when the payload id is a UUID', () => {
    // The real case: the tenant's field map resolves call_id from call_uuid
    // first, so the numeric id has to come from the URL.
    expect(
      resolveCloudTalkCallId(
        '1c2787a8-5dc3-4c16-9329-97663e29c6bf',
        'https://my.cloudtalk.io/pub/r/MTI0NzQwMDM1NA%3D%3D/x.wav'
      )
    ).toBe('1247400354');
  });

  it('returns null when neither source yields an id', () => {
    expect(resolveCloudTalkCallId(null, null)).toBeNull();
    expect(resolveCloudTalkCallId('1c2787a8-5dc3-4c16-9329-97663e29c6bf', null)).toBeNull();
  });
});

// Phone matching for the backfill's client-side index. CloudTalk's server-side
// filters are ignored on this account, so every number comparison happens here.
describe('natSig', () => {
  it('treats +44, 44 and 0 forms of one number as equal', () => {
    const forms = ['+447789843300', '447789843300', '07789843300', '+44 7789 843300'];
    const reduced = forms.map(natSig);
    expect(new Set(reduced).size).toBe(1);
    expect(reduced[0]).toBe('7789843300');
  });

  it('returns an empty string for missing input', () => {
    expect(natSig(null)).toBe('');
    expect(natSig(undefined)).toBe('');
  });
});
