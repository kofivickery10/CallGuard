import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne } from '../db/client.js';
import { uploadFile, deleteFile } from './storage.js';
import { transcriptionQueue } from '../jobs/queue.js';
import { ingestCall } from './ingestion.js';

// ingestCall uploads the encrypted audio under a freshly generated
// per-call fileKey *before* the INSERT that references it. If the INSERT
// fails for any reason, that upload is otherwise orphaned — no row ever
// points at it, so retention purge (which works from DB rows) never finds
// and deletes it. These tests pin the compensating cleanup: a failed insert
// must delete what it just uploaded before the error reaches the caller.
vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('./storage.js', () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock('../jobs/queue.js', () => ({
  transcriptionQueue: { add: vi.fn() },
}));

const ORG = 'org-1';

// No agent/customer/scorecard fields set, so resolveAgent, upsertCustomer and
// the scorecard lookup all short-circuit without hitting the db — isolating
// these tests to just the upload + INSERT + cleanup path under test.
function baseParams() {
  return {
    organizationId: ORG,
    uploadedBy: null,
    fileName: 'call.mp3',
    buffer: Buffer.from('audio-bytes'),
    mimeType: 'audio/mpeg',
    ingestionSource: 'api' as const,
  };
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
  vi.mocked(uploadFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(transcriptionQueue.add).mockReset();
});

describe('ingestCall — orphaned upload cleanup on insert failure', () => {
  it('deletes the just-uploaded file and rethrows on a non-duplicate insert failure', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null); // findExistingCall — no idempotent match
    const insertError = new Error('connection reset');
    vi.mocked(query).mockRejectedValueOnce(insertError); // the INSERT INTO calls

    await expect(ingestCall(baseParams())).rejects.toBe(insertError);

    expect(uploadFile).toHaveBeenCalledTimes(1);
    const uploadedKey = vi.mocked(uploadFile).mock.calls[0]![0];
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(uploadedKey);
  });

  it('also deletes this request\'s upload on a duplicate-key race, since the row it recovers belongs to the OTHER request', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null); // findExistingCall — no match before the race
    const dupError = Object.assign(new Error('duplicate key'), { code: '23505' });
    vi.mocked(query).mockRejectedValueOnce(dupError); // the INSERT loses the race

    const racedCall = { id: 'the-other-requests-call', organization_id: ORG } as unknown as Record<string, unknown>;
    vi.mocked(queryOne).mockResolvedValueOnce(racedCall as never); // findExistingCall — recovers the winner's row

    const result = await ingestCall({ ...baseParams(), externalId: 'ext-1' });

    expect(result.isDuplicate).toBe(true);
    expect(result.call).toBe(racedCall);

    // This request's own upload is unreferenced by any row (the returned row
    // belongs to the request that won the race) and must not be left behind.
    const uploadedKey = vi.mocked(uploadFile).mock.calls[0]![0];
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(uploadedKey);
  });

  it('does not mask the original insert error if cleanup itself fails', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    const insertError = new Error('connection reset');
    vi.mocked(query).mockRejectedValueOnce(insertError);
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error('disk full'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ingestCall(baseParams())).rejects.toBe(insertError);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('does not touch storage when the insert succeeds', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null); // findExistingCall
    vi.mocked(query).mockResolvedValueOnce([{ id: 'new-call' }] as never); // the INSERT

    const result = await ingestCall(baseParams());

    expect(result.isDuplicate).toBe(false);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
