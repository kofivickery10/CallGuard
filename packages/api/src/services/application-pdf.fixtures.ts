/**
 * Text fixtures taken from two real insurer application packs, reduced to the
 * structures the parser has to cope with. Customer details are replaced with
 * obvious placeholders — no real personal data lives in the repo.
 *
 * Both preserve the awkward parts of real extractor output: page footers and
 * document identifiers interleaved with content, the surrounding pack documents
 * that must NOT be read (covering letter, consent form, quote, commission
 * schedule), conditional follow-up questions, and — in the summary sheet —
 * two-column interleaving that splits labels across lines.
 */

/**
 * Royal London Personal Menu Plan: a 29-page pack whose application form is
 * pages 10 to 25. Everything before APPLICATION FORM and after YOUR PERSONAL
 * QUOTE is a different document.
 */
export const ROYAL_LONDON_PACK = `
protectionhelp@royallondon.com
www.royallondon.com
30 July 2026
Application number: 900000001
Applicant: sample applicant
Important information about your client's application
Here's a copy of your client's application for your records.
EX004A / 00000000-1111-2222-3333-444444444444
996860862 / I0R0
The Royal London Mutual Insurance Society Limited is authorised by the Prudential Regulation Authority.
Registered in England and Wales number 99064.

Protection Portfolio
P8B022
ACCESS TO MEDICAL REPORTS
Application for protection
Your plan number 900000001
We may need to get medical reports to support your application.
page 1 of 3

PERSONAL MENU PLAN
CLIENT REVIEW
Please return this form after you've checked that the information supplied is accurate.
Page within the application form
Question within the application form
Confirmation form
page 1 of 2

PERSONAL MENU PLAN
APPLICATION FORM
Important information for customers
We've received an application for a protection plan.
Application form
page 1 of 16
EX004A / 00000000-1111-2222-3333-444444444444

Important information for financial advisers
Adviser name: Mr sample adviser
Company name: Sample Firm
Application number: 900000001 Initial decision: NON-STANDARD
Application form
page 2 of 16

ABOUT THE PERSON COVERED
Your name: Mr sample applicant
Your contact details
Daytime phone number: +440000000000
Evening phone number: Unanswered

WE NEED TO ASK YOU SOME QUESTIONS ABOUT YOUR PREVIOUS
APPLICATIONS AND COVER
Do you have an existing plan or application with Royal London?
Royal London includes Bright Grey, Scottish Provident and Pegasus. Please include in-force plans as well as any previous
applications which didn't go in force or that's pending.
Your answer(s):
No

WE NEED TO ASK YOU SOME QUESTIONS ABOUT YOUR LIFESTYLE
What is your height?
Your answer(s):
1.75m or 5 feet 9 inches

What is your weight?
If you're pregnant, please tell us your weight immediately before your pregnancy.
Your answer(s):
111.1kg or 17 stone 7 pounds

Have you smoked, vaped, used e-cigarettes, tobacco or nicotine products in the last 12 months?
Please click on Quote to change this answer.
Your answer(s):
No

Have you ever smoked, vaped, used e-cigarettes, tobacco or nicotine products?
Answer Yes if you have used them even on an occasional basis.
Your answer(s):
Yes

When did you last smoke, vape, use e-cigarettes, tobacco or nicotine products?
Your answer(s):
1986

Which of the following products did you use on a daily basis before stopping?
Please select all that apply...
● Cigarettes
● Cigars
● Pipes
● Nicotine products
Your answer(s):
Cigarettes

How many cigarettes did you use on a daily basis before stopping?
Your answer(s):
50
Application form
page 5 of 16

How many units of alcohol do you drink in a typical week?
1 pint of beer = 2 units 1 glass of wine (175ml) = 2 units 1 measure of spirits = 1 unit
Your answer(s):
1

Have you ever been medically advised to reduce your alcohol consumption?
This includes being referred for treatment or specialist support.
Your answer(s):
No

WE NEED TO ASK YOU SOME QUESTIONS ABOUT YOUR OCCUPATION AND
TRAVEL
What is your current job?
Go back to the Quote section if you need to amend this.
Your answer(s):
HGV Driver

In pounds, how much did you earn over the last 12 months before tax?
Please click on Quote to change this answer.
Your answer(s):
44000

WE NEED TO ASK YOU SOME QUESTIONS ABOUT YOUR MENTAL HEALTH
During the last 5 years have you had, or do you currently have any of the following?
Please select all that apply...
● Depression
● Anxiety
● Stress
● None of the above
Your answer(s):
None of the above

HAVE YOU EVER HAD, OR DO YOU CURRENTLY HAVE, ANY OF THE
FOLLOWING?
Any form of cancer, tumour, lymphoma, leukaemia or any growth or cyst of either the brain or spine?
Including: Hodgkin's lymphoma, Non-Hodgkin's lymphoma, Leukaemia, Melanoma
Your answer(s):
No

Heart disease or disorder, circulatory disease or diabetes?
Including: Angina or heart attack, Cardiomyopathy, Heart Murmur, Deep vein thrombosis (DVT)
Your answer(s):
No

APART FROM ANYTHING YOU'VE ALREADY TOLD US ABOUT, DURING THE
LAST 5 YEARS HAVE YOU HAD, OR DO YOU CURRENTLY HAVE, ANY OF THE
FOLLOWING:
Raised blood pressure, raised cholesterol, chest pain or pre-diabetes?
Including borderline diabetes, sugar in the urine and raised blood glucose.
Your answer(s):
Yes

Which conditions have you had?
When typing your answer, please only use key words then click on the appropriate answer that appears.
Your answer(s):
Raised blood pressure

PLEASE TELL US MORE ABOUT YOUR RAISED BLOOD PRESSURE
Are you currently on treatment for raised blood pressure?
Your answer(s):
Yes

How many blood pressure medications do you take?
Your answer(s):
1

When was your blood pressure last checked?
Your answer(s):
05/05/2026

In your most recent BP reading, what was the bigger number?
Blood pressure readings have two numbers, one is always bigger than the other.
Your answer(s):
135

At your most recent blood pressure check, what was the smaller number?
Please enter the smaller number here.
Your answer(s):
80

YOUR GP
Have you been with this GP for less than 6 months?
Your answer:
No
Application form
page 14 of 16

CLIENT DECLARATION
You have confirmed the following:
You've declared that the answers in this application form are true and complete.
Application form
page 16 of 16

YOUR PERSONAL QUOTE
Application number: 900000001
1 QUOTE INFORMATION
Person covered: sample applicant
Smoker status: non-smoker
2 PREMIUM DETAILS
The total monthly premium for your plan is £46.64.
Underwriting decision quote
page 1 of 2

COMMISSION PAYABLE FOR THIS PLAN
We'll pay Sample Firm the commission shown in the table below.
Year 1: £1,158.26
Years 5-13: £14.04 each year
Plan commission
page 1 of 2
`;

