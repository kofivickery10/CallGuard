import csv, os

# Trust Point — Protection QA card.
#
# This mirrors the card Trust Point ACTUALLY RUN (scorecard v9 in production, as
# exported 2026-08-03), not the raw "QA Framework and Scoring Matrix June 2026"
# spreadsheet it started from. The two had drifted: during calibration the
# opening item was split into three observable acts ("introduced themselves",
# "stated they are from Trust Point", "explained the reason for the call"), the
# GP/1-in-10 item was split in two, and the three back-office `manual` items were
# retired with scripts/remove-manual-items.ts. Regenerating from the spreadsheet
# would have quietly undone all of that on the next import.
#
# NUMBERING. The numbers below are POSITIONS ON THE LIVE CARD as at v9 — the
# numbering Trust Point read off the app and use in correspondence ("take out
# point 3"). Retiring an item leaves a gap here on purpose, so those references
# keep resolving; positions in the generated CSV shift up and will not match.
# Quote labels, not numbers, when agreeing a change.
#
# Retired 2026-08-03 at Trust Point's request (see README): 3, 25, 26, 32, 33.

WFW = ("Statement must be present and convey the full regulatory meaning; flag if the "
       "wording materially deviates from the approved word-for-word script.")

# Extra scoring guidance, sent to the model separately from the description
# (scorecard_items.expectation). Written where the criterion needs a boundary the
# description alone does not give — almost always "this also counts" — so the
# scorer stops failing calls the firm is happy with. Every entry traces to Trust
# Point's 2026-08-03 review of live scoring.
EXPECTATIONS = {
 # Their "intro" can run ten minutes. The checkpoint is about whether the thing
 # was said, not where in the call it was said.
 4: ("Counts wherever in the call this is covered. There is no requirement for it to come early: the "
     "opening stage can run for several minutes, and covering it at the end of that is a pass. Judge "
     "only whether it was covered."),
 # Trust Point send the key facts by whatever route suits the client, so naming
 # email was never the point of the checkpoint.
 10: ("Any delivery route counts — email, post, or a portal — and so does telling the customer the "
      "documents will be sent to them without naming a route. Do not fail this because email was not "
      "specified."),
 # The recap is what matters; where it sits relative to the Health & Lifestyle
 # questions is not. Sales that needed no H&L section were being failed here.
 28: ("The recap must appear as the sale is being closed — after the application details were taken "
      "and before the adviser moves on to payment, documents and final confirmation. It does not have "
      "to follow the Health & Lifestyle questions, and a sale with no Health & Lifestyle section is "
      "not failed on that basis."),
 # Not every product is medically underwritten, so "the outcome" is sometimes
 # just "it is accepted and starting".
 30: ("Standard terms includes any immediate acceptance, such as a product with no medical "
      "underwriting where cover simply starts. Where the application had no underwriting outcome to "
      "give, the adviser confirming the cover is in place and when it starts is the outcome. Fail only "
      "where the customer was left not knowing where the application stands."),
 # Same allowance as 30, on the item that judges how the outcome was explained.
 31: ("Where the product carried no underwriting decision, confirming acceptance and the start date "
      "satisfies the on-risk path — there are no amended or rated terms to explain."),
}

