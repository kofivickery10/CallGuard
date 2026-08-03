-- Replace the boolean redaction exemption (065) with an explicit list of the
-- Deepgram redaction categories a tenant is permitted to keep in the clear.
--
-- WHY THE BOOLEAN WAS WRONG
--
-- 065 modelled this as all-or-nothing: either redact everything, or drop health
-- AND identity redaction together. Reconciliation work against real insurer
-- applications showed those are two different decisions with two different
-- legal bars:
--
--   * Identity fields (name, dob, address, email) are ordinary personal data,
--     Article 6. A firm reconciling "is the DOB on this application what the
--     customer actually said" needs them, and the justification is routine.
--   * Health (phi) is special-category, Article 9. Needs a DPIA and a
--     condition under Art 9(2) / DPA 2018 Sch 1.
--
-- A single flag forced a tenant who only needed identity checks (e.g. verifying
-- occupation and date of birth on a MetLife EverydayProtect summary, which
-- contains no health questions at all) to also store every health disclosure in
-- the clear. That is a failure of data minimisation, and it made the easier
-- half of the feature wait on the harder half's paperwork.
--
-- WHY pci CANNOT BE LISTED
--
-- The CHECK constraint below makes 'pci' structurally impossible to permit, so
-- payment-card redaction is enforced by the schema rather than by a convention
-- in application code. Card data has no legitimate reason to exist unredacted
-- in this system, DPIA or not, and this keeps the platform out of PCI DSS
-- scope.
--
-- A NOTE ON 'numbers' — PERMITTED, BUT NOT WITHOUT A COMPENSATING CONTROL
--
-- 'numbers' is listable, but read services/transcription.ts before permitting
-- it for any tenant. It is the category actually catching spoken bank details:
-- the per-entity account_number/numerical_pii tokens are unreliable for numbers
-- read aloud (a sort code spoken as "one one, oh six" slips past them), which
-- was verified against a live call. Permitting 'numbers' therefore reopens a
-- real leak path for sort codes and account numbers.
--
-- It is listable because the numeric answers are exactly the ones worth
-- reconciling (cigarettes per day, blood-pressure readings, weight, units of
-- alcohol), all of which redact to placeholders while 'numbers' is on. Before
-- permitting it, an in-house digit-run redaction must be in place to strip
-- bank-length digit sequences while preserving short numeric answers.
--
-- MIGRATION PATH (expand, not replace)
--
-- pii_redaction_exempt is retained as deprecated and backfilled from, so a
-- rolling deploy cannot leave old code selecting a dropped column. Remove it in
-- a later migration once no code references it.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS pii_unredacted_categories TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: any org previously carrying the blanket exemption keeps exactly the
-- categories that flag used to drop (health + identity), so behaviour is
-- unchanged for them. 'numbers' is deliberately NOT included: the old flag kept
-- it redacted, and permitting it now requires the compensating control above.
UPDATE organizations
   SET pii_unredacted_categories = ARRAY[
         'phi',
         'name', 'name_given', 'name_family',
         'dob',
         'email_address',
         'location_address', 'location_city', 'location_state', 'location_zip', 'location_country'
       ]
 WHERE pii_redaction_exempt = true
   AND pii_unredacted_categories = '{}';

-- Only real Deepgram redaction categories, and never 'pci'.
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_pii_unredacted_categories_valid;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_pii_unredacted_categories_valid CHECK (
    pii_unredacted_categories <@ ARRAY[
      'phi', 'numbers',
      'name', 'name_given', 'name_family',
      'dob',
      'email_address',
      'location_address', 'location_city', 'location_state', 'location_zip', 'location_country'
    ]::TEXT[]
  );

COMMENT ON COLUMN organizations.pii_unredacted_categories IS
  'Deepgram redaction categories this tenant may keep in the clear. Empty = redact everything (the default). Never contains pci (enforced by CHECK). Set only by superadmin with a recorded DPIA justification in pii_redaction_exempt_note.';

COMMENT ON COLUMN organizations.pii_redaction_exempt IS
  'DEPRECATED (079) — superseded by pii_unredacted_categories. Retained only so a rolling deploy cannot break on a dropped column. Drop once unreferenced.';