/**
 * MetLife EverydayProtect: a two-page summary of key facts. Contains NO health
 * questions at all — the product is underwritten on eligibility, not medically —
 * so reconciliation here covers identity and cover selection only.
 *
 * Whitespace is preserved as a two-column extractor emits it: "Marital \nstatus:"
 * splits a label across lines, "Email:" puts its value on the next line, and
 * "Employment status: Employed Occupation: ..." shares one line.
 */
export const METLIFE_SUMMARY = `
MetLife EverydayProtect
Summary of application details
Policy number: EPH000001
Date of application: 30/07/2026
Applicant details
Name: Sample Customer
Address: 1 Sample Street Sampletown
Sampleshire
United Kingdom
AB12 3CD
Email:
sample@example.invalid
Day tel no:
07000000000
DOB: 14/10/1969 Marital
status:
Single
Employment
status: Employed Occupation: Instructor - Other
Eligibility Cover
UK Residency: Yes No. of Units: 3
Occupational eligibility: OK Child Cover: No
Active Lifestyle Cover: No
 Premium details
Monthly premium: £33.00
Preferred Direct Debit date: 1
MetLife Europe d.a.c. is a private company limited by shares, registered in Ireland.
COMP 3094.04 NOV2023

What would be the total amount of premium I should expect to pay if I keep my cover in
place until the end of the policy?
Should you decide to keep your policy for the lifetime of the policy then you should
expect to pay £7,194.00* in premium.
If you are arranging this policy through a Financial Adviser:
For arranging this contract on the basis outlined above, MetLife will pay commission
to the individual or firm responsible for setting up your policy with us worth £712.80
immediately and then, from month 49, 2.5% of each monthly premium.
COMP 3094.04 NOV2023
`;

