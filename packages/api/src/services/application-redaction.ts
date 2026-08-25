// The application side of a tenant's redaction policy.
//
// THE ASYMMETRY THIS CLOSES
//
// A transcript is redacted on the way in: Deepgram replaces a customer's name,
// address and email with typed placeholders, and for a tenant whose DPIA permits
// nothing extra they never reach storage at all. Reconciliation then compares
// that redacted transcript against the submitted application — and stored the
// application's values verbatim.
//
// So the same row holds `[LOCATION_ADDRESS_1]` on the call side and
// "14 Templars Way Grantham Lincolnshire NG33 5PS" on the application side.
// Measured on the first deploying firm: 73 items of 2,307 carrying a customer's
// home address, full name or email in the clear — all in categories that firm's
// own DPIA does NOT permit (it permits phi, numbers and dob for disclosure
// checking, and nothing else). 55 are whole fields; the other 18 are emails
// riding inside a phone field the parser merged, which is why scrubEmbeddedPii
// exists below.
//
// Migration 081 was careful that the application document itself is never
// retained. Its contents were being copied out of it into a column instead.
//
// NOTHING IS LOST BY MASKING
//
// A question whose answer belongs to a redacted category cannot be reconciled
// anyway: the call side of the comparison was removed before storage, so the
// outcome is 'undetermined' every time however the answer is stored. Measured:
// Address resolved 2 of 22, Email Address 0 of 5, and every unresolved one had
// its call value redacted by design. Masking removes data that was never
// serving a purpose.
//
// WHAT THIS IS NOT
//
// It is not a judgement about whether a question was spoken. "Bank account held
// in payers name" is asked out loud and produces real findings, and it is
// deliberately untouched here — see isBankAccountDetail in reconciliation.ts for
// the same reasoning applied to the narrow case of the account identifiers.
// This function keys only on whether the ANSWER's category is one the tenant
// redacts.
import type { QuestionCheckMode } from '@callguard/shared';

/**
 * PII categories, matching the names used for Deepgram's redact list
 * (REDACTION_CATEGORIES in transcription.ts) so a tenant's
 * pii_unredacted_categories means the same thing on both sides of the
 * comparison. Anything else a question might ask for is not PII we redact.
 */
export type AnswerCategory =
  | 'name'
  | 'email_address'
  | 'location_address'
  | 'dob'
  | 'numbers';

