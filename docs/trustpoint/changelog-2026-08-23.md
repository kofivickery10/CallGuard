# What's changed in CallGuard

**Release notes for Trust Point — 23 August 2026**

This release comes out of a full audit of every sale scored to date. We read all
113 of them, checked the maths on every score, and re-ran every answer
comparison Data Forms has ever made. What follows is what changed as a result,
written for the people who use the system rather than the people who build it.

Three items in here change scores or findings that are already on your screens.
They are marked **[changes existing results]** so nothing appears to move
without explanation.

---

## Data Forms understands answers given in the customer's own words

Insurers write their questions as long option lists: *"Cancer, cancer-in-situ,
leukaemia, Hodgkin's disease or any other tumour."* Customers do not talk like
that. They say *"bladder cancer"*, or *"arthritis in my lower back"*, or
*"anxiety and depression"* against a form that reads *"Anxiety, Depression"*.

Previously the system saw those as two different answers and gave up, filing the
item as **"could not tell"**. It now recognises that the customer named one of
the things on the list, and confirms the match.

Alongside that, it now handles three other everyday ways of saying the same
thing:

- **Heights.** *"5 foot 9"* on the call and *"175cm"* on the form are now
  understood to be the same person, with a small tolerance for rounding.
- **Dates.** *"March 2019"*, *"12/03/2019"* and *"the twelfth of March"* are
  read as one date rather than three different answers.
- **Units left off.** A form recording *"13"* against a call answer of *"13
  stone 4"* is treated as the same weight rather than as a discrepancy.

**[changes existing results]** Re-running this across every answer pair we hold:
**72 items that previously said "could not tell" now have an answer.** 55 of
them confirm the form and the call agreed. **17 of them are new items worth
your attention** that were previously invisible. No answer that already
matched has changed.

## Fewer findings that were never really findings

Two sources of noise are gone.

**Coincidental evidence.** When a question boiled down to one common word, the
system could find that word somewhere in a two-hour call and conclude the
question had been covered, or not covered, on that basis alone. It now declines
to draw a conclusion from a single common word appearing several times, and says
so instead of guessing.

**Wording recited by the adviser.** Advisers read option lists aloud. When the
extracted "customer answer" is word-for-word the wording on the form, that is
more likely the adviser reading than the customer disclosing. Those no longer
count as the customer having said it.

## The system now refuses to check the wrong person's paperwork

If the application document attached to a sale belongs to a different person
than the one on the call, every comparison it produces is meaningless. The clue
is usually a date of birth that cannot be the same person.

Data Forms now stops when it sees that, and shows the sale as
**"document does not match the customer"** rather than producing a page of
findings. It does not retry on its own, because retrying will not help. Someone
needs to attach the right document.

**[changes existing results]** One historic sale was affected. Its 18
comparisons and **4 findings have been withdrawn**, because they were the wrong
customer's answers all along.

## We stop scoring when we cannot tell who was speaking

Scoring depends on knowing which voice is the adviser and which is the customer.
On mono recordings that is worked out from the conversation, and occasionally it
cannot be worked out with any confidence.

Previously the system would score anyway. It now holds the sale instead of
guessing, and says why. A held sale shows no score rather than a wrong one, and
nothing is written to your CRM until it is resolved.

**[changes existing results]** **Nine historic sales** fall into this category
and will have their scores withdrawn pending review. This is the most visible
change in the release, and the one worth telling your advisers about before it
happens, since a score disappearing from a record looks like a fault.

## Manual review: "did not apply"

Reviewers were forced to record either a pass or a fail. Sometimes neither is
true, because the checkpoint did not apply to that call at all.

There is now a third option. An item marked **did not apply** is removed from
the calculation rather than being scored either way, which stops reviewers
having to record a pass they do not believe in.

## A quieter review queue

Clear, unambiguous passes were being sent to manual review purely because the
AI's confidence was a little below the threshold, which meant reviewers spent
time confirming things that were never in doubt.

Confidence now only routes an item to review where it actually matters: where
the item failed, or where it is a consent or disclosure checkpoint. Those still
go to a person every time. Everything else that clearly passed now stays out of
the queue.

## Personal data in application answers

Call transcripts already have personal details removed before storage, following
the rules your firm set: medical details and dates of birth are kept because
they are what compliance turns on, and names, addresses, emails and phone
numbers are not.

Application answers were not going through the same treatment, so a handful of
them still held customer names and contact details in full. They now follow
exactly the same rules as the transcripts, and the existing records are being
brought into line.

Where an answer has to be hidden, the question is still checked for whether it
was **asked** on the call. You keep the compliance signal without holding the
data.

## Clearer numbers on the reconciliation screen

Two changes to make the headline figures mean what they appear to mean.

- **Abandoned is separated from failed.** A sale we stopped waiting for is not
  the same as a sale the system could not process, and lumping them together
  made the failure rate look worse than it is.
- **A new figure: sales with no application document.** This one is the most
  important number on the screen, and it was not there before.

---

## What this release cannot fix

**42% of sales have no application document attached.** Data Forms compares the
submitted application against the call. With no application there is nothing to
compare, so those sales get no reconciliation at all, no matter how good the
comparison logic becomes.

Everything above improves the 58% we can see. The single biggest improvement
available to you is not in this release: it is attaching the pack to the sale.
Getting that to 100% roughly doubles the coverage of the whole feature.

## One thing we would like you to read

We have found **15 items where the form answers "no" and the customer appears to
have said something on the call.** We have deliberately not turned these into
findings, because we cannot yet tell reliably which are real disclosures and
which are an adviser reading the question aloud.

Read them, and your answers tell us whether that distinction is safe to automate
or whether it has to stay a human review. They are in a separate document. Five
of them look strong enough that we would want a person to listen to the
recording regardless of what we decide about automation.

---

*Every change above was tested against the full history of your scored sales
before release. Score arithmetic, the pass threshold, the breach register and
journey composition were all checked as part of the same audit and were found
correct, with no changes needed.*
