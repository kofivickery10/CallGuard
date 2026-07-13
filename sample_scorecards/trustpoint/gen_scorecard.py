import csv, os

WFW = ("Statement must be present and convey the full regulatory meaning; flag if the "
       "wording materially deviates from the approved word-for-word script.")

# (num, label, description, section, item_type, branch, consent_gate, severity, ai_check)
# Grounded in "QA Framework and Scoring Matrix June 2026" — 47 items, equal weight.
R = [
 (1,"Introduced self, Trust Point and reason for call","Did the adviser introduce themselves by name, state they are from Trust Point Mortgage and Protection Services, and explain the call is to review protection needs?","Intro","ai","",False,"low",""),
 (2,"Explained the call is to understand the situation and suitable cover","Did the adviser explain they are calling to understand the client's situation and see what cover may be suitable?","Intro","ai","",False,"low",""),
 (3,"Stated Trust Point is authorised and regulated by the FCA","Did the adviser state that Trust Point Mortgage and Protection Services are authorised and regulated by the FCA?","Regulatory (word-for-word)","ai","",False,"high",WFW),
 (4,"Confirmed fully advised, whole-of-market, no fee","Did the adviser confirm they work on a fully advised basis with all major insurers/lenders and do not charge a fee?","Regulatory (word-for-word)","ai","",False,"high",WFW),
 (5,"Gave the call-recording disclosure","Did the adviser confirm all calls are recorded for training and monitoring purposes?","Regulatory (word-for-word)","ai","",False,"high",WFW),
 (6,"Set expectations for the fact find","Did the adviser explain they will ask about circumstances, commitments, income, family and existing cover before advising?","Intro","ai","",False,"low",""),
 (7,"Full Fact Find completed and recorded on the CRM","Was a full Fact Find completed and recorded on the CRM with sufficient information to justify the recommendation?","Back office (manual)","manual","",False,"high",""),
 (8,"Comprehensive, justified recommendation on file","Is there a comprehensive recommendation on file that meets the customer's needs and is justified by the fact find?","Back office (manual)","manual","",False,"high",""),
 (9,"Informed customer of the services the company provides","Did the adviser inform the customer of the services the company provides while finalising details?","Regulatory (word-for-word)","ai","",False,"medium",WFW),
 (10,"Told customer key facts and services sent by email","Did the adviser say that if a policy is arranged, the key facts document and services will be sent by email?","Regulatory (word-for-word)","ai","",False,"medium",WFW),
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
 (21,"Explained possible GP contact / 1-in-10 checks","Did the adviser explain providers may contact the GP for a medical report or run 1-in-10 application checks?","Regulatory (word-for-word)","ai","",False,"medium",WFW),
 (22,"Sought consent for the insurer to contact the GP","Did the adviser ask whether the customer is happy for the provider to contact their GP if needed?","Consent","ai","",False,"high",""),
 (23,"Asked if the client wants to see the GP report first","Did the adviser ask whether the client wants to see a copy of any GP report before it is sent to the provider?","Consent","ai","",False,"medium",""),
 (24,"Allowed the customer to answer every H&L question","Did the adviser allow the customer to answer every Health & Lifestyle question themselves?","Health & Lifestyle","ai","",False,"high",""),
 (25,"All customer disclosures input accurately","Were all customer disclosures input accurately into the application (data-entry accuracy check)?","Back office (manual)","manual","",False,"high",""),
 (26,"Did NOT lead the customer in their H&L answers","Did the adviser avoid leading the customer in their Health & Lifestyle answers? Fail if the adviser steered or suggested answers.","Health & Lifestyle (integrity)","ai","",False,"critical",""),
 (27,"Gave the wrap-up recap intro","Did the adviser introduce the wrap-up (recap recommendation, confirm outcome, confirm what is being put in place, explain next steps)?","Wrap-up","ai","",False,"low",""),
 (28,"Recapped the recommendation after the H&L application","Did the adviser recap the recommendation (product, insurer, suitability) after completing the Health & Lifestyle questions?","Recommendation recap","ai","",False,"medium",""),
 (29,"Confirmed the recap still matches what the client wanted","Did the adviser confirm the recap is still clear and matches what the client wanted to achieve, with a firm 'yes'?","Consent (hard yes)","ai","",True,"high",""),
 (30,"Clearly stated the application outcome","Did the adviser clearly state the application outcome (accepted on standard/amended terms, or referred for underwriting)?","Policy outcome","ai","",False,"high",""),
 (31,"Explained the outcome correctly for the path taken","On risk: explained acceptance and any amended/rated terms and checked the client is happy. Referred: made clear the policy is NOT active yet, with no final decision/premium/start/payment date, and the possible outcomes.","Policy outcome","ai","",False,"high",""),
 (32,"Explained add-ons and key policy features","Did the adviser explain any add-ons (e.g. waiver of premium) and key points such as exclusions, moratorium, waiting/deferred period or special limitations?","Add-ons & key features","ai","",False,"high",""),
 (33,"Checked 'is that all clear?' on add-ons / key features","Did the adviser check the customer understood the add-ons and key features ('is that all clear?') with a firm 'yes'?","Consent (hard yes)","ai","",True,"medium",""),
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

FIELDS = ['label','description','score_type','weight','severity','section','item_type','branch','expectation','ai_check','consent_gate']
rows=[]
for num,label,desc,section,itype,branch,consent,sev,aicheck in R:
    rows.append({
        'label':label,'description':desc,'score_type':'binary','weight':'1',
        'severity':sev,'section':section,'item_type':itype,'branch':branch,
        'expectation':'','ai_check':aicheck,'consent_gate':'true' if consent else 'false',
    })

import os
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
print(f"  Framework target: 47 items = 38 AI + 9 manual")