# (num, label, description, section, item_type, branch, consent_gate, severity, ai_check)
R = [
 (1,"Introduced themselves by name","Did the adviser introduce themselves by name?","Intro","ai","",False,"low",""),
 (2,"Stated they are from Trust Point","Did the adviser state they are calling from Trust Point Mortgage and Protection Services?","Intro","ai","",False,"low",""),
 # 3 — "Explained the reason for the call" — RETIRED 2026-08-03: overlaps 4,
 # which asks the same question in more detail.
 (4,"Explained the call is to understand the situation and suitable cover","Did the adviser explain they are calling to understand the client's situation and see what cover may be suitable?","Intro","ai","",False,"low",""),
 (5,"Stated Trust Point is authorised and regulated by the FCA","Did the adviser state that Trust Point Mortgage and Protection Services are authorised and regulated by the FCA?","Regulatory (word-for-word)","ai","",False,"high",WFW),
 (6,"Confirmed fully advised, whole-of-market, no fee","Did the adviser confirm they work on a fully advised basis with all major insurers/lenders and do not charge a fee?","Regulatory (word-for-word)","ai","",False,"high",WFW),
 (7,"Gave the call-recording disclosure","Did the adviser confirm all calls are recorded for training and monitoring purposes?","Regulatory (word-for-word)","ai","",False,"high",WFW),
 (8,"Set expectations for the fact find","Did the adviser signpost that they would be asking questions about the client's circumstances in order to understand their needs?","Intro","ai","",False,"low",""),
 (9,"Informed customer of the services the company provides","Did the adviser inform the customer of the services the company provides while finalising details?","Regulatory (word-for-word)","ai","",False,"medium",WFW),
 (10,"Told customer the key facts document will be sent to them","Did the adviser say that if a policy is arranged, the key facts document and details of the service will be sent to the customer?","Regulatory (word-for-word)","ai","",False,"medium",WFW),
 (11,"Mentioned policy can be placed in Trust free of charge","Did the adviser mention the policy can be put into Trust free of charge where applicable?","Next steps","ai","",False,"low",""),
 (12,"Explained data sharing and asked 'is that alright?'","Did the adviser explain information is shared only with the insurer and external verification provider, never passed elsewhere, and ask if that is alright?","Regulatory (word-for-word)","ai","",False,"high",WFW),
 (13,"Obtained a clear 'yes' to information sharing","Did the adviser obtain an explicit 'yes' from the customer to the information-sharing statement before proceeding?","Consent (hard yes)","ai","",True,"critical",""),
 (14,"Covered cancellation rights and privacy policy","Did the adviser say the policy can be cancelled at any time and reference the privacy policy on the website?","Cancellation","ai","",False,"medium",""),
 (15,"Delivered the vulnerability / duty-of-care statement","Did the adviser deliver the duty-of-care statement, mention vulnerability, and offer the 'Support When You Need It Most' brochure?","Vulnerability (Consumer Duty)","ai","",False,"high",""),
 (16,"Summarised the client's main risks and confirmed agreement","Did the adviser summarise the client's main areas of concern/risk and confirm the client agrees before the recommendation?","Needs summary","ai","",False,"medium",""),
 (17,"Gave the recommendation and checked 'have I got that right?'","Did the adviser state the areas of concern / recommendation and check 'have I got that right?'","Recommendation (word-for-word)","ai","",False,"high",WFW),
 (18,"Obtained a clear 'yes' to the recommendation","Did the adviser obtain an explicit 'yes' confirming the recommendation before continuing?","Consent (hard yes)","ai","",True,"critical",""),
 (19,"Explained policy features and benefits","Did the adviser explain the product(s), insurer, cover amount, term, premium and why it fits the client's circumstances?","Features & benefits","ai","",False,"high",""),
 (20,"Gave the honesty/accuracy and non-disclosure warning","Did the adviser warn that questions must be answered honestly and accurately and that inaccuracies could invalidate the policy or affect a claim?","Regulatory (word-for-word)","ai","",False,"critical",WFW),
 (21,"Explained providers may contact the GP for a medical report","Did the adviser explain that the provider may contact the client's GP for a medical report?","Regulatory","ai","",False,"medium",""),
 (22,"Explained possible 1-in-10 application checks","Did the adviser explain that providers carry out random checks on a proportion of applications?","Regulatory","ai","",False,"medium",""),
 (23,"Sought consent for the insurer to contact the GP","Did the adviser ask whether the customer is happy for the provider to contact their GP if needed?","Consent","ai","",False,"high",""),
 (24,"Asked if the client wants to see the GP report first","Did the adviser ask whether the client wants to see a copy of any GP report before it is sent to the provider?","Consent","ai","",False,"medium",""),
 # 25 — "Allowed the customer to answer every H&L question" and
 # 26 — "Did NOT lead the customer in their H&L answers" — both RETIRED
 # 2026-08-03: Trust Point judged the Health & Lifestyle section too involved to
 # cover in this format for now. No H&L checkpoint remains on the card.
 (27,"Gave the wrap-up recap intro","Did the adviser signpost that they were moving into the wrap-up of the call?","Wrap-up","ai","",False,"low",""),
 (28,"Recapped the recommendation as the sale was closed","Did the adviser recap the recommendation (product, insurer, what it covers) at the point the sale was being closed?","Recommendation recap","ai","",False,"medium",""),
 (29,"Confirmed the recap still matches what the client wanted","Did the adviser confirm the recap is still clear and matches what the client wanted to achieve, with a firm 'yes'?","Consent (hard yes)","ai","",True,"high",""),
 (30,"Stated the outcome of the application","Did the adviser tell the customer the outcome of the application — accepted on standard terms, accepted on amended or rated terms, or referred for underwriting?","Policy outcome","ai","",False,"high",""),
 (31,"Explained the outcome correctly for the path taken","On risk: explained acceptance and any amended/rated terms and checked the client is happy. Referred: made clear the policy is NOT active yet, with no final decision/premium/start/payment date, and the possible outcomes.","Policy outcome","ai","",False,"high",""),
 # 32 — "Explained add-ons and key policy features" and
 # 33 — "Checked 'is that all clear?' on add-ons / key features" — both RETIRED
 # 2026-08-03: not every policy has add-ons and there is no rule that says which
 # do, so both failed sales that had nothing to explain. The recap (28) and the
 # cover/premium confirmation (34) cover whether the policy details were put to
 # the customer.
 (34,"Confirmed happy with cover, premium and everything applied for","Did the adviser confirm the client is happy with the cover, the premium and everything applied for, with a firm 'yes'?","Consent (hard yes)","ai","",True,"critical",""),
 (35,"Set up the Direct Debit and confirmed start & payment dates","Did the adviser take the sort code/account number, confirm the account is in the client's name with authority to set up DDs, and confirm the start date plus first and ongoing payment dates?","Direct Debit (On Risk)","ai","on_risk",False,"high",""),
 (36,"Took bank details making clear policy not active / no payment taken","Did the adviser take the sort code/account number for if the policy proceeds, while making clear the policy is not active yet and no payment will be taken unless accepted and started?","Direct Debit (Referred)","ai","referred",False,"high",""),
 (37,"Took the customer's preferred payment date","Did the adviser take the customer's preferred regular payment date (1st-28th of the month)?","Payment date","ai","",False,"medium",""),
 (38,"Confirmed documents by email and got a firm yes","Did the adviser confirm policy documents will be sent by email and obtain a firm 'yes'? Proceed only on a clear yes.","Documents","ai","",True,"high",""),
 (39,"Explained exclusions and 30-day cancellation rights","Did the adviser explain the policy may not pay out in some circumstances (e.g. suicide in first 12 months / inaccurate info) and that there are normally 30 days to cancel without penalty?","Exclusions & cancellation (word-for-word)","ai","",False,"high",WFW),
 (40,"Reassured on future support","Did the adviser reassure the client about ongoing support (personal broker, welcome pack by email, future cover review)?","Future support","ai","",False,"low",""),
 (41,"Asked for a Google review","Did the adviser ask the customer for a Google review (only where the customer was happy)?","Google review","ai","",False,"low",""),
 (42,"Made the friends & family referral ask","Did the adviser ask whether anyone else might benefit from a protection review and mention the £30 referral voucher?","Referral","ai","",False,"low",""),
 (43,"Explained placing the policy in Trust","For life cover, did the adviser explain putting the policy in Trust and its benefits (right beneficiaries, faster payout, potential IHT benefit)?","Policy in Trust (On Risk)","ai","on_risk",False,"medium",""),
 (44,"Arranged to contact the nominated trustee","Did the adviser arrange to contact the nominated trustee to explain their role and take a contact number?","Policy in Trust (On Risk)","ai","on_risk",False,"low",""),
 (45,"Raised will / estate planning where appropriate","Where the client has no will, did the adviser raise estate planning and offer a follow-up with an estate planning colleague?","Estate planning","ai","",False,"low",""),
 (46,"Confirmed the client is happy with the service","Did the adviser confirm the client is happy with the service / policy arranged today, with a firm 'yes'?","Final close (hard yes)","ai","",True,"high",""),
 (47,"Closed properly and invited final questions","Did the adviser explain they are about to start/submit the policy and invite any final questions before doing so?","Final close","ai","",False,"medium",""),
]