/**
 * The quote-portal export, which is the dominant real format: three of the six
 * sample sales use it, and it is the only fully-underwritten one.
 *
 * Laid out as a two-column Q/A table. Extraction strands the column headers on
 * each row, so questions end with a tab and 'Q' and each record closes with a
 * lone 'A'. Answers appear BEFORE their question, stamped with a time and the
 * adviser who recorded them, and the portal keeps every edit — so more than one
 * answer before a question is an amendment, not a parse error.
 *
 * Reproduces the awkward parts verbatim: an answer wrapping so its attribution
 * lands on the next line, a question whose columns interleave into nonsense
 * ("In the have you had any of these? last 5 years"), and a disclosure that was
 * entered and then withdrawn.
 */
export const PORTAL_EXPORT = `The information you have provided
This is the information that you have provided to us and upon which we will rely to produce your individual
quotation. This information will form the basis of a contract between yourself and your insurer.
Customer name: Sample Customer
Please tell us some things about yourself:
29/07/2026 11:57 - 18/11/1971 (A Adviser)
Date of birth	Q
A
29/07/2026 11:57 - Non-smoker (A Adviser)
Please choose the best description of your smoking habits	Q
Please choose smoker if you have used any tobacco products including cigarettes, cigars or nicotine replacement in the last 12
months.
Options - Non-smoker, Smoker
A
29/07/2026 11:58 - 1.57m or 5 feet 2 inches (A Adviser)
How tall are you?	Q
A
29/07/2026 11:58 - 54kg or 8 stone 7 pounds (A Adviser)
How much do you weigh?	Q
A
29/07/2026 11:58 - Pupil Support Assistant (A Adviser)
What is your job?	Q
This needs to be your main job - in other words, the one you spend most time doing.
A

-- 1 of 9 --

29/07/2026 11:59 - I've never smoked, vaped, used e-cigarettes or other nicotine replacement products
(A Adviser)
Which of the following describe you?	Q
Options - I've never smoked, I used to smoke but stopped over a year ago, I've smoked in the last year
A
29/07/2026 11:58 - No (A Adviser)
29/07/2026 12:03 - Any other cancer (A Adviser)
Have your birth parents, brothers, or sisters had any of these before they were 65?	Q
You don't need to tell us if your family member was 65 or older when they first had their condition
Options - Heart attack, angina or stroke, Diabetes, Bowel cancer or bowel polyps, Any other cancer, No
A
29/07/2026 12:04 - None of these (A Adviser)
29/07/2026 12:04 - Stress (A Adviser)
29/07/2026 12:09 - None of these (A Adviser)
In the have you had any of these?	last 5 years	Q
Options - Depression, Anxiety, Stress, Any other mental health issue, None of these
A
29/07/2026 11:07 - 0 (A Adviser)
29/07/2026 11:09 - 3 (A Adviser)
Measures of spirits	Q
A

-- 2 of 9 --
`;

