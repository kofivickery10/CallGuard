-- Map Trust Point's Zoho Deal "Stage" picklist onto the scorecard's scoring
-- branches, so a sale's branch comes from the CRM's own record of whether the
-- policy went on risk rather than from matching phrases in the transcript.
--
-- Every "Referred*" state means the policy is NOT on risk:
--   Referred                        - with the underwriters, no decision yet
--   Referred - Decision Back        - underwriter replied; nothing started yet
--   Referred - NTU                  - customer did not take it up
--   Referred - Decision Back - NTU  - decision came back, customer declined it
--
-- The two NTU states go in no_score_crm_values, not crm_values: the customer
-- walked away, so there is no completed sale and scoring one would put breaches
-- on the register for business that never existed. Those sales are skipped at
-- assembly — before any audio is fetched or transcribed.
--
-- Matching is exact (case- and whitespace-insensitive), NOT substring: these
-- values contain one another, and a substring match on "Referred" would also
-- swallow a hypothetical "Not Referred". The cost of exactness is that a new
-- picklist value is unmapped until added here — which now raises an ops alert
-- and a banner on the sale rather than silently defaulting to on_risk.
--
-- Keywords are retained as a fallback for sales with no CRM stage at all
-- (manual journeys, or a Deal created after the sale trigger fired).
UPDATE scorecards
   SET branch_config = jsonb_build_object(
         'detect',   'crm_field',
         'branches', jsonb_build_array('on_risk', 'referred'),
         'keywords', jsonb_build_object(
           'referred', jsonb_build_array(
             -- Widened from the original five literals, which matched none of
             -- what advisers actually say. Kept deliberately conservative: a
             -- false 'referred' is safer than a false 'on_risk', because the
             -- on-risk branch raises Trust and Direct-Debit breaches against a
             -- policy that never started.
             'referred for underwriting',
             'referred to the underwriters',
             'sent off to the underwriters',
             'sent it off to the underwriters',
             'leave it to the underwriter',
             'leave it to the medical underwriter',
             'with the underwriters',
             'not active yet',
             'no final decision',
             'no immediate start',
             'nothing''s going to start',
             'wait for them to accept',
             'waiting for them to accept',
             'hasn''t declined'
           )
         ),
         'crm_values', jsonb_build_object(
           'on_risk',  jsonb_build_array('On Risk'),
           'referred', jsonb_build_array(
             'Referred',
             'Referred - Decision Back'
           )
         ),
         'no_score_crm_values', jsonb_build_array(
           'Referred - NTU',
           'Referred - Decision Back - NTU'
         )
       ),
       updated_at = now()
 WHERE id = '56516d2d-cbc7-4405-8147-14af5b644c3c';
