import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  database: {
    url: required('DATABASE_URL'),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: '7d',
  },

  encryptionKey: required('ENCRYPTION_KEY'),

  uploadsDir: optional('UPLOADS_DIR', path.resolve(__dirname, '../../../uploads')),

  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY || '',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: optional('RESEND_FROM_EMAIL', 'alerts@callguardai.co.uk'),
  },

  appUrl: optional('APP_URL', 'http://localhost:5173'),
} as const;
