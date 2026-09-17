import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { CoachingPanel } from '../components/CoachingPanel';
import { CapturePanel } from '../components/CapturePanel';
import { ReconciliationPanel } from '../components/ReconciliationPanel';
import { FeedbackPanel, FeedbackHeaderAction, useFeedbackState } from '../components/FeedbackPanel';
import { CaseNotesPanel } from '../components/CaseNotesPanel';
import { ScoreCorrectionModal } from '../components/ScoreCorrectionModal';
import { CheckpointRow } from '../components/CheckpointRow';
import { ActionMenu } from '../components/ActionMenu';
import { ItemResultBadge } from '../components/ItemResultBadge';
import { ReviewSection } from '../components/ReviewSection';
import { formatPhone, formatDuration } from '../lib/format';
import {
  isItemPass,
  hasFeature,
  parseCoaching,
  ACTIONABLE_RECONCILIATION_OUTCOMES,
  PASS_THRESHOLD,
} from '@callguard/shared';
import type {
  BreachSeverity,
  CaptureRun,
  JourneyWithDetail,
  OrganizationInfo,
  Product,
  ReconciliationItem,
  ReconciliationRun,
} from '@callguard/shared';

// Worst first, so the finding that decides whether a sale is defensible is the
// one at the top of the list rather than wherever the scorecard happened to put
// it. Unset severity sorts last.
const SEVERITY_ORDER: Record<BreachSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const severityRank = (s: BreachSeverity | null) => (s ? SEVERITY_ORDER[s] : 4);

type Filter = 'attention' | 'passed' | 'na' | 'all';
type Section = 'coaching' | 'capture' | 'reconciliation' | 'feedback';

// The call filter's value for checkpoints the scorer did not attribute to a
// single call — often the ones that were never said anywhere.
const NO_CALL = 'none';
// …and for checkpoints cited from a call that is no longer part of the sale.
const OTHER_CALL = 'other';

const TRIGGER_LABELS: Record<string, string> = {
  zoho_sale: 'Started from the CRM sale',
  manual: 'Started manually',
  fallback: 'Started automatically',
};

const dateOnly = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const dateAndTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

/** One headline figure. The stat-card recipe in DESIGN_SYSTEM §4, no icon. */
function StatTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-card px-3 py-3 sm:px-5 sm:py-4 flex flex-col gap-1 sm:gap-1.5 min-w-0">
      <span className="text-card-label uppercase text-text-secondary">{label}</span>
      {children}
    </div>
  );
}

