-- Track when a user last made an authenticated request.
-- Used by the superadmin live dashboard to show active user counts.
-- Updated on each request via auth middleware (debounced to every 5 minutes).
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
