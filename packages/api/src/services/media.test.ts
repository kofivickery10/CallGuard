import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import { isVideoMedia, prepareMediaForIngest, extractAudioTrack } from './media.js';

const execFileAsync = promisify(execFile);

// Build a real container to convert, rather than a hand-rolled byte fixture:
// the failure mode this code exists to prevent (a container we can't demux) is
// only exercised by putting a genuine file through ffmpeg.
async function makeFixture(
  args: string[],
  ext: string
): Promise<{ buffer: Buffer; fileName: string }> {
  const { default: ffmpeg } = await import('ffmpeg-static');
  const out = path.join(os.tmpdir(), `callguard-fixture-${randomBytes(6).toString('hex')}${ext}`);
  try {
    await execFileAsync(ffmpeg as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
    return { buffer: await fs.readFile(out), fileName: path.basename(out) };
  } finally {
    await fs.rm(out, { force: true }).catch(() => {});
  }
}

/** 2s of 25fps colour bars plus a 440Hz tone, muxed to MP4. */
const videoWithAudio = () =>
  makeFixture(
    [
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
    '.mp4'
  );

/** 2s of colour bars with no audio stream at all. */
const videoWithoutAudio = () =>
  makeFixture(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], '.mp4');

describe('isVideoMedia', () => {
  it('recognises video containers by MIME type', () => {
    expect(isVideoMedia('video/mp4', 'call.mp4')).toBe(true);
    expect(isVideoMedia('video/quicktime', 'call.mov')).toBe(true);
    expect(isVideoMedia('video/x-matroska', 'call.mkv')).toBe(true);
  });

  it('leaves audio alone', () => {
    expect(isVideoMedia('audio/mpeg', 'call.mp3')).toBe(false);
    expect(isVideoMedia('audio/wav', 'call.wav')).toBe(false);
    // An .m4a shares the ISO container with .mp4 but must not be re-encoded.
    expect(isVideoMedia('audio/x-m4a', 'call.m4a')).toBe(false);
  });

  it('falls back to the extension only when the MIME type is uninformative', () => {
    // CloudTalk-style: real container, generic declared type.
    expect(isVideoMedia('application/octet-stream', 'recording.mp4')).toBe(true);
    expect(isVideoMedia('binary/octet-stream', 'recording.mov')).toBe(true);
    expect(isVideoMedia('application/octet-stream', 'recording.mp3')).toBe(false);
    // A source that explicitly declared audio is taken at its word even when
    // the filename disagrees — otherwise a mislabelled name would trigger a
    // pointless re-encode of perfectly good audio.
    expect(isVideoMedia('audio/mpeg', 'weirdly-named.mp4')).toBe(false);
  });

  it('treats a missing MIME type as unknown and uses the extension', () => {
    expect(isVideoMedia('', 'appointment.webm')).toBe(true);
    expect(isVideoMedia('', 'appointment.mp3')).toBe(false);
  });
});

describe('extractAudioTrack', () => {
  it('strips the video track and returns MP3 audio', async () => {
    const fixture = await videoWithAudio();
    const out = await extractAudioTrack({ ...fixture, mimeType: 'video/mp4' });

    expect(out.mimeType).toBe('audio/mpeg');
    expect(out.fileName.endsWith('.mp3')).toBe(true);
    expect(out.buffer.length).toBeGreaterThan(0);
    // An MP3 opens with an ID3 tag or an MPEG frame sync — proof we got audio
    // out and not a passed-through container.
    const sig = out.buffer.subarray(0, 3).toString('hex').toLowerCase();
    expect(sig === '494433' || sig.startsWith('fff')).toBe(true);
    // The audio-only result must be smaller than the H.264 source.
    expect(out.buffer.length).toBeLessThan(fixture.buffer.length);
  }, 60_000);

  it('fails clearly when the recording has no audio track', async () => {
    const fixture = await videoWithoutAudio();
    await expect(
      extractAudioTrack({ ...fixture, mimeType: 'video/mp4' })
    ).rejects.toThrow(/could not extract audio/i);
  }, 60_000);
});

describe('prepareMediaForIngest', () => {
  it('passes audio through untouched', async () => {
    const asset = { buffer: Buffer.from('not really audio'), fileName: 'call.mp3', mimeType: 'audio/mpeg' };
    const out = await prepareMediaForIngest(asset);
    expect(out).toBe(asset);
  });

  it('is idempotent — a converted asset is not converted again', async () => {
    const fixture = await videoWithAudio();
    const once = await prepareMediaForIngest({ ...fixture, mimeType: 'video/mp4' });
    const twice = await prepareMediaForIngest(once);
    // Same object back: nothing re-encoded on the second pass. This is what lets
    // fetchRemoteAudio and ingestCall both call it without fighting.
    expect(twice).toBe(once);
  }, 60_000);
});