export function JourneyDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const scoreOnly = useScoreOnly();
  const queryClient = useQueryClient();
  const { notify, confirm } = useDialog();
  const canAction = user?.role === 'admin' || user?.role === 'supervisor';
  // Re-scoring re-spends scoring tokens and re-pushes to the CRM, so it's
  // admin-only (see POST /journeys/:id/rescore) and gated behind a confirm.
  const isAdmin = user?.role === 'admin';
  const canLearn = user ? hasFeature(user.organization_plan, 'ai_learning') : false;

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [callFilter, setCallFilter] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [openSections, setOpenSections] = useState<Set<Section>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [caveatsOpen, setCaveatsOpen] = useState(false);
  const [correctingItem, setCorrectingItem] = useState<{
    itemScoreId: string;
    label: string;
    pass: boolean;
    evidence: string | null;
  } | null>(null);

  const { data: journey, isLoading, isError } = useQuery({
    queryKey: ['journey', id],
    queryFn: () => api.get<JourneyWithDetail>(`/journeys/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'pending' || s === 'scoring' ? 4000 : false;
    },
  });

  // Product catalogue — resolves the ids on a checkpoint's applies_to_products
  // to names, to explain an N/A result. Cheap and cached; empty for orgs not
  // using product-aware scoring.
  const { data: productsData } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ data: Product[] }>('/products'),
  });
  const productNames = new Map((productsData?.data ?? []).map((p) => [p.id, p.name]));

  // The firm's pass mark. Same key as useOrgFeatures, so this is the cached
  // organisation record, not a second request.
  const { data: org } = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationInfo>('/organization'),
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  // pass_threshold is NUMERIC(5,2) and pg returns it as a string ("70.00").
  const passMark = Number(org?.pass_threshold ?? PASS_THRESHOLD);

  // The after-the-review rows each state where they stand in one line, so they
  // read the same records their panels do. Same query keys as the panels:
  // opening one reuses what the summary already loaded.
  const { data: reconciliation, isError: reconciliationError } = useQuery({
    queryKey: ['reconciliation-journey', id],
    queryFn: () =>
      api.get<{ run: ReconciliationRun | null; items: ReconciliationItem[] }>(`/reconciliation/journeys/${id}`),
    enabled: !!id,
    // Polls like the panel does, so a collapsed "Comparing…" line moves on
    // without the row having to be opened.
    refetchInterval: (query) => {
      const st = query.state.data?.run?.status;
      return st === 'pending' || st === 'running' ? 4000 : false;
    },
  });
  const { data: capture, isError: captureError } = useQuery({
    queryKey: ['capture-journey', id],
    queryFn: () =>
      api.get<{
        run: CaptureRun | null;
        answers: Array<{ result: string; required: boolean }>;
      }>(`/capture/journeys/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const st = query.state.data?.run?.status;
      return st === 'pending' || st === 'running' ? 4000 : false;
    },
  });

  const rescoreMutation = useMutation({
    mutationFn: () => api.post(`/journeys/${id}/rescore`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['journey', id] });
      void notify('Re-scoring started — the result will update here shortly.');
    },
    // The API refuses a re-score that cannot tell us anything new (same calls,
    // same transcripts, same scorecard) and there is deliberately no override:
    // an "are you sure?" that can be clicked through gets clicked through, and
    // re-running the AI on identical input is exactly how a score ends up
    // moving for no reason anyone can explain. Surfaced as-is — the message
    // says what would have to change for a re-score to mean anything.
    onError: (err) =>
      void notify(err instanceof Error ? err.message : 'Failed to re-score'),
  });

  // Once the adviser has been told the findings, re-scoring would change them
  // after the fact — so the action is not offered. The API refuses it too
  // (POST /journeys/:id/rescore); this only stops it being presented as an
  // option, since a disabled button nobody can explain invites a support ticket.
  const { data: feedbackState, isError: feedbackError } = useFeedbackState(id ?? '', canAction && !!id);
  const fedBack = feedbackState?.feedback != null;

  // Bumped by the header action. The feedback panel opens its compose box on a
  // change, so the findings are read before anything is sent.
  const [composeSignal, setComposeSignal] = useState(0);

  const toggleSection = (section: Section) => {
    // The feedback panel opens its compose box whenever it mounts with a signal
    // above zero, so a stale signal would reopen a form someone just cancelled.
    if (section === 'feedback' && openSections.has('feedback')) setComposeSignal(0);
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const openFeedback = () => {
    setOpenSections((prev) => new Set(prev).add('feedback'));
    setComposeSignal((n) => n + 1);
    // Deferred a frame: the panel mounts when its section opens, and scrolling
    // to it before it has height lands short.
    requestAnimationFrame(() => {
      document.getElementById('sale-section-feedback')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  const handleRescore = async () => {
    const ok = await confirm(
      'Re-score this sale? It re-runs the AI scorecard on the same calls and updates the sale, its breaches, and any connected CRM record.',
      { confirmLabel: 'Re-score' }
    );
    if (ok) rescoreMutation.mutate();
  };

  const handleToggleExemplar = async () => {
    if (!journey) return;
    try {
      await api.post(`/journeys/${journey.id}/exemplar`, {
        is_exemplar: !journey.is_exemplar,
        reason: !journey.is_exemplar ? 'Marked by admin' : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['journey', id] });
    } catch (err) {
      await notify('Failed to update exemplar: ' + (err instanceof Error ? err.message : 'unknown error'));
    }
  };

  const resolve = async (itemScoreId: string, result: 'pass' | 'fail' | 'na') => {
    setResolvingId(itemScoreId);
    try {
      await api.post('/review-items/resolve', { kind: 'journey', item_score_id: itemScoreId, result });
      queryClient.invalidateQueries({ queryKey: ['journey', id] });
      queryClient.invalidateQueries({ queryKey: ['review-items'] });
    } catch (err) {
      await notify('Failed to resolve: ' + (err instanceof Error ? err.message : 'unknown error'));
    } finally {
      setResolvingId(null);
    }
  };

  const items = useMemo(() => journey?.item_scores ?? [], [journey?.item_scores]);

  // Which call in the sale a checkpoint's evidence came from. Calls arrive
  // oldest first, and the scorer numbered only the transcribed ones
  // (score-journey.ts withTranscript) — so the page numbers the same set, or its
  // "Call 2" would point at a different call from the AI's.
  const callNumbers = useMemo(() => {
    const map = new Map<string, number>();
    (journey?.calls ?? []).filter((c) => c.has_transcript).forEach((c, i) => map.set(c.id, i + 1));
    return map;
  }, [journey?.calls]);

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading this sale">
        <div className="h-8 w-72 max-w-full rounded bg-border-light animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-card border border-border bg-card" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-4">
          <div className="h-96 rounded-card border border-border bg-card" />
          <div className="h-64 rounded-card border border-border bg-card" />
        </div>
      </div>
    );
  }

  if (isError || !journey) {
    return (
      <div className="bg-card border border-border rounded-card p-10 text-center">
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block">
          Could not load this sale — it may have been removed.
        </div>
        <div className="mt-4">
          <Link
            to="/journeys"
            className="text-primary-ink text-table-cell font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Back to Sales
          </Link>
        </div>
      </div>
    );
  }

  const scored = journey.status === 'scored';

  const callKey = (sourceCallId: string | null) =>
    !sourceCallId ? NO_CALL : callNumbers.has(sourceCallId) ? sourceCallId : OTHER_CALL;
  const matchesCall = (sourceCallId: string | null) =>
    callFilter === null || callKey(sourceCallId) === callFilter;
  const callLabelFor = (sourceCallId: string | null) =>
    !sourceCallId
      ? null
      : callNumbers.has(sourceCallId)
        ? `Call ${callNumbers.get(sourceCallId)}`
        : 'A call not in this sale';

  const failedAll = items
    .filter((i) => i.result === 'fail')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const reviewAll = items.filter((i) => i.result === 'manual_review');
  const firstReview = reviewAll[0];
  const passedAll = items.filter((i) => i.result === 'pass');
  const naAll = items.filter((i) => i.result === 'na');
  const severityCounts = (['critical', 'high', 'medium', 'low'] as BreachSeverity[])
    .map((sev) => ({ sev, n: failedAll.filter((i) => i.severity === sev).length }))
    .filter((c) => c.n > 0);
  const criticalCount = severityCounts.find((c) => c.sev === 'critical')?.n ?? 0;

  const failed = failedAll.filter((i) => matchesCall(i.source_call_id));
  const pendingReview = reviewAll.filter((i) => matchesCall(i.source_call_id));
  const passed = passedAll.filter((i) => matchesCall(i.source_call_id));
  const notApplicable = naAll.filter((i) => matchesCall(i.source_call_id));
  const attention = [...pendingReview, ...failed];

  // Per-call counts for the Calls panel. Every sale has calls, whatever shape its
  // scorecard takes, so this is the breakdown that holds on every tenant —
  // unlike scorecard sections, which are free text and often absent.
  const perCall = new Map<string, { fail: number; review: number; pass: number; na: number }>();
  for (const item of items) {
    const key = callKey(item.source_call_id);
    const c = perCall.get(key) ?? { fail: 0, review: 0, pass: 0, na: 0 };
    if (item.result === 'fail') c.fail++;
    else if (item.result === 'manual_review') c.review++;
    else if (item.result === 'pass') c.pass++;
    else c.na++;
    perCall.set(key, c);
  }

  const customerLabel =
    journey.customer_name ?? (journey.customer_phone ? formatPhone(journey.customer_phone) : null);
  // Names for a checkpoint's product scope (drops ids no longer in the
  // catalogue). Used to explain why a product-scoped item resolved to N/A.
  const productNameList = (ids: string[] | null): string[] =>
    (ids ?? []).map((pid) => productNames.get(pid)).filter((n): n is string => !!n);

  const advisers = Array.from(
    new Set(journey.calls.map((c) => c.agent_name).filter((n): n is string => !!n))
  );
  const unattributedCalls = journey.calls.filter((c) => !c.agent_name).length;
  const firstCallDate = journey.calls[0]?.call_date;
  const lastCallDate = journey.calls[journey.calls.length - 1]?.call_date;
  const callSpan =
    firstCallDate && lastCallDate
      ? `${plural(journey.calls.length, 'call')}, ${
          dateOnly(firstCallDate) === dateOnly(lastCallDate)
            ? dateOnly(firstCallDate)
            : `${dayMonth(firstCallDate)} – ${dateOnly(lastCallDate)}`
        }`
      : plural(journey.calls.length, 'call');

  // Scoring history, newest first. Absent on a sale scored before the history
  // table existed (migration 074 backfills one row per already-scored sale, so
  // in practice this is only empty for an unscored sale).
  const scoreRuns = journey.score_runs ?? [];

  // Conditions under which this score is less trustworthy than it looks. Each
  // one silently changed the result before this fix, so each is now stated
  // plainly on the sale rather than left in the worker logs.
  const scoringCaveats: Array<{ key: string; title: string; detail: string }> = [];
  if (journey.branch) {
    if (journey.crm_stage && journey.branch_source !== 'crm') {
      // The CRM knew the sale's status and the scorecard had no branch for it.
      // Distinct from "no stage at all": this one is a config fix, and it will
      // recur on every sale at that stage until someone makes it.
      scoringCaveats.push({
        key: 'branch',
        title: `The CRM stage "${journey.crm_stage}" isn't mapped to a branch.`,
        detail:
          `This sale was scored as "${journey.branch}" instead, which may apply the wrong ` +
          'checkpoints. Add the stage to the scorecard’s branch settings so future sales at ' +
          'this stage score correctly.',
      });
    } else if (journey.branch_source === 'default') {
      scoringCaveats.push({
        key: 'branch',
        title: `Branch "${journey.branch}" was assumed, not confirmed.`,
        detail:
          'No policy stage came from the CRM and nothing in the calls matched a branch keyword, ' +
          'so the default branch was used. Checkpoints that only apply to the other branch may ' +
          'have been scored, and its own checkpoints marked N/A.',
      });
    } else if (journey.branch_source === 'keyword') {
      scoringCaveats.push({
        key: 'branch',
        title: `Branch "${journey.branch}" came from the transcript, not the CRM.`,
        detail:
          'A phrase in the calls matched this branch. Confirm it against the policy stage in the CRM ' +
          'if the checkpoint set looks wrong.',
      });
    }
  }
  const unreliableSpeakerCalls = journey.calls.filter((c) => c.speaker_integrity_flag);
  if (unreliableSpeakerCalls.length > 0) {
    scoringCaveats.push({
      key: 'speakers',
      title: `Speaker labels are unreliable on ${unreliableSpeakerCalls.length} of ${journey.calls.length} calls.`,
      detail:
        'Automated checks found adviser and customer turns mixed up in the transcript. Any checkpoint ' +
        'that depends on who said something may be wrong, and consent checkpoints were sent to manual review.',
    });
  }

  // Default to the work: what the reviewer has to settle or defend. Falls back
  // to everything on a sale where nothing needs attention.
  const activeFilter: Filter = filter ?? (reviewAll.length + failedAll.length > 0 ? 'attention' : 'all');

  const toggleRow = (itemId: string) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const jumpToCheckpoint = (itemId: string) => {
    setFilter('attention');
    setCallFilter(null);
    setOpenRows((prev) => new Set(prev).add(itemId));
    requestAnimationFrame(() => {
      document.getElementById(`checkpoint-${itemId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
  };

  const selectCall = (key: string) => {
    setCallFilter((prev) => (prev === key ? null : key));
    setFilter('all');
  };

  // Groups in the order the reviewer works: what only a human can settle, then
  // the findings worst-first, then the rest in scorecard order.
  const visibleGroups = (
    activeFilter === 'attention'
      ? [
          { title: canAction ? 'Your decision' : 'Waiting for a ruling', items: pendingReview },
          { title: 'Failed, worst first', items: failed },
        ]
      : activeFilter === 'passed'
        ? [{ title: 'Passed', items: passed }]
        : activeFilter === 'na'
          ? [{ title: 'Not applicable', items: notApplicable }]
          : [
              { title: canAction ? 'Your decision' : 'Waiting for a ruling', items: pendingReview },
              { title: 'Failed, worst first', items: failed },
              { title: 'Passed', items: passed },
              { title: 'Not applicable', items: notApplicable },
            ]
  ).filter((g) => g.items.length > 0);

  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'attention', label: 'Needs attention', count: attention.length },
    { key: 'passed', label: 'Passed', count: passed.length },
    { key: 'na', label: 'N/A', count: notApplicable.length },
    { key: 'all', label: 'All', count: attention.length + passed.length + notApplicable.length },
  ];

  const callFilterLabel =
    callFilter === null
      ? null
      : callFilter === NO_CALL
        ? 'No single call'
        : callFilter === OTHER_CALL
          ? 'A call not in this sale'
          : `Call ${callNumbers.get(callFilter)}`;

  // ---- after-the-review summaries -------------------------------------------
  const coaching = parseCoaching(journey.coaching);
  const coachingSummary = coaching
    ? coaching.summary
    : journey.coaching != null
      ? 'A brief was produced but could not be read.'
      : 'No coaching was generated for this sale.';

  const captureRun = capture?.run ?? null;
  const captureAnswers = capture?.answers ?? [];
  const captureSummary = captureError
    ? "Couldn't load the data capture record"
    : !captureRun
    ? null
    : captureRun.status === 'completed'
      ? [
          `${captureAnswers.filter((a) => a.result === 'captured' || a.result === 'confirmed_only').length} of ${captureAnswers.length} answers captured`,
          captureAnswers.some((a) => a.result === 'missed' && a.required)
            ? `${captureAnswers.filter((a) => a.result === 'missed' && a.required).length} required missed`
            : null,
          captureAnswers.some((a) => a.result === 'manual_review')
            ? `${captureAnswers.filter((a) => a.result === 'manual_review').length} to review`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : captureRun.status === 'needs_form'
        ? 'No question set matched this sale yet'
        : captureRun.status === 'failed'
          ? 'The capture run failed'
          : 'Capturing answers…';

  const recRun = reconciliation?.run ?? null;
  const recItems = reconciliation?.items ?? [];
  const recFlagged = recItems.filter(
    (i) =>
      ACTIONABLE_RECONCILIATION_OUTCOMES.includes(i.outcome) ||
      i.amendment_type === 'disclosure_withdrawn'
  ).length;
  // Only a 'match' was actually checked and agreed. "Could not verify" and the
  // presence-only outcomes were never compared, so they are counted as what
  // they are rather than folded into a reassuring total.
  const recMatched = recItems.filter((i) => i.outcome === 'match').length;
  const recUnverified = recItems.filter((i) => i.outcome === 'undetermined').length;
  const recNotCompared = recItems.filter(
    (i) => i.outcome === 'recorded' || i.outcome === 'no_application_answer'
  ).length;
  const recCompletedSummary =
    recItems.length === 0
      ? 'No questions were found on the application'
      : [
          recFlagged > 0 ? `${recFlagged} need attention` : null,
          `${recMatched} match`,
          recUnverified > 0 ? `${recUnverified} could not verify` : null,
          recNotCompared > 0 ? `${recNotCompared} not compared` : null,
        ]
          .filter(Boolean)
          .join(' · ');
  const recSummary = reconciliationError
    ? "Couldn't load the reconciliation record"
    : !recRun
      ? null
      : ({
          completed: recCompletedSummary,
          pending: 'Queued to compare the application with the calls',
          running: 'Comparing the application with the calls…',
          needs_document: 'Waiting for the application to be attached in the CRM',
          needs_profile: 'This application format needs confirming before it can be compared',
          summary_only: 'This insurer returns a summary, not a question set',
          identity_mismatch: 'The application and the calls are about different people',
          failed: 'The comparison failed',
          abandoned: 'Never checked — no application was attached',
        } as Record<string, string>)[recRun.status] ?? 'See the comparison';

  const fb = feedbackState?.feedback ?? null;
  const anyRecipient = (feedbackState?.recipients ?? []).some((r) => r.eligible);
  const findingsCount = feedbackState ? plural(feedbackState.breach_count, 'finding') : '';
  const feedbackSummary = feedbackError
    ? "Couldn't load the feedback status"
    : !feedbackState
      ? 'Loading…'
      : fb?.confirmed_at
        ? `${fb.adviser_name} confirmed on ${dayMonth(fb.confirmed_at)}`
        : fb
          ? `Sent to ${fb.adviser_name} on ${dayMonth(fb.sent_at)} · awaiting their confirmation`
          : !anyRecipient
            ? "Can't be sent: nobody on the team has an email address"
            : feedbackState.adviser.problem === 'no_adviser'
              ? `Not sent yet · ${findingsCount} — choose who to send them to`
              : feedbackState.adviser.problem === 'no_email'
                ? `Not sent yet · ${feedbackState.adviser.name} has no email address — choose someone else`
                : `Not sent yet · ${findingsCount} ready for ${feedbackState.adviser.name}`;
  const feedbackAction = fb || !anyRecipient || feedbackError ? 'Show' : 'Review and send';

  const menuItems = [
    ...(isAdmin && !fedBack
      ? [
          {
            label: rescoreMutation.isPending || journey.status === 'scoring' ? 'Re-scoring…' : 'Re-score this sale',
            onSelect: () => void handleRescore(),
            disabled:
              rescoreMutation.isPending ||
              journey.status === 'scoring' ||
              journey.status === 'pending',
            hint: 'Re-runs the AI on the same calls and updates the CRM',
          },
        ]
      : []),
    ...(canAction && scored && canLearn
      ? [
          {
            label: journey.is_exemplar ? 'Remove the exemplar mark' : 'Mark as a firm exemplar',
            onSelect: () => void handleToggleExemplar(),
            hint: journey.is_exemplar
              ? 'Stops this sale being shown to the AI as an example'
              : 'Shown to the AI as an example of what good looks like',
          },
        ]
      : []),
  ];

  const verdictKnown = !scoreOnly && journey.pass != null;
  // The pass gate is two rules (scoring.ts callPasses): at or above the pass
  // mark, and no critical failure. When the score clears the mark but the sale
  // still failed, say which rule decided it — otherwise "82%, Fail" reads as a
  // contradiction.
  const failedOnCritical =
    verdictKnown && journey.pass === false && criticalCount > 0 && Number(journey.overall_score) >= passMark;

  return (
    <div>
      <Link
        to="/journeys"
        className="inline-flex items-center gap-1.5 text-table-cell text-text-secondary hover:text-text-primary mb-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Sales
      </Link>

      {/* Header: who the sale is with, and the step the review ends on. */}
      <div className="flex flex-wrap justify-between items-start gap-x-6 gap-y-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-page-title text-text-primary">
            Sale
            {customerLabel && (
              <>
                {' — '}
                <Link
                  to={`/customers/${journey.customer_id}`}
                  className="text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                >
                  {customerLabel}
                </Link>
              </>
            )}
            {journey.is_exemplar && (
              <span className="ml-2.5 align-middle inline-flex items-center gap-1 px-2.5 py-[3px] rounded-full text-badge font-semibold bg-secondary-bg text-secondary">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                </svg>
                Exemplar
              </span>
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-table-cell text-text-secondary">
            {advisers.length > 0 && (
              <>
                <span>
                  {advisers.length === 1 ? 'Adviser' : 'Advisers'}{' '}
                  <span className="text-text-primary">{advisers.join(', ')}</span>
                  {unattributedCalls > 0 && ` (${plural(unattributedCalls, 'call')} with no adviser)`}
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>{callSpan}</span>
            {journey.products && journey.products.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {journey.products.map((p) => p.product_name).join(', ')}
                  {journey.product_source === 'ai' ? ' (inferred from the calls)' : ''}
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{TRIGGER_LABELS[journey.trigger_source] ?? journey.trigger_source}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* The only export/print affordance on this page. Scored-only: an
              unscored sale has no checkpoint verdicts or findings yet to put
              in front of an insurer or the Ombudsman. */}
          {scored && (
            <Link
              to={`/journeys/${journey.id}/claims-defence`}
              className="inline-flex items-center gap-1.5 whitespace-nowrap px-4 py-2 rounded-btn text-table-cell font-semibold border border-border bg-card text-text-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 3v4a1 1 0 0 0 1 1h4M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5ZM9 15l3 3 3-3M12 11v7" />
              </svg>
              Claims-defence pack
            </Link>
          )}
          {scored && (
            <FeedbackHeaderAction journeyId={journey.id} canAction={canAction} onOpen={openFeedback} />
          )}
          <ActionMenu items={menuItems} label="More actions for this sale" />
        </div>
      </div>

      {journey.status === 'failed' && journey.error_message && (
        <div className="bg-fail-bg rounded-card p-4 mb-4" role="alert">
          <div className="text-table-cell font-semibold text-fail">Scoring failed</div>
          <div className="text-table-cell text-fail mt-1">{journey.error_message}</div>
        </div>
      )}

      {(journey.status === 'pending' || journey.status === 'scoring') && (
        <div className="bg-card border border-border rounded-card p-10 text-center mb-4" aria-live="polite">
          <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <div className="text-base font-semibold text-text-primary">
            {journey.status === 'pending' ? 'Queued for scoring' : 'Scoring the sale'}
          </div>
        </div>
      )}

      {scored && (
        <section aria-label="Result">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <StatTile label="Overall score">
              <span className="flex items-center gap-2.5">
                <span className="text-card-value text-text-primary tabular-nums">
                  {/* Rounded down: 69.6 shown as "70%" beside "Fail" and a 70% pass
                      mark reads as a contradiction. */}
                  {journey.overall_score != null ? `${Math.floor(Number(journey.overall_score))}%` : '—'}
                </span>
                {verdictKnown && <ItemResultBadge result={journey.pass ? 'pass' : 'fail'} />}
              </span>
              <span className="hidden sm:block text-table-cell text-text-secondary">
                {verdictKnown && (
                  <>
                    {failedOnCritical
                      ? `Pass mark ${passMark}% — failed on a critical checkpoint`
                      : `Pass mark ${passMark}%`}
                    <br />
                  </>
                )}
                {journey.scored_at && <>Scored {dayMonth(journey.scored_at)}</>}
                {scoreRuns.length > 1 && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      onClick={() => setHistoryOpen((v) => !v)}
                      aria-expanded={historyOpen}
                      aria-controls="score-history"
                      className="font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      {scoreRuns.length} runs
                    </button>
                  </>
                )}
              </span>
            </StatTile>

            <StatTile label="Failed">
              <span className={`text-card-value tabular-nums ${failedAll.length > 0 ? 'text-fail' : 'text-text-primary'}`}>
                {failedAll.length}{' '}
                <span className="text-table-cell font-medium text-text-secondary">of {items.length}</span>
              </span>
              {/* On a phone only the critical count survives: it is the one
                  number that changes what the sale means. */}
              {criticalCount > 0 && (
                <span className="sm:hidden text-xs font-semibold text-fail">{criticalCount} critical</span>
              )}
              <span className="hidden sm:block text-table-cell text-text-secondary">
                {severityCounts.length === 0
                  ? 'Nothing failed on this sale'
                  : severityCounts.map((c, i) => (
                      <span key={c.sev}>
                        {i > 0 && ' · '}
                        <span className={c.sev === 'critical' ? 'text-fail font-semibold' : ''}>
                          {c.n} {c.sev}
                        </span>
                      </span>
                    ))}
              </span>
            </StatTile>

            <StatTile label={canAction ? 'Waiting on you' : 'Waiting for review'}>
              <span className={`text-card-value tabular-nums ${reviewAll.length > 0 ? 'text-review' : 'text-text-primary'}`}>
                {reviewAll.length}
              </span>
              <span className="hidden sm:block text-table-cell text-text-secondary">
                {!firstReview ? (
                  'Nothing needs a human ruling'
                ) : (
                  <>
                    <span className="line-clamp-1">{firstReview.label}</span>
                    <button
                      type="button"
                      onClick={() => jumpToCheckpoint(firstReview.id)}
                      className="font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      {reviewAll.length === 1 ? 'Go to it' : `Go to the first of ${reviewAll.length}`}
                    </button>
                  </>
                )}
              </span>
            </StatTile>
          </div>

          {/* Caveats qualify the whole result, so they sit with it — one line,
              with the detail a click away. */}
          {scoringCaveats.length > 0 && (
            <div className="mt-2.5 text-table-cell text-text-secondary">
              <p className="flex items-start gap-2">
                <WarningIcon className="w-4 h-4 text-review shrink-0 mt-0.5" />
                <span>
                  <span className="font-semibold text-text-primary">Read with care:</span>{' '}
                  {scoringCaveats.map((c) => c.title).join(' ')}{' '}
                  <button
                    type="button"
                    onClick={() => setCaveatsOpen((v) => !v)}
                    aria-expanded={caveatsOpen}
                    aria-controls="scoring-caveats"
                    className="font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                  >
                    {caveatsOpen ? 'Hide detail' : 'Why'}
                  </button>
                </span>
              </p>
              {caveatsOpen && (
                <ul id="scoring-caveats" className="mt-2 ml-6 space-y-1.5 max-w-3xl">
                  {scoringCaveats.map((c) => (
                    <li key={c.key}>{c.detail}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Scoring history. Offered once a sale has been scored more than
              once, because that is the only time the current number needs
              explaining: AI scoring genuinely is not reproducible run to run,
              and an unexplained change to a compliance score is the thing a
              regulated firm cannot accept. */}
          {historyOpen && scoreRuns.length > 1 && (
            <div id="score-history" className="bg-card border border-border rounded-card overflow-hidden mt-3">
              <p className="px-5 pt-4 text-table-cell text-text-secondary max-w-3xl">
                AI scoring is not fully repeatable, so re-running it can reach a different result on
                the same evidence. Every run is kept here. A change in the checkpoint count means a
                different set of checkpoints applied, not just a different verdict on the same ones.
              </p>
              <div className="overflow-x-auto mt-3">
                <table className="w-full">
                  <thead>
                    <tr className="bg-table-header">
                      {['Run', 'Score', 'Change', 'Checkpoints', 'Calls', 'Run by', 'When'].map((h) => (
                        <th key={h} scope="col" className="text-left text-table-header uppercase text-text-secondary px-5 py-2.5">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scoreRuns.map((run, i) => {
                      // score_runs arrives newest-first, so the run to compare
                      // against is the next entry in the list.
                      const prev = scoreRuns[i + 1];
                      const change =
                        prev && run.overall_score != null && prev.overall_score != null
                          ? Number(run.overall_score) - Number(prev.overall_score)
                          : null;
                      const runScored = (run.items_passed ?? 0) + (run.items_failed ?? 0);
                      return (
                        <tr key={run.id} className="border-b border-border-light last:border-0">
                          <td className="px-5 py-3 text-table-cell text-text-secondary">{run.run_number}</td>
                          <td className="px-5 py-3 text-table-cell font-semibold text-text-primary tabular-nums">
                            {run.overall_score == null ? '—' : `${Number(run.overall_score).toFixed(2)}%`}
                          </td>
                          <td className="px-5 py-3 text-table-cell tabular-nums">
                            {change == null ? (
                              <span className="text-text-secondary">—</span>
                            ) : (
                              // Signed text, not colour alone — the sign carries
                              // the meaning for anyone who cannot separate the hues.
                              <span className={change > 0 ? 'text-pass' : change < 0 ? 'text-fail' : 'text-text-secondary'}>
                                {change > 0 ? '+' : ''}{change.toFixed(2)}
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-table-cell text-text-secondary">
                            {runScored > 0 ? `${run.items_passed ?? 0}/${runScored} passed` : '—'}
                          </td>
                          <td className="px-5 py-3 text-table-cell text-text-secondary">{run.calls_scored ?? '—'}</td>
                          <td className="px-5 py-3 text-table-cell text-text-secondary">
                            {run.trigger_source === 'initial'
                              ? 'Automatic'
                              : run.triggered_by_name ?? (run.trigger_source === 'bulk' ? 'Bulk re-score' : 'Re-score')}
                          </td>
                          <td className="px-5 py-3 text-table-cell text-text-secondary">{dateAndTime(run.created_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-4 items-start mt-4">
        <div className="space-y-4 min-w-0">
        {/* Checkpoints */}
        <section className="bg-card border border-border rounded-card overflow-hidden" aria-labelledby="checkpoints-title">
          <h3 id="checkpoints-title" className="sr-only">Checkpoints</h3>
          {items.length > 0 && (
            <div className="px-3 py-2.5 border-b border-border flex flex-wrap items-center gap-1">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  aria-pressed={activeFilter === f.key}
                  className={`inline-flex items-center gap-2 min-h-[32px] px-3 py-1.5 rounded-btn text-table-cell transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    activeFilter === f.key
                      ? 'bg-primary-light text-text-primary font-semibold'
                      : 'text-text-secondary hover:bg-sidebar-hover'
                  }`}
                >
                  {f.label}
                  <span
                    className={`text-badge tabular-nums px-1.5 rounded-full ${
                      activeFilter === f.key ? 'bg-card text-text-primary' : 'bg-table-header text-text-secondary'
                    }`}
                  >
                    {f.count}
                  </span>
                </button>
              ))}
              {callFilterLabel && (
                <button
                  type="button"
                  onClick={() => setCallFilter(null)}
                  aria-label={`Stop filtering to ${callFilterLabel}`}
                  className="ml-auto inline-flex items-center gap-1.5 min-h-[32px] px-3 py-1.5 rounded-full border border-border text-table-cell text-text-primary hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {callFilterLabel}
                  <svg className="w-3.5 h-3.5 text-text-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {items.length === 0 && (
            <div className="px-5 py-12 text-center text-text-secondary text-table-cell">
              {journey.status === 'pending' || journey.status === 'scoring'
                ? 'Checkpoints appear once scoring completes.'
                : 'No checkpoints on this scorecard.'}
            </div>
          )}

          {items.length > 0 && visibleGroups.length === 0 && (
            <div className="px-5 py-12 text-center text-text-secondary text-table-cell">
              {activeFilter === 'attention'
                ? callFilterLabel
                  ? `Nothing needs attention on ${callFilterLabel}.`
                  : 'Nothing failed and nothing is waiting on a ruling for this sale.'
                : 'No checkpoints in this group.'}
            </div>
          )}

          {visibleGroups.map((group) => (
            <div key={group.title}>
              <div className="px-5 pt-4 pb-1.5 flex items-center justify-between">
                <h4 className="text-card-label uppercase text-text-secondary">{group.title}</h4>
                <span className="text-table-cell text-text-secondary tabular-nums">{group.items.length}</span>
              </div>
              {group.items.map((item) => (
                <CheckpointRow
                  key={item.id}
                  item={item}
                  open={openRows.has(item.id)}
                  onToggle={() => toggleRow(item.id)}
                  callLabel={callLabelFor(item.source_call_id)}
                  productNames={productNameList(item.applies_to_products)}
                  canAction={canAction}
                  canCorrect={canAction && canLearn}
                  onCorrect={() =>
                    setCorrectingItem({
                      itemScoreId: item.id,
                      label: item.label,
                      pass: isItemPass(Number(item.normalized_score ?? 0), passMark),
                      evidence: item.evidence,
                    })
                  }
                  onResolve={(result) => resolve(item.id, result)}
                  resolving={resolvingId === item.id}
                  passThreshold={passMark}
                />
              ))}
            </div>
          ))}
        </section>

      {/* After the review: each part states where it stands in one line and
          opens in place. Coaching is written for the adviser, so it follows the
          findings a compliance officer came to check; feedback is last because
          it ends the review. */}
      {/* Only coaching waits for a score. Capture, reconciliation and the
          feedback record belong to the sale, not to the latest scoring run —
          a failed or running re-score must not hide a possible non-disclosure. */}
      {(scored || captureSummary || recSummary || canAction) && (
        <section className="bg-card border border-border rounded-card overflow-hidden" aria-label="After the review">
          {scored && (
          <ReviewSection
            id="sale-section-coaching"
            title="Coaching"
            summary={coachingSummary}
            actionLabel="Show"
            open={openSections.has('coaching')}
            onToggle={() => toggleSection('coaching')}
          >
            <CoachingPanel
              coaching={journey.coaching}
              plan={user?.organization_plan ?? null}
              callStatus="scored"
              isAdmin={isAdmin}
              subject="journey"
              embedded
            />
          </ReviewSection>
          )}

          {captureSummary && (
            <ReviewSection
              id="sale-section-capture"
              title="Data capture"
              summary={captureSummary}
              actionLabel="Show"
              open={openSections.has('capture')}
              onToggle={() => toggleSection('capture')}
            >
              <CapturePanel journeyId={journey.id} isAdmin={isAdmin} embedded />
            </ReviewSection>
          )}

          {recSummary && (
            <ReviewSection
              id="sale-section-reconciliation"
              title="Reconciliation"
              summary={
                recRun?.status === 'completed' && recFlagged > 0 ? (
                  <span>
                    <span className="text-fail font-semibold">{recFlagged}</span>
                    {recSummary.slice(String(recFlagged).length)}
                  </span>
                ) : (
                  recSummary
                )
              }
              actionLabel="Show"
              open={openSections.has('reconciliation')}
              onToggle={() => toggleSection('reconciliation')}
            >
              <ReconciliationPanel journeyId={journey.id} isAdmin={isAdmin} embedded />
            </ReviewSection>
          )}

          {canAction && (
            <ReviewSection
              id="sale-section-feedback"
              title="Adviser feedback"
              summary={feedbackSummary}
              actionLabel={feedbackAction}
              open={openSections.has('feedback')}
              onToggle={() => toggleSection('feedback')}
            >
              <FeedbackPanel journeyId={journey.id} canAction={canAction} composeSignal={composeSignal} embedded />
            </ReviewSection>
          )}
        </section>
      )}

        </div>

        {/* Context that stays in view while the checkpoints are worked through. */}
        <div className="space-y-4 lg:sticky lg:top-4">
          <section className="bg-card border border-border rounded-card overflow-hidden" aria-labelledby="calls-title">
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-2">
              <h3 id="calls-title" className="text-section-title text-text-primary">Calls</h3>
              {scored && <span className="text-xs text-text-secondary">Select one to filter</span>}
            </div>
            {journey.calls.length === 0 && (
              <p className="px-5 py-4 text-table-cell text-text-secondary">No calls linked.</p>
            )}
            {[
              ...journey.calls.map((c) => c.id),
              ...(perCall.has(OTHER_CALL) ? [OTHER_CALL] : []),
              ...(perCall.has(NO_CALL) ? [NO_CALL] : []),
            ].map((key) => {
              const call = journey.calls.find((c) => c.id === key) ?? null;
              const number = call ? callNumbers.get(call.id) : undefined;
              const counts = perCall.get(key);
              const selectable = !call || number !== undefined;
              const selected = callFilter === key;
              const title = call
                ? number !== undefined
                  ? `Call ${number}`
                  : 'Not transcribed'
                : key === OTHER_CALL
                  ? 'A call not in this sale'
                  : 'No single call';
              const parts = counts
                ? [
                    counts.fail > 0 ? { text: `${counts.fail} failed`, cls: 'text-fail font-semibold' } : null,
                    counts.review > 0 ? { text: `${counts.review} to review`, cls: 'text-review font-semibold' } : null,
                    counts.pass > 0 ? { text: `${counts.pass} passed`, cls: '' } : null,
                    counts.na > 0 ? { text: `${counts.na} N/A`, cls: '' } : null,
                  ].filter((p): p is { text: string; cls: string } => p !== null)
                : [];
              // A call with no transcript was never shown to the scorer, so it
              // has no checkpoints to count — say why, rather than "none".
              const status =
                call && number === undefined
                  ? `Not scored — ${call.status.replace(/_/g, ' ')}`
                  : !scored
                    ? null
                    : parts.length === 0
                      ? 'None attributed to this call'
                      : null;
              const body = (
                <>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-table-cell font-semibold text-text-primary">{title}</span>
                    {call && (
                      <span className="text-xs text-text-secondary tabular-nums whitespace-nowrap">
                        {dayMonth(call.call_date)} · {formatDuration(call.duration_seconds)}
                        {call.role === 'wrap_up' ? ' · wrap-up' : ''}
                      </span>
                    )}
                  </span>
                  {call && (
                    <span className="block text-xs text-text-secondary mt-0.5 truncate">
                      {call.agent_name ?? 'No adviser recorded'}
                    </span>
                  )}
                  {(status || (scored && parts.length > 0)) && (
                    <span className="block text-xs text-text-secondary mt-0.5 tabular-nums">
                      {status ??
                        parts.map((p, i) => (
                          <span key={p.text}>
                            {i > 0 && ' · '}
                            <span className={p.cls}>{p.text}</span>
                          </span>
                        ))}
                    </span>
                  )}
                  {call?.speaker_integrity_flag && (
                    <span className="block text-xs text-review mt-0.5">Speaker labels unreliable</span>
                  )}
                </>
              );
              return (
                <div key={key} className="relative border-b border-border-light last:border-0">
                  {selectable && scored ? (
                    <button
                      type="button"
                      onClick={() => selectCall(key)}
                      aria-pressed={selected}
                      className={`w-full text-left px-5 py-3 pr-12 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${
                        selected ? 'bg-primary-light' : 'hover:bg-table-header'
                      }`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="px-5 py-3 pr-12">{body}</div>
                  )}
                  {call && (
                    <Link
                      to={`/calls/${call.id}`}
                      aria-label={`Open ${number !== undefined ? `Call ${number}` : 'this call'}`}
                      className="absolute right-2 top-2.5 w-8 h-8 rounded-btn flex items-center justify-center text-text-secondary hover:bg-sidebar-hover hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M7 17 17 7M8 7h9v9" />
                      </svg>
                    </Link>
                  )}
                </div>
              );
            })}
          </section>

          <CaseNotesPanel journeyId={journey.id} canAction={canAction} />
        </div>
      </div>

      {correctingItem && (
        <ScoreCorrectionModal
          kind="journey"
          parentId={journey.id}
          itemScoreId={correctingItem.itemScoreId}
          itemLabel={correctingItem.label}
          currentPass={correctingItem.pass}
          evidence={correctingItem.evidence}
          onClose={() => setCorrectingItem(null)}
        />
      )}
    </div>
  );
}
