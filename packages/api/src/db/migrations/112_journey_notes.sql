-- A general, case-level note on a sale (CG-9).
--
-- WHY THIS TABLE EXISTS: every human annotation CallGuard holds today is bound
-- to something the model produced — score_corrections overturns a checkpoint
-- verdict, review resolutions rule on one low-confidence item, journey_feedback
-- records what an adviser was told. There is nowhere to say something about the
-- SALE that is not a ruling on a criterion. Trust Point hit this immediately:
-- a sale spanning several phone numbers where calls are missing, so the score
-- is unreliable and there is no way to record why. "The score on this case is
-- low because three calls are missing, JC, 26 Aug" is not a correction to any
-- one checkpoint — it is context for the whole record.
--
-- WHY IT IS EVIDENCE, NOT A UI CONVENIENCE: this is the reason the note is a
-- table of its own rather than a text column on `journeys`. A note explaining
-- why a score is what it is has to survive to a complaint file years later, and
-- reach the claims-defence pack alongside the AI's verdicts and the human
-- rulings on top of them. That audience — an insurer, a compliance officer, the
-- Financial Ombudsman — is why the two rules below are structural rather than
-- left to the application.
--
-- RULE 1: NOTHING IS EVER SILENTLY REWRITTEN. A note that can be edited in
-- place with no trace is worse than no note at all: it lets the record be made
-- to say something it did not say at the time, which is precisely what an
-- evidence pack exists to rule out. Editing is allowed — people make mistakes
-- and a wrong note should be correctable — but every superseded version is kept
-- in journey_note_revisions below, so the trail reads "this is what it says now,
-- and this is what it said before".
--
-- RULE 2: NOTHING IS DELETED. There is deliberately no delete path, in the API
-- or here. A note withdrawn from the record is indistinguishable, to a later
-- reader, from one that was never written — and the decision to remove
-- inconvenient context is exactly the decision an audit trail must not permit.
-- A mistaken note is corrected by editing it, with the original still visible.
CREATE TABLE IF NOT EXISTS journey_notes (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    journey_id        UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,

    -- The note as it currently stands. Superseded text lives in
    -- journey_note_revisions, so this column is always "what it says now".
    body              TEXT NOT NULL,

    -- Who wrote it. Same snapshot pattern, and the same reason, as
    -- journey_feedback.adviser_name (087): the user row can be deleted or
    -- renamed, and ON DELETE SET NULL would leave an unattributed note behind.
    -- An annotation whose author cannot be named carries no evidential weight,
    -- so the name is copied at write time and the FK is only a convenience for
    -- joining back to a live account.
    author_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    author_name       TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Last edit, if any. NULL on a note that has never been edited, which is
    -- how the API and the pack tell "original, untouched" from "current version
    -- of something that changed" without counting revision rows.
    --
    -- The editor need not be the author: a supervisor may correct a colleague's
    -- note, and the pack has to be able to say so.
    edited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    edited_by_name    TEXT,
    edited_at         TIMESTAMPTZ
);

COMMENT ON TABLE journey_notes IS
  'Case-level human annotation on a sale. Append-and-amend only: never deleted, and every superseded version is retained in journey_note_revisions.';
COMMENT ON COLUMN journey_notes.edited_at IS
  'NULL means the note has never been edited and body is the original text as written.';

-- Sale detail and the claims-defence pack both read every note for one sale in
-- write order, which is the only access pattern either has.
CREATE INDEX IF NOT EXISTS idx_journey_notes_journey
  ON journey_notes (journey_id, created_at);

-- Every version of a note that has since been replaced — one row per edit,
-- holding the text as it read BEFORE that edit.
--
-- The current text is deliberately not duplicated here. journey_notes.body plus
-- these rows is the complete history with no row that could disagree with the
-- note itself: a copy of the current version kept in two places is a copy that
-- can drift.
--
-- Note the asymmetry with journey_feedback_items.reasoning (110). That snapshot
-- exists because a re-score DESTROYS the row it was derived from, so there is
-- nothing left to join to. Here the reverse is true — the note is the original
-- and nothing recomputes it — so what is preserved is not a copy of a volatile
-- value but the earlier state of a durable one.
CREATE TABLE IF NOT EXISTS journey_note_revisions (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    note_id           UUID NOT NULL REFERENCES journey_notes(id) ON DELETE CASCADE,

    -- What the note said before the edit that created this row.
    body              TEXT NOT NULL,

    -- Who wrote THAT version and when, carried forward from the note as it was.
    -- Without these, a note edited by a second person would show the whole
    -- history under the current editor's name.
    author_name       TEXT NOT NULL,
    written_at        TIMESTAMPTZ NOT NULL,

    -- When this version stopped being current, and who replaced it.
    superseded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_by_name TEXT NOT NULL
);

COMMENT ON TABLE journey_note_revisions IS
  'Superseded versions of a journey note, oldest first. Holds the text as it read before each edit; the current text stays in journey_notes.body.';

CREATE INDEX IF NOT EXISTS idx_journey_note_revisions_note
  ON journey_note_revisions (note_id, superseded_at);