// What kind of value a question is asking for, by its own wording.
//
// Anchored and ordered. A question is only claimed where the WHOLE label is the
// field — "Name", "Account holder's name", "Day tel no" — never on a substring,
// because "Name of the medical condition" and "What is your job?" are ordinary
// reconcilable questions that happen to contain the words.
const CATEGORY_PATTERNS: Array<{ category: AnswerCategory; test: RegExp }> = [
  // Names. Includes the account holder, whose value is a person's name and so is
  // redacted from the call whatever the question is about.
  {
    category: 'name',
    test: /^\s*(full\s+|customer\s+|client\s+|account\s+holder'?s?\s+|payer'?s?\s+|policyholder'?s?\s+|first\s+|last\s+|sur)?name\s*:?\s*$|^\s*name\s+of\s+(the\s+)?(account\s+holder|payer|policyholder)\s*:?\s*$/i,
  },
  {
    category: 'email_address',
    test: /^\s*(e-?mail(\s+address)?|email)\s*:?\s*$/i,
  },
  {
    category: 'location_address',
    test: /^\s*(home\s+|correspondence\s+|current\s+|postal\s+)?(address|postcode|post\s+code)\s*:?\s*$|^\s*address\s+line\s*\d*\s*:?\s*$|^\s*(town|city|county)\s*:?\s*$/i,
  },
  {
    category: 'dob',
    test: /^\s*(d\.?o\.?b\.?|date\s+of\s+birth)\s*:?\s*$/i,
  },
  {
    category: 'numbers',
    test: /^\s*(day\s+|evening\s+|home\s+|mobile\s+|contact\s+|daytime\s+)?(tel(ephone)?|phone|mobile)\s*(no\.?|number)?\s*:?\s*$/i,
  },
];

/** Which PII category a question's answer falls in, or null if it is not one. */
export function answerCategoryOf(question: string): AnswerCategory | null {
  for (const { category, test } of CATEGORY_PATTERNS) {
    if (test.test(question)) return category;
  }
  return null;
}

/**
 * Whether this tenant keeps this category in the clear.
 *
 * `pii_unredacted_categories` is the tenant's DPIA-approved allowlist. Names are
 * requested from Deepgram as three separate entities (name, name_given,
 * name_family) and addresses as five, so a tenant permitting the family has to
 * permit all of its parts — anything less means the value does not survive whole
 * and cannot be compared.
 */
export function categoryIsReadable(
  category: AnswerCategory,
  unredactedCategories: string[]
): boolean {
  const permitted = new Set(unredactedCategories);
  switch (category) {
    case 'name':
      return ['name', 'name_given', 'name_family'].every((c) => permitted.has(c));
    case 'location_address':
      return ['location_address', 'location_city', 'location_state', 'location_zip'].every((c) =>
        permitted.has(c)
      );
    case 'email_address':
      return permitted.has('email_address');
    case 'dob':
      return permitted.has('dob');
    case 'numbers':
      return permitted.has('numbers');
  }
}

/**
 * The check mode a question's redaction status implies, or null where redaction
 * has nothing to say about it.
 *
 * 'presence' rather than 'none': the field still has to be filled in, and
 * whether it was is visible from the document alone. A blank home address on a
 * submitted application is a real finding; it is simply not one the recording
 * can speak to.
 */
export function redactionCheckMode(
  question: string,
  unredactedCategories: string[]
): QuestionCheckMode | null {
  const category = answerCategoryOf(question);
  if (category === null) return null;
  return categoryIsReadable(category, unredactedCategories) ? null : 'presence';
}

// PII that can appear INSIDE another field's value, with the placeholder to put
// in its place. Applied whatever the question is, because the question's own
// category says nothing about what a contaminated value happens to contain.
const EMBEDDED_PII: Array<{ category: AnswerCategory; find: RegExp; replace: string }> = [
  {
    category: 'email_address',
    find: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: '[EMAIL_ADDRESS]',
  },
  {
    // A UK postcode in its full form only. The outward-code-only shape ("M32")
    // is indistinguishable from ordinary alphanumerics that appear in policy
    // and product references, and scrubbing those would damage comparable
    // values to no benefit.
    category: 'location_address',
    find: /\b[A-Z]{1,2}[0-9][0-9A-Z]? ?[0-9][A-Z]{2}\b/g,
    replace: '[LOCATION_ZIP]',
  },
];

/**
 * Strip PII of a redacted category out of a value whose own field is permitted.
 *
 * The document parser merges adjacent form fields, so a field the tenant may
 * keep can arrive carrying one it may not. Observed on a MetLife summary sheet:
 * "Day tel no" holding "someone@example.com 07700900123" — eighteen customers'
 * email addresses inside the one identity field this tenant's DPIA does permit,
 * where a check on the question's own category would never look.
 *
 * Also the reason that field never reconciles: the stored value is two fields
 * concatenated, so it matches nothing on the call.
 */
export function scrubEmbeddedPii(value: string, unredactedCategories: string[]): string {
  let out = value;
  for (const { category, find, replace } of EMBEDDED_PII) {
    if (categoryIsReadable(category, unredactedCategories)) continue;
    out = out.replace(find, replace);
  }
  return out;
}

/**
 * The application answer as it should be stored: the value, or a typed
 * placeholder where the tenant redacts that category.
 *
 * The placeholder is shaped like Deepgram's so the two sides of a row read
 * consistently, and it is typed rather than blanked so a reviewer can tell "the
 * form had an address here, we are not keeping it" from "the form was blank" —
 * which is the difference between nothing to report and a finding.
 */
export function maskApplicationAnswer(
  question: string,
  answer: string | null,
  unredactedCategories: string[]
): string | null {
  if (answer === null || answer.trim() === '') return answer;
  const category = answerCategoryOf(question);
  // Whole-field masking first: where the field itself is a redacted category
  // there is nothing worth keeping, so the typed placeholder replaces all of it.
  if (category !== null && !categoryIsReadable(category, unredactedCategories)) {
    return `[${category.toUpperCase()}]`;
  }
  // Otherwise the value is kept — but a merged field can still carry PII of a
  // category the tenant redacts, so scrub inside it.
  return scrubEmbeddedPii(answer, unredactedCategories);
}
