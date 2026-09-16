import csv, os

# Service Box — New Business call monitoring card.
#
# Built from "Call Monitoring Guidelines - New Business.xlsb" (received
# 2026-09-14): 11 elements, each with a weighting and an Autofail Y/N flag,
# PASS = 90%, and per-element requirements written separately for 7 products.
#
# HOW THEIR MATHS IS PRESERVED
#
# Their 4 soft elements are 5.75% each; their 7 auto-fail elements are 11% each.
# scorecard_items.weight is NUMERIC(3,2) (max 9.99), so the card uses the same
# ratio on a smaller scale: soft = 0.69, auto-fail element = 1.32 (0.69:1.32 is
# exactly 5.75:11, and the whole card sums to 12.00).
#
# Auto-fail elements are split into separately observable acts, with the
# element's 1.32 divided evenly across its parts (2 parts = 0.66, 3 = 0.44).
# Every part is severity=critical, so missing ANY part fails the call, exactly
# as missing the element does on their sheet. Splitting changes only the
# displayed percentage on a call that has already failed. It matters because
# compound checks were the main cause of unstable verdicts when Trust Point's
# card was measured (see services/checkpoint-quality.ts).
#
# Soft elements are deliberately NOT split. On their sheet a soft element is
# all-or-nothing at 5.75%, so one soft miss passes (94.25%) and two fail
# (88.5%). Splitting one into parts would let a partial miss cost less and
# could turn a fail into a pass.
#
# REVISED 16 SEP 2026 against the September 2026 appliance script and their
# three sample sales (see README "Test run on their calls").
#
# NO BRANCHES, ON PURPOSE
#
# Additional Cover Appliances is the only product where elements are N/A (Good
# Working Order, Mandatory Confirmation). A branch would score those as N/A
# properly, but score-prospect-calls.ts never sets a branch_config, and with no
# branch_config an item tied to a branch is N/A on EVERY call — which would
# silently drop two auto-fail checks from every demo call. Instead those two
# items tell the scorer to mark them met on an Additional Cover call. Pass/fail
# is identical either way; only the displayed percentage differs slightly.
#
# Regenerate: python3 gen_scorecard.py

COMPANY = "Service Box"  # confirm the trading name used in their introduction

SOFT = 0.69
AUTOFAIL = 1.32

WFW_FINAL = ("Statement must be present and convey that the plan is discretionary and is not insurance; "
             "flag if the wording materially deviates from the approved final statement in the script.")

ADD_COVER_NA = ("Additional Cover Appliances is a separate product sold on its own 'Additional Cover Protection "
                "Plan' script; on that product this check is not required, so mark it met and say so. Adding "
                "appliances to an existing plan, upgrading, downgrading or restarting an appliance plan is an "
                "Appliance Protection sale, and this check applies in full.")

# Deepgram replaces dates, prices and account digits with numbered tags before
# scoring. The first local run failed a stated first payment date as "vague"
# because it read "[DATE_1]", so the checks that turn on those values say it.
TAGS = ("Dates, amounts and account digits appear in the transcript as tags such as [DATE_1], [MONEY_2] or "
        "[BANK_ACCOUNT_1]: a tag means the agent did state that value.")

YES = ("A short reply such as \"yeah\", \"yes\" or \"correct\" counts as confirmation, even alongside filler words; "
       "a reply that trails off, shows the customer is unsure, or does not answer the question does not.")

