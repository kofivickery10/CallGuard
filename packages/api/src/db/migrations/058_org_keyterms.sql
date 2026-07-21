-- Per-tenant Deepgram keyterm boosting.
--
-- Replaces the global DOMAIN_KEYTERMS list in services/transcription.ts, which
-- hardcoded protection-insurance vocabulary (and the tenant name "Trust Point")
-- into every tenant's transcription. Domain vocabulary is tenant config, not
-- product code: each org now carries its own keyterm list, boosted ahead of a
-- small industry-neutral core (identity/verification + cross-sector FCA terms).
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS keyterms TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: orgs in the protection/insurance/mortgage advice space keep the
-- vocabulary that used to be boosted globally, so their transcription accuracy
-- does not regress when the global list is trimmed. Matched on the org's
-- self-described industry; only fills empty lists (idempotent, never clobbers).
UPDATE organizations
   SET keyterms = ARRAY[
     -- Protection products & features
     'life cover', 'level term', 'decreasing term', 'whole of life',
     'critical illness', 'critical illness cover', 'income protection',
     'family income benefit', 'waiver of premium', 'total permanent disability',
     'terminal illness', 'sum assured', 'survival period', 'deferred period',
     'own occupation', 'any occupation', 'guaranteed premiums',
     'reviewable premiums', 'indexation', 'in trust', 'beneficiaries',
     'underwriting',
     -- Mortgage
     'mortgage', 'remortgage', 'repayment', 'interest only', 'fixed rate',
     'loan to value', 'decision in principle', 'affordability', 'stamp duty',
     -- Sector-specific regulatory vocabulary
     'ICOBS', 'COBS', 'MCOB', 'demands and needs', 'fact find',
     'attitude to risk', 'capacity for loss', 'CIDRA', 'IPID',
     -- Common UK protection insurers / providers
     'Aviva', 'Legal and General', 'Royal London', 'Vitality', 'Zurich',
     'AIG', 'LV', 'Guardian', 'Scottish Widows', 'Aegon'
   ]
 WHERE keyterms = '{}'
   AND (industry ILIKE '%protection%'
     OR industry ILIKE '%insurance%'
     OR industry ILIKE '%mortgage%');
