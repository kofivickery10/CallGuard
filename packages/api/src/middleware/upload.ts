import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import {
  MAX_UPLOAD_FILE_SIZE_BYTES,
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_FILE_SIZE_MB,
  MAX_VIDEO_FILE_SIZE_MB,
  KB_MAX_FILE_SIZE_BYTES,
  KB_ALLOWED_MIME_TYPES,
} from '@callguard/shared';
import { AppError } from './errors.js';

const storage = multer.memoryStorage();

// Named once so the 413 the route throws for an over-limit audio file (after
// multer, once the mimetype is known — see routes/calls.ts) and the one
// multer itself trips for anything over the video ceiling read the same.
export const UPLOAD_SIZE_LIMIT_MESSAGE =
  `Recordings can be up to ${MAX_FILE_SIZE_MB} MB for audio or ${MAX_VIDEO_FILE_SIZE_MB} MB for a Teams or Zoom video.`;

export const upload = multer({
  storage,
  limits: {
    // The video ceiling, since a meeting recording arrives as a container and is
    // only reduced to audio after this point (services/media.ts). The tighter
    // audio-only ceiling can't be expressed here (multer's limit is per-field,
    // not per-mimetype) — the route enforces it after multer, once the
    // mimetype is known.
    fileSize: MAX_UPLOAD_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, `Invalid file type: ${file.mimetype}. Allowed: MP3, WAV, M4A, MP4, MOV, WebM, MKV`));
    }
  },
});

// Multer raises its own MulterError for an over-limit file rather than an
// AppError, so left alone it falls through errorHandler's generic branch
// ("An unexpected error occurred") instead of naming the limit. Register this
// right after upload.single(...) in the route — Express treats a 4-arg
// function in a route's middleware list as the error handler for that route.
export function handleUploadError(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new AppError(413, UPLOAD_SIZE_LIMIT_MESSAGE));
    return;
  }
  next(err);
}

export const uploadKB = multer({
  storage,
  limits: {
    fileSize: KB_MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    if (KB_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, `Invalid file type: ${file.mimetype}. Allowed: PDF, DOCX, DOC, TXT, MD`));
    }
  },
});
