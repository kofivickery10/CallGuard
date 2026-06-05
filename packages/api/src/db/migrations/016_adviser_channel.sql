-- Per-tenant stereo channel mapping for the adviser on split-stereo recordings.
-- 0 = left (channel 0), 1 = right (channel 1), NULL = auto-detect (first speaker).
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS adviser_channel SMALLINT CHECK (adviser_channel IN (0, 1));
