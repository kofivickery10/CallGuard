import type { BreachSeverity } from './breaches.js';

// The open-remediation backlog (CG-27, Phase 4 of the CG-6 scope —
// docs/remediation-guidance-scope.md §4.5).
//
// CG-24 let a firm write down what should be done about a failed checkpoint,
// CG-25 let the adviser say what they did, and CG-26 put that answer into the
// documents that leave the building. None of them answers the question a
// supervisor asks on a Monday morning: what have we asked for that nobody has
// closed, and who is sitting on it?
//
// WHAT COUNTS AS OPEN, and why it is narrower than it first looks
//
// One outstanding ask per checkpoint per sale, read off the most recent
// ACKNOWLEDGED round — the same rule the board pack's open figure uses (CG-26),
// because two numbers describing the same backlog must not disagree. On top of
// that rule this list requires the checkpoint to have carried the firm's own
// guidance when it was sent.
//
// That last condition is the difference between a queue and a graveyard.
// Migration 115 is explicit that a checkpoint with no guidance has no
// remediation step, and CG-25's page says as much to the adviser ("your firm has
// not set a step for this one"). Without the condition, every finding ever fed
// back and acknowledged before CG-24 shipped would appear here as outstanding
// work — on links that have since expired, so nobody could ever close one — and
// the first thing a firm would see on this screen is hundreds of rows it has no
// way to act on. The board pack's broader "awaiting outcome" figure is a
// different measure for a different reader and is left as it is; this is the
// list somebody has to work through.

/** One outstanding ask: a finding, on a sale, that a named adviser was told to
 *  do something about and has not answered. */
export interface RemediationBacklogItem {
  /** The journey_feedback_items row. The durable per-finding identity (087),
   *  not a breach id — breaches are destroyed and recreated by a re-score. */
  feedback_item_id: string;
  journey_id: string;
  /** Named so the supervisor knows which conversation this was, exactly as the
   *  sales list names it. Null where the sale has no linked customer. */
  customer_name: string | null;
  /** The checkpoint's wording as it was sent, not as the scorecard reads today. */
  item_label: string;
  severity: BreachSeverity;
  /** The firm's instruction, frozen at send time. Never null on this list — an
   *  ask with no instruction is not an ask. */
  remediation_guidance: string;
  /** When the feedback carrying this ask was sent. */
  told_at: string;
  /** When the adviser confirmed it. The clock this list ages from. */
  acknowledged_at: string;
  /** Whole days since acknowledgement. */
  days_open: number;
  /** The adviser's tokenised link has expired, so they can no longer answer
   *  this one and chasing them will not work — the feedback has to be re-sent.
   *  Surfaced because the alternative is a supervisor chasing someone who has
   *  no way to comply. */
  link_expired: boolean;
}

/** Everything outstanding for one adviser. */
export interface RemediationBacklogAdviser {
  /** Their user id where they have an account, otherwise their email address
   *  lowercased. Advisers frequently have no login at all (061) — Trust Point's
   *  have none — so a user id cannot be the grouping key. */
  adviser_key: string;
  /** The snapshot from the most recent feedback sent to them (087), not a live
   *  join: this list must keep naming whoever was actually told. */
  adviser_name: string;
  adviser_email: string;
  /** Present only where they have an account, for linking onwards. */
  adviser_user_id: string | null;
  open_count: number;
  /** Whole days since the oldest of their open asks was acknowledged. */
  oldest_open_days: number;
  items: RemediationBacklogItem[];
}

export interface RemediationBacklogResponse {
  /** Advisers with something outstanding, worst first: oldest ask, then volume.
   *  An adviser with nothing open is absent rather than present with a zero —
   *  this is a work queue, not a scoreboard of everyone. */
  advisers: RemediationBacklogAdviser[];
  total_open: number;
  advisers_with_open: number;
  oldest_open_days: number | null;
  /** True when the row cap was hit and the list is not the whole backlog. The
   *  counts above describe what was returned, so a truncated response must say
   *  so rather than let a partial total read as the total. */
  truncated: boolean;
  /** What this list means, in the response rather than only in the UI, so a
   *  figure lifted out of it into a report carries its own definition. */
  note: string;
}
