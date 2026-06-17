-- Per-(org, user) read watermark for the support chat.
--   Tenant side:  user_id = the customer; organization_id = their own org.
--   Operator side: user_id = the staff/superadmin; organization_id = the org whose
--                   thread they were viewing. Each operator tracks their own reads.
-- "Unread" for a viewer = messages from the OTHER party created after last_read_at.
CREATE TABLE IF NOT EXISTS support_thread_reads (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
