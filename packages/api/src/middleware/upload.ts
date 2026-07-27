import multer from 'multer';
import {
  MAX_UPLOAD_FILE_SIZE_BYTES,
  ALLOWED_UPLOAD_MIME_TYPES,
  KB_MAX_FILE_SIZE_BYTES,
  KB_ALLOWED_MIME_TYPES,
} from '@callguard/shared';
import { AppError } from './errors.js';

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: {
    // The video ceiling, since a meeting recording arrives as a container and is
    // only reduced to audio after this point (services/media.ts).
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
