**Subject:** CallGuard release notes, and three things that will look different

Hi Joey,

We have just finished a full audit of CallGuard against your account: all 113
sales scored to date, every score recalculated, and every answer comparison
Data Forms has ever made re-run from scratch.

The good news first. The scoring itself came back clean. Score arithmetic, the
pass threshold, the breach register and the way calls are grouped into sales
were all checked and all correct, with nothing to change.

What we did find was a set of places where the system was being too cautious,
too noisy, or occasionally confident when it had no right to be. Those are all
fixed in this release. Details below, but there are three changes you will
notice on your screens, so those come first.

---

## Three things that will look different

**Nine sales will have their scores withdrawn.**

Scoring depends on knowing which voice is the adviser and which is the customer.
On mono recordings that is worked out from the conversation, and on nine of your
sales it could not be worked out with any confidence. The old behaviour was to
score anyway. The new behaviour is to hold the sale and say so.

Those nine will show as held, with no score, until reviewed. This is the change
most worth mentioning to your advisers beforehand, because a score disappearing
from a record looks like a fault rather than a deliberate decision.

**Seventeen new items will appear on sales you already consider closed.**

The system is now much better at recognising an answer given in the customer's
own words (more on that below). A side effect is that 17 comparisons which
previously said "we could not tell" now say "these do not agree". They are not
new events. They were always there and we simply could not read them.

**One sale will lose its findings entirely.**

The application document attached to it belongs to a different person than the
one on the call, which we can tell because the dates of birth cannot both be
right. All 18 of its comparisons and all 4 of its findings have been withdrawn,
because they were never that customer's answers.

---

## What has improved

**Data Forms now understands answers given in the customer's own words.**

Insurers write their questions as long option lists: *"Cancer, cancer-in-situ,
leukaemia, Hodgkin's disease or any other tumour."* Customers do not talk like
that. They say *"bladder cancer"*, or *"arthritis in my lower back"*, or
*"anxiety and depression"* against a form reading *"Anxiety, Depression"*.

The system used to see two different answers and give up. It now recognises the
customer naming one of the things on the list. It also handles heights (*"5 foot
9"* and *"175cm"* are the same person), dates written any of the usual ways, and
weights recorded without their unit.

Across your whole history, 72 items that said "could not tell" now have an
answer. 55 confirm the form and the call agreed. 17 are the new items above. No
answer that already matched has changed.

**Fewer findings that were never really findings.**

Two sources of noise are gone. Where a question boiled down to one common word,
the system could find that word somewhere in a long call and draw a conclusion
from it. It now declines to, and says so. And where the extracted customer
answer is word-for-word the wording on the form, that is more likely the adviser
reading the list aloud than the customer disclosing something, so it no longer
counts as the customer having said it.

**Reviewers can record "did not apply".**

Previously the only options were pass and fail. Sometimes neither is true
because the checkpoint did not apply to that call. An item marked as not
applicable now drops out of the calculation rather than being scored either way.

**The review queue is quieter.**

Clear passes were being sent for manual review purely because the AI's
confidence sat slightly below the threshold, so reviewers were confirming things
that were never in doubt. Confidence now routes an item to a person where it
matters: anything that failed, and anything touching consent or disclosure.
Those still go to review every time.

**Personal data in application answers now follows the same rules as calls.**

Call transcripts already have personal details removed before storage, per the
rules your firm set: medical detail and dates of birth kept, names and contact
details not. Application answers were not going through the same treatment, so a
small number still held customer names and addresses in full. They now follow
the identical rules, and the existing records are being brought into line. Where
an answer has to be hidden we still check whether the question was asked on the
call, so you keep the compliance signal without holding the data.

**Two clearer numbers on the reconciliation screen.**

Sales we stopped waiting for are now counted separately from sales that failed
to process, which made the failure rate look worse than it was. And there is a
new figure for sales with no application document, which brings us to the last
part.

---

## The one thing this release cannot fix

**42% of your sales have no application document attached.**

Data Forms works by comparing the submitted application against the call. With
no application there is nothing to compare, so those sales get no reconciliation
at all, however good the comparison logic gets.

Everything above improves the 58% we can see. The largest single improvement
available is not in this release: it is attaching the pack to the sale. Getting
that to 100% roughly doubles what the feature covers for you.

## And one thing we would like you to read

We have found 15 items where the application answers "no" and the customer
appears to have said something relevant on the call. We have deliberately not
turned these into findings.

The reason is worth explaining. In one of them the recorded customer answer is
*"heart attack or stroke"*, which is the exact wording printed on the form, so
it is most likely the adviser reading the question rather than the customer
disclosing anything. We cannot yet tell that case apart from the real ones
reliably enough to put an accusation on an adviser's record.

So the ask is the reverse of the usual one. Read them, and your answers tell us
whether that distinction is safe to automate or whether it stays a human review.
Five of them look strong enough that we would want someone to listen to the
recording regardless of what we decide.

The list is attached separately.

Happy to walk through any of this on a call, particularly the nine held sales if
you would rather we timed that change around something.

Best,
Kofi
