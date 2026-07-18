-- Generalise notifications beyond alert-rule matches.
--
-- Until now a row in `notifications` could only be born from an alert-rule
-- match (services/alert-evaluator.ts was the only writer). System events —
-- a breach assigned to you, a breach escalated, and future review/coaching
-- events — now create notifications through the same table and the same
-- in-app bell, via services/notify.ts.
--
--   type       — the event kind (e.g. 'breach.assigned'); null on legacy
--                alert-sourced rows, which the UI treats as a generic alert.
--   breach_id  — the breach a notification is about (nullable; alert rows use
--                call_id/rule_id instead).
--   action_url — app-relative deep link the notification opens (e.g. /breaches).
--   dedupe_key — stops the same directed event pinging a user twice while it's
--                still unread (see the partial unique index below).
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS type       TEXT,
  ADD COLUMN IF NOT EXISTS breach_id  UUID REFERENCES breaches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS action_url TEXT,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- One live (unread) notification per (user, event). A repeated trigger on the
-- same entity — reassigning the same breach, toggling status back to escalated
-- — is swallowed by ON CONFLICT DO NOTHING while the earlier one is unread;
-- once the user reads it, the next trigger produces a fresh notification.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications (user_id, dedupe_key)
  WHERE read_at IS NULL AND dedupe_key IS NOT NULL;