RETIRED = [3, 25, 26, 32, 33]

FIELDS = ['label','description','score_type','weight','severity','section','item_type','branch','expectation','ai_check','consent_gate']
rows=[]
for num,label,desc,section,itype,branch,consent,sev,aicheck in R:
    rows.append({
        'label':label,'description':desc,'score_type':'binary','weight':'1',
        'severity':sev,'section':section,'item_type':itype,'branch':branch,
        'expectation':EXPECTATIONS.get(num,''),'ai_check':aicheck,
        'consent_gate':'true' if consent else 'false',
    })

# A typo in an EXPECTATIONS key would silently attach the guidance to nothing, and
# the checkpoint it was written for would keep failing the calls it was written to
# stop failing. Same for a retired number that is still on the card.
present = {n for n, *_ in R}
if set(EXPECTATIONS) - present:
    raise SystemExit(f"EXPECTATIONS refers to item(s) not on the card: {sorted(set(EXPECTATIONS) - present)}")
if present & set(RETIRED):
    raise SystemExit(f"Retired item(s) still on the card: {sorted(present & set(RETIRED))}")

out=os.path.join(os.path.dirname(os.path.abspath(__file__)),'trustpoint-protection.csv')
with open(out,'w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=FIELDS,quoting=csv.QUOTE_MINIMAL)
    w.writeheader(); w.writerows(rows)

ai=[r for r in rows if r['item_type']=='ai']; manual=[r for r in rows if r['item_type']=='manual']
print(f"wrote {out}")
print(f"  {len(rows)} items: {len(ai)} AI, {len(manual)} manual")
print(f"  consent gates: {sum(1 for r in rows if r['consent_gate']=='true')}")
print(f"  word-for-word: {sum(1 for r in rows if r['ai_check'])}")
print(f"  on_risk: {sum(1 for r in rows if r['branch']=='on_risk')}, referred: {sum(1 for r in rows if r['branch']=='referred')}")
print(f"  expectations set: {sum(1 for r in rows if r['expectation'])}")
print(f"  live card v9 had 47; retired {len(RETIRED)} on 2026-08-03 ({', '.join(map(str, RETIRED))}) = {len(R)}")
