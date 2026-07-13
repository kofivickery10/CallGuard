-- Guard against duplicate in-flight journeys for the same customer. A Zoho
-- sale-trigger webhook that Zoho retries (timeout / 5xx / re-saved deal) would
-- otherwise spawn a second journey, a second Claude scoring run, duplicate
-- breaches and a duplicate CRM write-back. At most one pending/scoring journey
-- per (org, customer) at a time; assembleJourney catches the 23505 and returns
-- the existing in-flight journey instead of creating a new one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journeys_one_inflight_per_customer
  ON journeys (organization_id, customer_id)
  WHERE status IN ('pending', 'scoring');
