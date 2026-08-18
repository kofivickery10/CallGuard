-- Target tiering: ranking a prospect by buying intent, not just recording
-- that it exists (see enrich-prospects-fca.ts's assignTargetTier and
-- docs/prospect-sweep.md).
--
-- Purely additive: production already holds ~100 prospects rows, so this
-- column is nullable, nothing rewrites existing data, and it does not go
-- NOT NULL without a default.
--
-- Same firm-level-only rule as migrations 102/103/104: this describes the
-- company's regulatory situation, never a person, so it needs no LIA.
ALTER TABLE prospects
    -- Ranking order, most-promising first: 'transition' > 'established_da' >
    -- 'appointed_rep' > 'startup'. 'unknown' is not ranked — it means this
    -- run's data couldn't place the firm in any of the other four.
    --   - transition: confirmed former Appointed Representative (a
    --     Companies-House-number match — see former_ar/migration 103) now
    --     Authorised. Highest intent: it already has a book, advisers and
    --     revenue, and has just inherited the compliance function its
    --     principal used to run for it for free.
    --   - established_da: Authorised, holds its own permissions, and was
    --     authorised more than 24 months ago. Owns its own compliance and
    --     has volume/budget to spend on it, but no trigger event pushing it
    --     to act now.
    --   - appointed_rep: currently an Appointed Representative. Real pain
    --     (it must be able to evidence call monitoring to pass its
    --     principal's own audit) but no trigger event, and its principal may
    --     mandate its own tooling instead of letting the AR choose.
    --   - startup: Authorised within the last 24 months, with no prior AR
    --     record found anywhere. Owns its own compliance already, but may
    --     have no book, no advisers and no budget yet.
    --   - unknown: could not classify. Deliberately NOT the same bucket as
    --     startup — "no prior AR record found" (startup) is a fact about the
    --     firm; "we could not tell" (unknown, e.g. no authorised-since date
    --     on file and no former-AR evidence either) is a fact about what
    --     this run's data could establish. Collapsing the two would lose
    --     that distinction and make "startup" an unreliable signal.
    -- This is a SNAPSHOT recomputed from whatever the most recent enrichment
    -- run found — not a live derivation — so, like every other
    -- Register-derived column on this table, it can go stale between
    -- refreshes and is only as current as the last time this firm was
    -- enriched.
    ADD COLUMN IF NOT EXISTS target_tier TEXT
        CHECK (target_tier IS NULL OR target_tier IN (
            'transition', 'established_da', 'appointed_rep', 'startup', 'unknown'
        ));
