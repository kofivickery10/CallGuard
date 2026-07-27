// Video → audio extraction at the ingest boundary.
//
// Advice conversations are not all on the phone. A firm running Teams, Zoom or
// Meet appointments has a video container as its only record of the call, and
// mortgage advice in particular is often given over a screen-share rather than
// a dialler. Everything downstream of ingest — storage, encryption, retention
// purge, Deepgram, playback in CallDetail — is built for audio, so rather than
// teach each of those about video we strip the video track once, here, and let
// only audio past this point.
//
// Deliberately at the ingest boundary and not later in the pipeline: a video
// file that reached storage would be encrypted at rest, counted in retention,
// and served to the browser audio element, all for a track nobody scores.
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { VIDEO_MIME_TYPES, VIDEO_FILE_EXTENSIONS } from '@callguard/shared';
import { AppError } from '../middleware/errors.js';

const execFileAsync = promisify(execFile);

// ffmpeg-static ships a platform binary, so no server-side apt install is
// needed for a worker to handle a Teams recording. FFMPEG_PATH overrides it for
// hosts that would rather use their own build (same pattern as ADVISER_CHANNEL
// in services/transcription.ts).
let ffmpegPathPromise: Promise<string | null> | null = null;
async function resolveFfmpegPath(): Promise<string | null> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  ffmpegPathPromise ??= import('ffmpeg-static')
    .then((m) => (m.default as unknown as string | null) ?? null)
    .catch(() => null);
  return ffmpegPathPromise;
}

// A long meeting recording is a real transcode, not a remux — an hour of 720p
// takes a while to demux even when we only want the audio. Well above the
// realistic worst case, but bounded so a malformed container can't wedge a
// worker slot indefinitely.
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;

// ffmpeg is chatty on stderr even at -loglevel error.
const FFMPEG_STDERR_MAX_BYTES = 4 * 1024 * 1024;

export interface MediaAsset {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

/**
 * Is this a video container we should extract audio from? Checked by declared
 * MIME type first, then by extension — CloudTalk-style sources that stream a
 * container as `application/octet-stream` would otherwise slip through and
 * reach Deepgram as an unusable "audio" file.
 */
export function isVideoMedia(mimeType: string, fileName?: string): boolean {
  const mime = (mimeType || '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (VIDEO_MIME_TYPES.includes(mime)) return true;
  // Only trust the extension when the MIME type told us nothing useful. A
  // source that explicitly declared audio/* is taken at its word.
  if (mime && !/octet-stream|binary/i.test(mime)) return false;
  const ext = path.extname(fileName ?? '').toLowerCase();
  return VIDEO_FILE_EXTENSIONS.includes(ext);
}

/** Swap a filename's extension for `.mp3`, keeping any dots inside the stem. */
function toMp3FileName(fileName: string): string {
  const base = path.basename(fileName || 'recording');
  const stem = base.replace(/\.[^.]*$/, '') || 'recording';
  return `${stem}.mp3`;
}

/**
 * Strip the video track and return the audio as MP3.
 *
 * Input goes via a temp file rather than stdin: an MP4 whose `moov` atom sits at
 * the end of the file (what most screen recorders produce) is not demuxable from
 * a non-seekable pipe, so piping silently fails on exactly the files we most
 * expect to receive.
 *
 * Channel count and sample rate are deliberately left alone. A tenant on
 * `stereo_multichannel` gets exact per-channel speaker attribution from a
 * split-stereo source (services/transcription.ts), and downmixing to mono here
 * would quietly destroy that and drop them onto the diarisation heuristic.
 */
export async function extractAudioTrack(asset: MediaAsset): Promise<MediaAsset> {
  const ffmpeg = await resolveFfmpegPath();
  if (!ffmpeg) {
    throw new AppError(
      500,
      'This recording is a video file and needs its audio extracted, but ffmpeg is not available on the server. Set FFMPEG_PATH or reinstall dependencies.'
    );
  }

  const scratch = path.join(os.tmpdir(), `callguard-media-${randomBytes(8).toString('hex')}`);
  const inputPath = `${scratch}-in${path.extname(asset.fileName) || '.mp4'}`;
  const outputPath = `${scratch}-out.mp3`;

  try {
    await fs.writeFile(inputPath, asset.buffer);

    try {
      await execFileAsync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel', 'error',
          // Never wait on a prompt (e.g. "file exists, overwrite?") — with no
          // TTY attached that would hang until the timeout.
          '-nostdin',
          '-y',
          '-i', inputPath,
          // Drop video and subtitles; take the first audio stream. Meeting
          // recordings occasionally carry a per-participant stream set, where
          // stream 0 is the mix — which is what we want.
          '-vn',
          '-sn',
          '-map', '0:a:0',
          '-acodec', 'libmp3lame',
          '-q:a', '4',
          outputPath,
        ],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_STDERR_MAX_BYTES }
      );
    } catch (err) {
      // ffmpeg's own stderr is far more useful than the exec wrapper's message
      // ("Command failed"), and the common causes are all user-fixable: a
      // recording with no audio track, or a container we can't demux.
      const detail = String((err as { stderr?: string }).stderr || (err as Error).message)
        .trim()
        .split('\n')
        .slice(-3)
        .join('; ')
        .slice(0, 300);
      throw new AppError(400, `Could not extract audio from this video file: ${detail}`);
    }

    const buffer = await fs.readFile(outputPath);
    if (buffer.length === 0) {
      throw new AppError(400, 'Audio extraction produced an empty file — the recording may have no audio track');
    }

    return { buffer, fileName: toMp3FileName(asset.fileName), mimeType: 'audio/mpeg' };
  } finally {
    // Best-effort: a leftover temp file is noise, a thrown cleanup error would
    // mask the real failure above.
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

/**
 * The single call every ingest path makes before storing a recording. Audio is
 * returned untouched; a video container is converted to MP3 first.
 *
 * Idempotent — a converted asset reports `audio/mpeg`, so a second pass over an
 * already-extracted file is a no-op. That matters because more than one layer
 * calls this (the remote fetch in services/ingestion.ts, then ingestCall
 * itself).
 */
export async function prepareMediaForIngest(asset: MediaAsset): Promise<MediaAsset> {
  if (!isVideoMedia(asset.mimeType, asset.fileName)) return asset;

  const before = asset.buffer.length;
  const extracted = await extractAudioTrack(asset);
  console.log(
    `[Media] Extracted audio from ${asset.mimeType || 'video container'} "${asset.fileName}": ` +
      `${Math.round(before / 1024 / 1024)}MB video → ${Math.round(extracted.buffer.length / 1024 / 1024)}MB MP3`
  );
  return extracted;
}