# (element, parts) — element order follows their sheet.
# part = (label, description, item_type, consent_gate, vulnerability_related, expectation, ai_check)
ELEMENTS = [
 ("Introduction", False, [
  ("Introduced themselves and " + COMPANY + " and completed the DPA check",
   "Did the agent give their own name and the company name, and ask the customer for two pieces of "
   "information to pass data protection before discussing details held about them?",
   "ai", False, False,
   "As per the Introduction section of the script for the product being sold. The agent's name and the "
   "company name are required on every call. The data protection check needs two pieces of identifying information from the customer "
   "before held details are discussed: first line of address and postcode count as two, as do surname and "
   "postcode. Asking for the customer by name at the start does not replace the check, but a full name is "
   "not required when two other pieces were given. Judge that the agent asked for two pieces and the "
   "customer answered: a single location tag in the reply can hold both address and postcode.", ""),
 ]),
 ("Benefit & Replacement Terms", False, [
  ("Explained the plan's features and customer benefits",
   "Did the agent explain the features of the plan and what the customer gets from it, as set out in the "
   "'Pitch / Uncover the need' section of the script for the product being sold?",
   "ai", False, False,
   "The features and benefits named in that product's script must be covered in substance; exact wording "
   "is not required. Naming the plan without saying what it provides is a fail.", ""),
 ]),
 ("Duration & Costs", True, [
  ("Stated the plan duration, monthly cost and total cost",
   "Did the agent tell the customer the plan runs for one year and state both the monthly cost and the "
   "total cost of the plan?",
   "ai", False, False,
   "All three are needed: the one-year duration (12 monthly payments, or cover running from today to a date a "
   "year away, counts), the monthly amount and the total cost. The total must be stated as an amount; a "
   "monthly amount and a duration alone do not meet this. " + TAGS + " For a one-off "
   "Boiler Service Only or Heat Pump Service Only sale there is no monthly plan, and stating the full "
   "one-off price meets this.", ""),
  ("Made the first payment date clear",
   "Did the agent tell the customer the date the first monthly payment will be taken?",
   "ai", False, False,
   "Saying when the first payment will come out, e.g. \"no payment until the [DATE_1]\", meets this. " + TAGS +
   " For a one-off Boiler Service Only or Heat Pump Service Only sale, the full payment must be taken "
   "during this call instead; setting up a monthly Direct Debit for a one-off service is a fail.", ""),
 ]),
 ("Exclusions", True, [
  ("Explained the plan's exclusions, and the contribution level on plans that have one",
   "Did the agent explain the exclusions of the plan as set out in the script for the product being sold "
   "and, on Boiler, Heat Pump, Homecare and Plumbing & Drains plans, confirm the contribution level the "
   "customer has selected?",
   "ai", False, False,
   "Script section by product: Appliance and Additional Cover Appliances, 'Pitch / Uncover the need'; "
   "Boiler, 'Boiler Product Information'; Heat Pump, Homecare, Plumbing & Drains and Hot Water Cylinder, "
   "'Main Exclusions'. Leaving out an exclusion listed in that section is a fail. Appliance, Additional "
   "Cover Appliances and Hot Water Cylinder plans have no contribution level, so the exclusions alone "
   "meet this on those plans. Appliance plans come in two pricings, and either is a pass: on Standard "
   "pricing the agent lists damage caused by accident as an exclusion; on Dynamic pricing accidental "
   "damage is covered, so the agent leaves it out of the exclusions and may say the plan covers damage. "
   "Do not fail an appliance plan because the pricing type was not named.", ""),
 ]),
 ("Good Working Order", True, [
  ("Confirmed the items to be protected are in good working order",
   "Did the agent get the customer's confirmation that the items to be protected are in good working "
   "order with no current faults, during the sale and again in the final statement?",
   "ai", True, False,
   "Appliance, Boiler, Heat Pump and Homecare plans need two separate confirmations: one during the sale "
   "and one repeated in the final statement; a single confirmation is a fail. The first can be the agent "
   "checking earlier in the call that the items are working with no problems, as long as the customer "
   "answers; on a call to an existing customer, checking that the appliances they already have covered are "
   "working counts, even when further appliances are then added. " + YES + " For Homecare the "
   "confirmation covers the boiler, plumbing, drains and home electrics. Plumbing & Drains and Hot Water "
   "Cylinder plans need one confirmation, in the final statement, that there are no current faults with "
   "the plumbing and drains or the hot water cylinder. " + ADD_COVER_NA, ""),
 ]),
 ("Mandatory Confirmation", True, [
  # Split 16 Sep 2026: as one check covering three statements, the production run
  # passed a call that never mentioned the warranty (the local run had failed it).
  ("Confirmed the items are not covered elsewhere and are for domestic use only",
   "Did the agent get the customer's confirmation that the items to be protected are not covered "
   "elsewhere and, on Appliance, Boiler and Heat Pump plans, that they are used for domestic purposes only?",
   "ai", True, False,
   "By product: Appliance, Boiler and Heat Pump, not covered elsewhere and domestic use only; Homecare, not "
   "covered elsewhere for the boiler, plumbing, drains and home electrics; Plumbing & Drains and Hot Water "
   "Cylinder, not covered elsewhere. The manufacturer's warranty is scored by a separate check; do not "
   "consider it here. " + YES + " " + ADD_COVER_NA, ""),
  ("Confirmed the appliances are outside the manufacturer's warranty",
   "On an Appliance plan, did the agent get the customer's confirmation that the appliances to be "
   "protected are outside the manufacturer's warranty?",
   "ai", True, False,
   "The agent must mention the manufacturer's warranty (e.g. \"outside of the manufacturer's warranty\" or "
   "\"out of warranty\") and the customer must confirm. Confirming only that the items are not covered "
   "elsewhere and for domestic use does not meet this: quote the confirmation and say whether the "
   "warranty was mentioned. Boiler, Heat Pump, Homecare, Plumbing & Drains and Hot Water Cylinder plans "
   "have no warranty requirement: mark this met and say so. " + YES + " " + ADD_COVER_NA, ""),
 ]),
 ("DD Guarantee & Cancellation Period", False, [
  ("Offered the Direct Debit guarantee, checked the account, and gave the 14-day cancellation period",
   "Did the agent offer to read the Direct Debit guarantee and confirm the Direct Debit details, check "
   "the account with the customer, and tell the customer about the 14-day cancellation period?",
   "ai", False, False,
   "Offering to read the guarantee counts, even if the customer declines it or asks for it in the post. "
   "Account check: where the account is already held, the agent confirms the account ending digits with "
   "the customer; where new account details are taken, the agent confirms the customer is the only person "
   "required to authorise Direct Debits on it. Either check meets the account part. " + TAGS + " Judge "
   "whether the check was carried out, not whether the digits matched. Telling the customer they have 14 "
   "days to change their mind or cancel (a \"cooling off\" period, sometimes transcribed as \"calling off\") "
   "meets the cancellation part. For a "
   "one-off service paid in full on the call there is no Direct Debit, and the 14-day cancellation period "
   "alone meets this.", ""),
 ]),
 ("Plan Set Up & Commitments", True, [
  ("Asked for or confirmed the customer's email, with post only at the customer's request",
   "Did the agent ask for or confirm the customer's email address for the plan documents, and only "
   "arrange postal documents if the customer asked for them?",
   "ai", False, False,
   "Asking for the email address, or confirming one already held, meets the email part; asking whether "
   "the customer has an email address counts. Post is customer led when the customer asked for it or "
   "said they have no email or cannot use it; sending documents by post in that case is correct. The "
   "agent proposing post before asking about email is a fail. Email addresses appear as tags such as "
   "[EMAIL_ADDRESS_1], so judge whether it was asked for or confirmed.", ""),
  ("Plan set up correctly and call commitments carried out",
   "Checked by the QA team against the customer's record: the plan was set up with the correct items "
   "covered, the Direct Debit is on the agreed date, and the agent carried out what they committed to on "
   "the call.",
   "manual", False, False, "", ""),
 ]),
 ("Agent Conduct", False, [
  ("Was polite, courteous and professional",
   "Was the agent polite and professional throughout, attentive to what the customer needed, and free "
   "of sarcasm, rudeness or unhelpfulness?",
   "ai", False, False,
   "Fail only on a specific moment you can quote: sarcasm, rudeness, dismissing a concern or request, or "
   "refusing to help. Where the customer mentions a difficulty, some acknowledgement of it is expected. A "
   "brisk, plain manner is not a fail.", ""),
 ]),
 ("True & Factual", True, [
  ("Gave only true and factual information",
   "Was everything the agent told the customer about the plan, its cover, costs and terms consistent "
   "with the product script and plan information?",
   "ai", False, False,
   "Fail only on a specific statement that contradicts the script or plan information, and quote it. Do "
   "not fail for something left out; omissions are scored by the other checks.", ""),
  ("Answered the customer's questions without deflecting",
   "When the customer asked a question, did the agent answer it, or acknowledge it and say what would be "
   "done, rather than ignoring or deflecting it?",
   "ai", False, False,
   "If the customer asked no questions, this is met. A short, direct answer meets this. Fail only where "
   "you can quote a specific question the agent ignored or moved on from without answering; a garbled "
   "transcript is not a reason to fail.", ""),
  ("Followed the vulnerability protocol when the customer showed signs of vulnerability",
   "If the customer showed a sign of potential vulnerability, did the agent acknowledge it and follow "
   + COMPANY + "'s vulnerability protocol?",
   "ai", False, True,
   "Signs include confusion about what they are agreeing to, memory difficulty, a health condition or "
   "disability that affects their decisions, relying on a carer or someone else for money matters, "
   "bereavement, serious illness, or financial difficulty. Being busy, distracted, abroad, short-tempered, "
   "or unsure of an appliance's make, age or price is not on its own a sign of vulnerability, and a "
   "garbled or mis-transcribed line is not evidence of confusion. If the "
   "customer showed no such sign, this is met. Carrying on with the sale as normal after a clear sign, "
   "without checking the customer understands and wants to go ahead, is a fail; quote the sign.", ""),
 ]),
 ("Final Statement", True, [
  ("Read the 'discretionary, not insurance' statement",
   "Did the agent read the mandatory final statement that the plan is discretionary and is not an "
   "insurance product?",
   "ai", False, False, "", WFW_FINAL),
  ("Checked the customer was happy with everything on the call",
   "Did the agent ask the customer whether they were happy with everything covered on the call today?",
   "ai", False, False,
   "The script's wording is \"just to confirm you're happy with everything I've mentioned today?\"; a question "
   "with the same meaning counts. Asking whether the customer has any further questions, or whether they "
   "are happy to go ahead or to use an account, does not.", ""),
 ]),
]