/**
 * The trailing section of a real portal export (Patrick Dixon, 07/08/2026).
 *
 * Two things about it are load-bearing and neither is obvious:
 *
 *  1. The family-history answer was "Any other cancer" at 09:53 and "No" at
 *     09:56 — a disclosure withdrawn three minutes after it was given.
 *  2. The two questions under the trailing heading carry the detail behind that
 *     withdrawal ("1" relative, "Father") — and their answer lines have NO
 *     "(adviser name)" attribution, unlike every other answer in the document.
 *
 * That second detail is why this fixture exists. The learner proposes an answer
 * pattern with the attribution mandatory, because on the body of the document it
 * always is, and these two lines then fail to match and the answers vanish.
 */
export const PORTAL_WITHDRAWN_SECTION = `07/08/2026 09:53 - Any other cancer (Lewis Moore)
07/08/2026 09:56 - No (Lewis Moore)
Have your birth parents, brothers, or sisters had any of these before they were 65?	Q
You don't need to tell us if your family member was 65 or older when they first had their condition
Options - Heart attack, angina or stroke, Any other cancer, I don't know, No
A
07/08/2026 10:03 - None of the above (Lewis Moore)
Does your job involve any of the following duties or working environments?	Q
Options - Diving, Armed forces, Mining, tunnelling or quarrying, None of the above
A
Questions answered but no longer included in your application:
07/08/2026 09:55 - 1
How many of your relatives have suffered from another type of cancer?	Q
A
07/08/2026 09:55 - Father
Relative 1: Which relative suffered from another type of cancer?	Q
Options - Father, Mother, Brother, Sister
A
`;

/** Profile config for the quote-portal export. */
export const PORTAL_CONFIG = {
  questionMarker: 'Q',
  optionsPrefix: 'Options - ',
  stripPatterns: [String.raw`^\s*--\s*\d+ of \d+\s*--\s*$`],
};

/**
 * The config as the LEARNER actually proposed it for this format, attribution
 * mandatory. Copied verbatim from the stored profile rather than written by
 * hand — the point of the tests using it is that this is what is really out
 * there on live tenants.
 */
export const PORTAL_CONFIG_STRICT_ATTRIBUTION = {
  ...PORTAL_CONFIG,
  answerLinePattern: String.raw`^(\d{2}/\d{2}/\d{4} \d{2}:\d{2}) - (.+?) \(([^)]+)\)$`,
};

/** Profile config for the Royal London pack. */
export const ROYAL_LONDON_CONFIG = {
  answerDelimiter: 'Your answer(s):',
  sectionStart: 'APPLICATION FORM',
  sectionEnd: 'YOUR PERSONAL QUOTE',
  choiceBullet: '●',
  // The running page footer is two lines: "Application form" then "page N of 16".
  // The second is covered by the shared defaults; this label is insurer-specific.
  // It lands directly after an answer with no blank line between, so without
  // stripping it the answer reads as "50 Application form".
  stripPatterns: [String.raw`^\s*Application form\s*$`],
  unansweredMarkers: ['Unanswered'],
};

/** Profile config for the MetLife summary. */
export const METLIFE_CONFIG = {
  labels: [
    'Policy number',
    'Date of application',
    'Name',
    'Address',
    'Email',
    'Day tel no',
    'DOB',
    'Marital status',
    'Employment status',
    'Occupation',
    'UK Residency',
    'Occupational eligibility',
    'No. of Units',
    'Child Cover',
    'Active Lifestyle Cover',
    'Monthly premium',
    'Preferred Direct Debit date',
  ],
  // Section headings and boilerplate that end a value without being labels
  // themselves. Without these a value runs into the next heading, and the final
  // label swallows the commission disclosure.
  valueTerminators: [
    'Applicant details',
    'Eligibility Cover',
    'Eligibility',
    'Premium details',
    'MetLife Europe',
    'What would be the total amount',
  ],
  unansweredMarkers: ['Unanswered'],
};
