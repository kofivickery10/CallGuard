export const CALL_STATUSES = [
  'uploaded',
  'transcribing',
  'transcribed',
  'scoring',
  'scored',
  'failed',
] as const;

export const SCORE_TYPES = ['binary', 'scale_1_5', 'scale_1_10'] as const;

export const USER_ROLES = ['admin', 'member'] as const;

export const PASS_THRESHOLD = 70;

export const MAX_FILE_SIZE_MB = 100;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const ALLOWED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
];

export const KB_MAX_FILE_SIZE_MB = 20;
export const KB_MAX_FILE_SIZE_BYTES = KB_MAX_FILE_SIZE_MB * 1024 * 1024;

export const KB_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];
