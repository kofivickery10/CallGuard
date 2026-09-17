import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import type { FileRejection } from 'react-dropzone';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
  MAX_VIDEO_FILE_SIZE_BYTES,
  MAX_VIDEO_FILE_SIZE_MB,
  VIDEO_MIME_TYPES,
} from '@callguard/shared';
import { formatFileSize } from '../lib/format';

// The formats and ceilings, in one sentence, from the shared constants the API
// enforces — so the page can never promise a limit the server refuses.
export const RECORDING_LIMITS_TEXT =
  `Audio (MP3, WAV, M4A) up to ${MAX_FILE_SIZE_MB} MB · ` +
  `Teams or Zoom video (MP4, MOV, WebM) up to ${MAX_VIDEO_FILE_SIZE_MB} MB`;

export function isVideoRecording(file: File): boolean {
  return (
    VIDEO_MIME_TYPES.includes(file.type) ||
    /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(file.name)
  );
}

/**
 * Why a file can't be uploaded, as a sentence — or null when it can.
 *
 * Checked here as well as on the API because a refused file should be refused
 * before the bytes are sent: an over-limit 500MB video otherwise spends four
 * minutes uploading to earn a 413.
 */
export function recordingProblem(file: File): string | null {
  const isVideo = isVideoRecording(file);
  const isAudio = ALLOWED_MIME_TYPES.includes(file.type) || /\.(mp3|wav|m4a)$/i.test(file.name);

  if (!isVideo && !isAudio) {
    return `${file.name} isn't a recording CallGuard can read. Use MP3, WAV or M4A audio, or an MP4, MOV or WebM video.`;
  }
  const limit = isVideo ? MAX_VIDEO_FILE_SIZE_BYTES : MAX_FILE_SIZE_BYTES;
  if (file.size > limit) {
    return isVideo
      ? `That video is ${formatFileSize(file.size)}. Teams or Zoom recordings can be up to ${MAX_VIDEO_FILE_SIZE_MB} MB.`
      : `That audio file is ${formatFileSize(file.size)}. Audio recordings can be up to ${MAX_FILE_SIZE_MB} MB.`;
  }
  if (file.size === 0) {
    return `${file.name} is empty — there's no audio in it to transcribe.`;
  }
  return null;
}

interface FileDropzoneProps {
  /** A file that passed the checks above. Choosing one starts nothing. */
  onFileChosen: (file: File) => void;
  /** Why a file was refused. Never silent — every rejection arrives here. */
  onFileRefused: (reason: string) => void;
  disabled?: boolean;
}

/**
 * The empty state of the recording step: a drop target that is also a real,
 * labelled, keyboard-reachable button. Dropping and choosing both go through
 * the same checks, and a refusal always comes back with a reason.
 */
export function FileDropzone({ onFileChosen, onFileRefused, disabled }: FileDropzoneProps) {
  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      if (accepted.length + rejections.length > 1) {
        onFileRefused('One recording at a time — choose a single file.');
        return;
      }
      const rejected = rejections[0];
      if (rejected) {
        onFileRefused(recordingProblem(rejected.file) ?? rejected.errors[0]?.message ?? 'That file was refused.');
        return;
      }
      const file = accepted[0];
      if (!file) return;
      const problem = recordingProblem(file);
      if (problem) {
        onFileRefused(problem);
        return;
      }
      onFileChosen(file);
    },
    [onFileChosen, onFileRefused]
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    // The visible <button> below opens the picker, so the wrapper is a drop
    // target only — a div that swallows clicks and keystrokes is what made the
    // old one invisible to the keyboard.
    noClick: true,
    noKeyboard: true,
    multiple: false,
    disabled,
    // Anything not in this list still reaches onDrop as a rejection, so the
    // reason can be shown rather than the file vanishing.
    accept: {
      'audio/mpeg': ['.mp3'],
      'audio/wav': ['.wav'],
      'audio/x-m4a': ['.m4a'],
      'audio/mp4': ['.m4a'],
      'video/mp4': ['.mp4', '.m4v'],
      'video/quicktime': ['.mov'],
      'video/webm': ['.webm'],
      'video/x-matroska': ['.mkv'],
    },
  });

  return (
    <div
      {...getRootProps()}
      className={`rounded-card border-2 border-dashed p-6 text-center transition-colors ${
        isDragActive
          ? 'border-primary bg-primary-light'
          : disabled
            ? 'border-border bg-page opacity-60'
            : 'border-border bg-primary-light/50'
      }`}
    >
      <input {...getInputProps()} />
      <button
        type="button"
        onClick={open}
        disabled={disabled}
        aria-label="Choose a recording to upload"
        aria-describedby="recording-limits"
        className="inline-flex items-center gap-2 min-h-[44px] px-[18px] py-[9px] rounded-btn bg-primary-ink text-on-solid text-table-cell font-semibold hover:bg-primary-ink-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <svg
          viewBox="0 0 24 24"
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span className="hidden sm:inline">
          {isDragActive ? 'Drop the recording' : 'Drop a recording here, or choose one'}
        </span>
        <span className="sm:hidden">Choose a recording</span>
      </button>
      <p id="recording-limits" className="text-xs text-text-muted mt-3">
        {RECORDING_LIMITS_TEXT}
      </p>
    </div>
  );
}
