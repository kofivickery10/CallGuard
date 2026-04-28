ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'growth'
    CHECK (plan IN ('starter','growth','pro'));

ALTER TABLE call_scores ADD COLUMN coaching JSONB;
