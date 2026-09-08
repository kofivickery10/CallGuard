-- One person, several phone numbers (CG-8).
--
-- Surfaced by Trust Point (Joey Crone, 26 August 2026): "There's a sale on
-- there called Lee Kidd. It's a weird complicated call that takes place over
-- several phone numbers and lots of the calls are missing from the sale."
--
-- THE GAP: `customers` is UNIQUE on (organization_id, phone_normalized) — one
-- row per NUMBER, not per person — and a journey hangs off a single
-- customer_id. So when a customer rings from a second number, those calls
-- resolve to a second customer row and can never be pulled into the sale.
-- Assembly then scores part of the conversation and presents the result exactly
-- as it presents a sale scored on complete evidence. Nothing anywhere says the
-- evidence was partial.
--
-- WHY A LINK AND NOT A RESTRUCTURE: the obvious model is many numbers to one
-- customer, which means changing how ingestion resolves a caller and dropping
-- the unique constraint that has protected that path since the beginning. That
-- is a large change to the matching code on a live system, and hard to reverse
-- once rows have merged. A link leaves ingestion, the constraint and every
-- existing row exactly as they are: customers still resolve per number, and
-- this only changes which calls ASSEMBLY considers to belong to one person.
-- Unlinking is setting a column back to NULL.
--
-- WHY NULL RATHER THAN "EVERY ROW IS ITS OWN IDENTITY": NULL says "nobody has
-- claimed this customer is the same person as anyone else", which is the honest
-- state of every row today and of most rows forever. Giving each row a private
-- identity up front would make "linked to nothing" and "linked to itself"
-- indistinguishable, and would invite code to treat the column as always
-- meaningful when it is the exception.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS identity_id UUID;

COMMENT ON COLUMN customers.identity_id IS
  'Customers sharing a non-null identity_id are the same person reached on different numbers (CG-8). NULL means unlinked — the row stands alone, which is the normal case. Journey assembly gathers calls across every customer in the group.';

-- Assembly looks up the whole group from one member on every sale, so the read
-- pattern is "given an identity, find its customers", scoped to the org.
CREATE INDEX IF NOT EXISTS idx_customers_identity
  ON customers (organization_id, identity_id)
  WHERE identity_id IS NOT NULL;

-- Who linked these numbers together, and why.
--
-- This is not decoration. Linking changes which calls a compliance score is
-- computed from — it can move a score, add breaches, or remove them — so "these
-- two numbers are the same person" is an assertion someone has to own. A score
-- that changed because of a link, with no record of who made the link or on
-- what basis, is exactly the kind of unexplained movement an audit cannot
-- tolerate.
--
-- Append-only, and kept when a link is undone: the unlink is recorded as its
-- own row rather than deleting the row that claimed the link. A link that was
-- made, acted on, and then quietly removed is precisely the sequence a reader
-- needs to be able to see.
CREATE TABLE IF NOT EXISTS customer_identity_events (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    identity_id       UUID NOT NULL,
    -- The customer row joined or removed by this event. Not a foreign key on
    -- purpose: the event must outlive a customer erased under a data-subject
    -- request (services delete-customer-data.ts), because the fact that a link
    -- once existed is what explains a score that moved at the time.
    customer_id       UUID NOT NULL,
    action            TEXT NOT NULL CHECK (action IN ('linked', 'unlinked')),
    -- Snapshotted, for the same reason journey_feedback snapshots its adviser
    -- (087): the actor's user row can be deleted or renamed, and an unattributed
    -- claim about someone's identity carries no weight.
    actor_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_name        TEXT NOT NULL,
    -- Why the person believed these numbers belong to the same customer. Free
    -- text, required by the API rather than by the schema so an older row is
    -- not retro-invalidated.
    reason            TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE customer_identity_events IS
  'Append-only record of customers being linked as one person, or unlinked (CG-8). Retained after an unlink, and after the customer row is erased: a score that moved because of a link must remain explainable.';

CREATE INDEX IF NOT EXISTS idx_customer_identity_events_identity
  ON customer_identity_events (identity_id, created_at);

CREATE INDEX IF NOT EXISTS idx_customer_identity_events_org
  ON customer_identity_events (organization_id, created_at DESC);
