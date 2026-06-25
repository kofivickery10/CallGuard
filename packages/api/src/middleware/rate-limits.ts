import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

// Resolve the real client IP, preferring Cloudflare's header.
const clientIpKey = (req: Request): string => {
  const cf = req.headers['cf-connecting-ip'];
  const ip = (Array.isArray(cf) ? cf[0] : cf) || req.ip || '';
  return ipKeyGenerator(ip);
};

// Global IP-based limiter applied to every route.
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many requests. Please slow down and try again shortly.' },
});

// Tight bucket for credential endpoints (login / register).
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many attempts. Please wait a minute and try again.' },
});

// Second-factor verification attempts (TOTP / backup / email code). Tight, since
// a valid challenge token + brute force would otherwise bypass the password.
export const twoFactorLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many verification attempts. Please wait a minute and try again.' },
});

// Sending 2FA codes by email — very tight to prevent inbox flooding / cost abuse.
export const emailCodeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 4,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many code requests. Please wait a minute and try again.' },
});

// Tight bucket for the unauthenticated public form.
export const publicFormLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many submissions. Please try again shortly.' },
});

// Per-API-key limiter for ingestion and streaming endpoints.
// Applied AFTER authenticateApiKey so req.user is populated.
// Falls back to IP if for some reason the user isn't set (should not happen).
export const apiKeyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request): string => req.user?.userId ?? clientIpKey(req),
  message: { message: 'API key rate limit exceeded. Maximum 100 requests per minute.' },
});