HEADER = ["label", "description", "score_type", "weight", "severity", "section", "item_type",
          "expectation", "ai_check", "consent_gate", "vulnerability_related"]

rows = []
for element, autofail, parts in ELEMENTS:
    element_weight = AUTOFAIL if autofail else SOFT
    part_weight = round(element_weight / len(parts), 2)
    # Each split must divide exactly, or the element's share of the card drifts.
    assert abs(part_weight * len(parts) - element_weight) < 1e-9, (element, part_weight)
    for label, desc, item_type, consent, vuln, expectation, ai_check in parts:
        for field in (label, desc, expectation, ai_check):
            # onboard-tenant.ts splits the file on newlines before parsing quotes.
            assert "\n" not in field, label
        rows.append([label, desc, "binary", f"{part_weight:.2f}",
                     "critical" if autofail else "medium", element, item_type,
                     expectation, ai_check, "true" if consent else "false",
                     "true" if vuln else "false"])

total = sum(float(r[3]) for r in rows)
assert abs(total - 12.0) < 1e-9, total
assert sum(1 for e in ELEMENTS if e[1]) == 7 and sum(1 for e in ELEMENTS if not e[1]) == 4

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "servicebox-new-business.csv")
with open(out, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(HEADER)
    w.writerows(rows)
print(f"wrote {len(rows)} checks ({sum(1 for r in rows if r[6] == 'manual')} manual) to {out}")
