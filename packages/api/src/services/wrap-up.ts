// Which of a sale's calls is its wrap-up (closing) call.
//
// Kept apart from services/journey.ts, and free of the job queues, so the
// operational scripts can use the same rule without opening Redis.
import type { TransactionClient } from '../db/client.js';

// The shortest call that can have been a sale's close.
//
// The wrap-up used to be simply the latest call in the window, however short.
// A dialler records every leg — a voicemail left afterwards, a 40-second
// call-back, a transfer to a colleague — so a trailing sub-minute call routinely
// outranked the real closing call. Measured on Trust Point (14 Sep 2026): on 5
// sales the wrap-up was a 20–60 second single-voice call made minutes after a
// 24–65 minute sales call. The wrap-up decides who closed the sale (dashboard,
// Zoho QA owner, default feedback recipient) and whether the sale's evidence can
// be attributed at all, so that one leg credited the wrong adviser and held
// sales back from scoring. Nothing that discloses, recaps and sets up a Direct
// Debit fits in two minutes.
export const MIN_WRAP_UP_SECONDS = 120;

export interface WrapUpCandidate {
  id: string;
  duration_seconds: number | string | null;
  call_date: string | Date | null;
  created_at: string | Date;
}

// Mirrors COALESCE(call_date::timestamptz, created_at) in the SQL that orders calls.
function callTime(c: WrapUpCandidate): number {
  const dated = c.call_date === null ? NaN : new Date(c.call_date).getTime();
  return Number.isNaN(dated) ? new Date(c.created_at).getTime() : dated;
}

/**
 * Which call closed the sale: the latest call that could have been one.
 *
 * A call could have been the close unless it is known to be shorter than
 * MIN_WRAP_UP_SECONDS. A call whose length is not known yet is NOT assumed
 * short: on SFTP, upload and API tenants that means it has not been transcribed,
 * and choosing it holds the sale for review (no attributable wrap-up) instead of
 * scoring it without its closing call — the latest-call rule's outcome, kept.
 * Only when every call is timed and short does the longest win, since it carries
 * the most evidence. Ties go to the later call. Order-independent.
 */
export function chooseWrapUpCall<T extends WrapUpCandidate>(calls: T[]): T | null {
  if (calls.length === 0) return null;
  const seconds = (c: T): number | null => (c.duration_seconds === null ? null : Number(c.duration_seconds));
  const latestFirst = [...calls].sort((a, b) => callTime(b) - callTime(a));

  const couldBeTheClose = latestFirst.find((c) => {
    const s = seconds(c);
    return s === null || s >= MIN_WRAP_UP_SECONDS;
  });
  if (couldBeTheClose) return couldBeTheClose;

  return latestFirst.reduce((best, c) => (seconds(c)! > seconds(best)! ? c : best));
}

/**
 * Re-mark which of a journey's calls is the wrap-up, from the calls it holds now.
 * Returns the previous and chosen call ids so a caller can log a move.
 */
export async function setWrapUpRole(
  db: Pick<TransactionClient, 'query'>,
  journeyId: string
): Promise<{ previous: string | null; chosen: string | null }> {
  const calls = await db.query<WrapUpCandidate & { role: string }>(
    `SELECT c.id, c.duration_seconds, c.call_date, c.created_at, jc.role
       FROM journey_calls jc
       JOIN calls c ON c.id = jc.call_id
      WHERE jc.journey_id = $1`,
    [journeyId]
  );
  const previous = calls.find((c) => c.role === 'wrap_up')?.id ?? null;
  const chosen = chooseWrapUpCall(calls)?.id ?? null;
  if (chosen && chosen !== previous) {
    await db.query(
      `UPDATE journey_calls
          SET role = CASE WHEN call_id = $2 THEN 'wrap_up' ELSE 'context' END
        WHERE journey_id = $1`,
      [journeyId, chosen]
    );
  }
  return { previous, chosen };
}
