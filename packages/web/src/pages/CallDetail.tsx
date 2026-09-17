import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { ActionMenu } from '../components/ActionMenu';
import { AssignAgentDropdown } from '../components/AssignAgentDropdown';
import { AudioPlayer } from '../components/AudioPlayer';
import { CallCheckpointRow, type CallCheckpointItem, type CheckpointPosition } from '../components/CallCheckpointRow';
import { CallTranscript, type TranscriptMarker } from '../components/CallTranscript';
import { CoachingPanel } from '../components/CoachingPanel';
import { FeedbackPanel, FeedbackHeaderAction, useFeedbackState } from '../components/FeedbackPanel';
import { FeedbackStatusBadge } from '../components/FeedbackStatusBadge';
import { ReviewSection } from '../components/ReviewSection';
import { ScoreCorrectionModal } from '../components/ScoreCorrectionModal';
import { ShareLinksPanel } from '../components/ShareLinksPanel';
import { useDialog } from '../components/DialogProvider';
import { formatDuration, formatPhone } from '../lib/format';
import { hasFeature, PASS_THRESHOLD } from '@callguard/shared';
import type {
  Call,
  CallScore,
  CallItemScore,
  CallCoaching,
  CallJourneyContext,
  CallPositionsResponse,
  OrganizationInfo,
} from '@callguard/shared';

type ScoreWithItems = CallScore & {
  coaching: CallCoaching | null;
  item_scores: (CallItemScore & {
    label: string;
    item_description: string;
    score_type: string;
    section?: string | null;
    severity?: CallCheckpointItem['severity'];
  })[];
};

type CallWithJourney = Call & { journey?: CallJourneyContext | null };

type Filter = 'attention' | 'passed' | 'all';
type Pane = 'checkpoints' | 'transcript';

const dayMonthYear = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const timeOfDay = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One call: the checkpoints decided on it, beside the transcript they were
 * decided from.
 *
 * A reviewer opens this page to check a verdict — which means reading the words
 * that produced it, in the order they were said, and hearing them if the
 * wording is doing a lot of work. So the two halves are on screen together and
 * are wired to each other: open a checkpoint and its line is highlighted and
 * the recording cued; press a marker beside a line and the checkpoint opens.
 *
 * A call in a sale is scored on the sale, not on its own (see
 * jobs/processors/score-journey.ts), so the verdict and the score belong to the
 * sale and are stated as the sale's. Only a call a firm scores individually
 * carries its own result.
 */
export function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // ?evidence=<kind>:<item_score_id> — arriving from the review queue to check
  // one checkpoint's quote: open that checkpoint. ?t=<seconds> cues the player
  // for links that carry their own timestamp (reconciliation evidence arrives
  // this way). Parsed defensively: a junk value must not seek to NaN.
  const [searchParams] = useSearchParams();
  const evidenceItemId = (searchParams.get('evidence') ?? '').split(':')[1] ?? null;
  const tParam = Number(searchParams.get('t'));
  const seekSeconds = Number.isFinite(tParam) && tParam > 0 ? tParam : null;

  const { user } = useAuth();
  const scoreOnly = useScoreOnly();
  const queryClient = useQueryClient();
  const { confirm, notify } = useDialog();
  const isAdmin = user?.role === 'admin';
  const canAction = user?.role === 'admin' || user?.role === 'supervisor';
  const canLearn = user ? hasFeature(user.organization_plan, 'ai_learning') : false;
  // Customer profiles are a plan feature; link to one only where it will open.
  const canOpenCustomers = user ? hasFeature(user.organization_plan, 'customer_journey') : false;

  const [openItem, setOpenItem] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('attention');
  const [pane, setPane] = useState<Pane>('checkpoints');
  const [cue, setCue] = useState<{ seconds: number | null; note: string } | null>(null);
  const [openSection, setOpenSection] = useState<'coaching' | 'share' | 'feedback' | null>(null);
  const [correctingItem, setCorrectingItem] = useState<{
    itemScoreId: string;
    label: string;
    pass: boolean;
    evidence: string | null;
  } | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Bumped by the header action. The feedback panel opens its compose box on a
  // change, so the findings are read before anything is sent.
  const [composeSignal, setComposeSignal] = useState(0);

  const { data: call, isLoading: callLoading, isError: callError } = useQuery({
    queryKey: ['call', id],
    queryFn: () => api.get<CallWithJourney>(`/calls/${id}`),
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data?.status;
      // Terminal states: stop polling. 'skipped' is terminal too. A journey
      // call rests at 'transcribed' (scored on the journey, never per-call), so
      // that's terminal here as well — otherwise it would poll forever.
      if (status === 'scored' || status === 'failed' || status === 'skipped') return false;
      if (status === 'transcribed' && data?.journey) return false;
      // 'captured' (awaiting hydration) and a sales_only 'transcribed' call
      // with no journey yet (held until a sale for the customer arrives — see
      // deferToSale in jobs/processors/transcribe.ts) are both resting on an
      // external event with no ETA. Nothing here will change until that
      // arrives, so polling every 3s for as long as the page stays open just
      // burns requests.
      if (status === 'captured') return false;
      if (status === 'transcribed' && !data?.journey && org?.scoring_scope === 'sales_only') return false;
      return 3000;
    },
  });

  const { data: scoresData } = useQuery({
    queryKey: ['call-scores', id],
    queryFn: () => api.get<{ data: ScoreWithItems[] }>(`/calls/${id}/scores`),
    enabled: call?.status === 'scored',
  });

  // Where every checkpoint's quote sits in this call, and the time of each
  // transcript line. Positions only — no transcript text — so it is fetched
  // even for a reviewer who may not read the transcript, who can still be told
  // when something was said and listen to it.
  const { data: positions } = useQuery({
    queryKey: ['call-positions', id],
    queryFn: () => api.get<CallPositionsResponse>(`/calls/${id}/positions`),
    enabled: Boolean(call && (call.transcript_text || call.transcript_restricted)),
    staleTime: 5 * 60 * 1000,
  });

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

  const journey = call?.journey ?? null;
  const scores = scoresData?.data ?? [];
  const primaryScore = scores[0];

  // Feedback on a single call is for firms set to score calls. A firm set to
  // score sales feeds back from the sale — shown in the strip above for a call
  // that belongs to one — and the API refuses a call round for it with a 400.
  // Undecided while the organisation record is still loading, rather than
  // assumed allowed: a flash of the row appearing then disappearing is worse
  // than a beat of delay before it appears at all.
  const callFeedbackAllowed = org !== undefined && org.scoring_scope !== 'sales_only';
  const feedbackSubject = { kind: 'call' as const, id: call?.id ?? '' };
  const { data: feedbackState, isError: feedbackError } = useFeedbackState(
    feedbackSubject,
    // Fetched for any scored call, not only where a new round may be sent: a
    // round sent before the firm changed its setting, or before the call
    // joined a sale, must stay readable (the API returns it with can_send off).
    canAction && call?.status === 'scored'
  );
  const hasCallRound = Boolean(feedbackState?.feedback);
  const showCallFeedback = canAction && ((callFeedbackAllowed && !journey) || hasCallRound);

  const items: CallCheckpointItem[] = useMemo(() => {
    if (journey) {
      return journey.this_call_items.map((i) => ({
        id: i.id,
        label: i.label,
        section: i.section ?? null,
        result: i.result,
        severity: i.severity ?? null,
        evidence: i.evidence,
        reasoning: i.reasoning ?? null,
        normalized_score: i.normalized_score == null ? null : Number(i.normalized_score),
      }));
    }
    return (primaryScore?.item_scores ?? []).map((i) => ({
      id: i.id,
      label: i.label,
      section: i.section ?? null,
      result: i.result,
      severity: i.severity ?? null,
      evidence: i.evidence,
      reasoning: i.reasoning,
      normalized_score: i.normalized_score == null ? null : Number(i.normalized_score),
    }));
  }, [journey, primaryScore]);

  const positionById = useMemo(() => {
    const map = new Map<string, CheckpointPosition>();
    for (const p of positions?.items ?? []) {
      map.set(p.item_score_id, {
        matched: p.matched,
        line_index: p.line_index,
        timestamp_seconds: p.timestamp_seconds,
      });
    }
    return map;
  }, [positions]);

  const lineTimes = useMemo(() => {
    const times: (number | null)[] = [];
    for (const line of positions?.lines ?? []) times[line.index] = line.start_seconds;
    return times;
  }, [positions]);

  const markers = useMemo(() => {
    const map = new Map<number, TranscriptMarker[]>();
    for (const item of items) {
      const at = positionById.get(item.id);
      if (!at?.matched || at.line_index == null) continue;
      const list = map.get(at.line_index) ?? [];
      list.push({ itemScoreId: item.id, label: item.label, result: item.result });
      map.set(at.line_index, list);
    }
    return map;
  }, [items, positionById]);

  // A link from the review queue names the checkpoint to check: open it, rather
  // than leaving the reviewer to find it among forty rows.
  useEffect(() => {
    if (!evidenceItemId || !items.some((i) => i.id === evidenceItemId)) return;
    setOpenItem(evidenceItemId);
    setFilter('all');
  }, [evidenceItemId, items]);

  useEffect(() => {
    if (seekSeconds != null) setCue({ seconds: seekSeconds, note: 'Cued to the moment this link points at.' });
  }, [seekSeconds]);

  const counts = {
    attention: items.filter((i) => i.result !== 'pass' && i.result !== 'na').length,
    passed: items.filter((i) => i.result === 'pass').length,
    all: items.length,
  };

  const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const byPosition = (a: CallCheckpointItem, b: CallCheckpointItem) =>
    (positionById.get(a.id)?.timestamp_seconds ?? Number.MAX_SAFE_INTEGER) -
    (positionById.get(b.id)?.timestamp_seconds ?? Number.MAX_SAFE_INTEGER);

  const shown = useMemo(() => {
    if (filter === 'attention') {
      return items
        .filter((i) => i.result !== 'pass' && i.result !== 'na')
        .sort(
          (a, b) =>
            Number(b.result === 'manual_review') - Number(a.result === 'manual_review') ||
            (SEVERITY_ORDER[a.severity ?? ''] ?? 9) - (SEVERITY_ORDER[b.severity ?? ''] ?? 9) ||
            byPosition(a, b)
        );
    }
    const list = filter === 'passed' ? items.filter((i) => i.result === 'pass') : [...items];
    // In the order they were said: the same order as the transcript beside them.
    return list.sort(byPosition);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, positionById]);

  const selectItem = (itemId: string) => {
    setOpenItem(itemId);
    if (!shown.some((i) => i.id === itemId)) setFilter('all');
    setPane('checkpoints');
    const el = document.getElementById(`call-checkpoint-${itemId}`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // Opening a checkpoint cues the recording to it, and says so — including when
  // there is nothing to cue, which is the usual case for a failure about
  // something that was never said.
  const toggleItem = (item: CallCheckpointItem) => {
    if (openItem === item.id) {
      setOpenItem(null);
      return;
    }
    setOpenItem(item.id);
    const at = positionById.get(item.id);
    if (at?.timestamp_seconds != null) {
      setCue({ seconds: at.timestamp_seconds, note: `Cued to where “${item.label}” was decided.` });
    } else if (at && !at.matched) {
      setCue({
        seconds: null,
        note: `“${item.label}” isn't tied to one line — the AI's wording wasn't found in the transcript.`,
      });
    }
  };

  const handleToggleReviewed = async () => {
    if (!call) return;
    await api.post(`/calls/${call.id}/review`, { reviewed: !call.reviewed_at });
    queryClient.invalidateQueries({ queryKey: ['call', call.id] });
  };

  // Opened from the header. The feedback panel opens its compose box whenever
  // it mounts with a signal above zero, so a stale signal would reopen a form
  // someone just cancelled — cleared here whenever the section is closed.
  const toggleFeedbackSection = () => {
    const wasOpen = openSection === 'feedback';
    if (wasOpen) setComposeSignal(0);
    setOpenSection(wasOpen ? null : 'feedback');
  };

  const openFeedback = () => {
    setOpenSection('feedback');
    setComposeSignal((n) => n + 1);
    // Deferred a frame: the panel mounts when its section opens, and scrolling
    // to it before it has height lands short.
    requestAnimationFrame(() => {
      document.getElementById('call-section-feedback')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  const handleToggleExemplar = async () => {
    if (!call) return;
    await api.post(`/calls/${call.id}/exemplar`, {
      is_exemplar: !call.is_exemplar,
      reason: !call.is_exemplar ? 'Marked by admin' : undefined,
    });
    queryClient.invalidateQueries({ queryKey: ['call', call.id] });
  };

  const handleResolve = async (item: CallCheckpointItem, result: 'pass' | 'fail' | 'na') => {
    setResolving(item.id);
    try {
      // The review queue takes both kinds: a checkpoint on a sale, or one on a
      // call scored on its own.
      await api.post('/review-items/resolve', {
        kind: journey ? 'journey' : 'call',
        item_score_id: item.id,
        result,
      });
      queryClient.invalidateQueries({ queryKey: ['call', id] });
      queryClient.invalidateQueries({ queryKey: ['call-scores', id] });
      if (journey) queryClient.invalidateQueries({ queryKey: ['journey', journey.id] });
    } catch (err) {
      await notify('Could not save that verdict: ' + (err instanceof Error ? err.message : 'unknown error'));
    } finally {
      setResolving(null);
    }
  };

  const handleDelete = async () => {
    if (!call) return;
    const ok = await confirm(
      `Delete this call permanently?\n\n"${call.file_name}"\n\nThis removes the audio, transcript, scores, breaches, and any corrections. This cannot be undone.`,
      { danger: true, confirmLabel: 'Delete' }
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/calls/${call.id}`);
      queryClient.invalidateQueries({ queryKey: ['calls'] });
      navigate('/calls');
    } catch (err) {
      setDeleting(false);
      await notify('Failed to delete call: ' + (err instanceof Error ? err.message : 'unknown error'));
    }
  };

  if (callError || (!callLoading && !call)) {
    return (
      <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
        Could not load this call.{' '}
        <Link
          to="/calls"
          className="text-primary-ink underline font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Back to Calls
        </Link>
      </div>
    );
  }

  if (!call) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted" aria-busy="true">
        <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mr-3" />
        Loading this call
      </div>
    );
  }

  const processing = call.status === 'uploaded' || call.status === 'transcribing' || call.status === 'scoring';
  const transcriptShown = Boolean(call.transcript_text) && !call.transcript_restricted;
  const duration = call.duration_seconds == null ? null : Number(call.duration_seconds);
  const when = call.call_date ?? call.created_at;
  const highlightIndex =
    openItem != null ? (positionById.get(openItem)?.line_index ?? null) : null;

  // One line saying where this call's own feedback round stands — same states
  // and the same honest style as the sale page's row, since a call scored on
  // its own goes through the same loop.
  const feedbackFb = feedbackState?.feedback ?? null;
  const anyFeedbackRecipient = (feedbackState?.recipients ?? []).some((r) => r.eligible);
  const feedbackFindingsCount = feedbackState ? plural(feedbackState.breach_count, 'finding') : '';
  const feedbackSummary = feedbackError
    ? "Couldn't load the feedback status"
    : !feedbackState
      ? 'Loading…'
      : // A round sent to someone this call is no longer credited to does not
        // settle it (services/journey-feedback.ts feedbackReachedCloserSql), so
        // the row must not read as fed back.
        feedbackFb?.reached_adviser === false
        ? `Not fed back to ${feedbackState.adviser.name} · an earlier round went to ${feedbackFb.adviser_name}`
        : feedbackFb?.confirmed_at
        ? `${feedbackFb.adviser_name} confirmed on ${dayMonth(feedbackFb.confirmed_at)}`
        : feedbackFb
          ? `Sent to ${feedbackFb.adviser_name} on ${dayMonth(feedbackFb.sent_at)} · awaiting their confirmation`
          : !anyFeedbackRecipient
            ? "Can't be sent: nobody on the team has an email address"
            : feedbackState.adviser.problem === 'no_adviser'
              ? `Not sent yet · ${feedbackFindingsCount} — choose who to send them to`
              : feedbackState.adviser.problem === 'no_email'
                ? `Not sent yet · ${feedbackState.adviser.name} has no email address — choose someone else`
                : `Not sent yet · ${feedbackFindingsCount} ready for ${feedbackState.adviser.name}`;
  const feedbackAction = feedbackFb || !anyFeedbackRecipient || feedbackError ? 'Show' : 'Review and send';

  const menuItems = [
    ...(canAction && call.status === 'scored'
      ? [{ label: call.reviewed_at ? 'Clear reviewed' : 'Mark reviewed', onSelect: handleToggleReviewed }]
      : []),
    ...(canAction && call.status === 'scored' && canLearn
      ? [
          {
            label: call.is_exemplar ? 'Remove exemplar' : 'Mark as exemplar',
            hint: 'Shown to the AI as an example of how your firm reads the scorecard',
            onSelect: handleToggleExemplar,
          },
        ]
      : []),
    ...(isAdmin
      ? [{ label: deleting ? 'Deleting…' : 'Delete call', disabled: deleting, onSelect: handleDelete }]
      : []),
  ];

  return (
    <div>
      <Link
        to={journey ? `/journeys/${journey.id}` : '/calls'}
        className="inline-flex items-center gap-1.5 text-table-cell text-text-secondary hover:text-text-primary mb-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {journey ? `Sale${journey.client_name ? ` — ${journey.client_name}` : ''}` : 'Calls'}
      </Link>

      {/* Which call this is, in the words a reviewer would use for it. The
          recording's file name is a dialler id and belongs in the menu. */}
      <div className="flex flex-wrap justify-between items-start gap-x-6 gap-y-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-page-title text-text-primary">
            {journey && journey.call_number != null
              ? `Call ${journey.call_number} of ${journey.call_total}`
              : 'Call'}
            {journey?.client_name && <span className="text-text-secondary"> · {journey.client_name}</span>}
            {call.is_exemplar && (
              <span className="ml-2.5 align-middle inline-flex items-center gap-1 px-2.5 py-[3px] rounded-full text-badge font-semibold bg-secondary-bg text-secondary">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                </svg>
                Exemplar
              </span>
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-table-cell text-text-secondary">
            <span>
              {dayMonthYear(when)}, {timeOfDay(when)}
            </span>
            {duration != null && duration > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatDuration(duration)}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            {isAdmin ? (
              <span className="inline-flex items-center gap-1.5">
                Adviser
                <AssignAgentDropdown callId={call.id} currentAgentId={call.agent_id} />
              </span>
            ) : (
              <span>Adviser {call.agent_name ?? 'not recorded'}</span>
            )}
            {call.customer_id && canOpenCustomers && (
              <>
                <span aria-hidden="true">·</span>
                <Link
                  to={`/customers/${call.customer_id}`}
                  className="text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                >
                  {call.customer_name?.trim() || formatPhone(call.customer_phone) || 'Customer'}
                </Link>
              </>
            )}
            {call.reviewed_at && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-pass font-semibold">Reviewed</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {journey && (
            <Link
              to={`/journeys/${journey.id}`}
              className="inline-flex items-center gap-1.5 whitespace-nowrap px-4 py-2 rounded-btn text-table-cell font-semibold border border-border bg-card text-text-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Open the sale
            </Link>
          )}
          {call.status === 'scored' && showCallFeedback && (
            <FeedbackHeaderAction subject={feedbackSubject} canAction={canAction} onOpen={openFeedback} />
          )}
          {menuItems.length > 0 && <ActionMenu items={menuItems} />}
        </div>
      </div>

      {processing && (
        <div className="bg-card border border-border rounded-card p-10 text-center mb-6">
          <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <div className="text-base font-semibold text-text-primary mb-1">
            {call.status === 'uploaded' && 'Queued for processing'}
            {call.status === 'transcribing' && 'Transcribing the recording'}
            {call.status === 'scoring' && 'Scoring against the scorecard'}
          </div>
          <div className="text-table-cell text-text-muted">
            {duration != null && duration > 600
              ? 'A call this long usually takes a few minutes'
              : 'This usually takes less than a minute'}
          </div>
        </div>
      )}

      {call.status === 'captured' && (
        <div className="bg-table-header border border-border rounded-card p-4 mb-6">
          <div className="text-table-cell font-semibold text-text-primary">Waiting for a sale</div>
          <div className="text-xs text-text-secondary mt-1">
            Your firm scores sales rather than single calls. This call is kept and will be transcribed and
            scored when the sale it belongs to arrives from your CRM.
          </div>
        </div>
      )}

      {call.status === 'transcribed' && !journey && org?.scoring_scope === 'sales_only' && (
        <div className="bg-table-header border border-border rounded-card p-4 mb-6">
          <div className="text-table-cell font-semibold text-text-primary">Held until a sale arrives</div>
          <div className="text-xs text-text-secondary mt-1">
            Your firm scores sales, so this call is scored when a sale for the customer reaches CallGuard.
          </div>
        </div>
      )}

      {call.status === 'failed' && (
        <div className="bg-fail-bg border border-fail/30 rounded-card p-4 mb-6">
          <div className="text-table-cell font-semibold text-fail">Processing failed</div>
          {call.error_message && <div className="text-xs text-flag-text mt-1">{call.error_message}</div>}
          <div className="text-xs text-text-secondary mt-2">
            Ask an administrator to re-process the call, or upload the recording again.
          </div>
        </div>
      )}

      {call.status === 'skipped' && (
        <div className="bg-table-header border border-border rounded-card p-4 mb-6">
          <div className="text-table-cell font-semibold text-text-secondary">Not scored — call too short</div>
          <div className="text-xs text-text-muted mt-1">
            {call.error_message || 'This call was too short to evaluate against a scorecard and was skipped.'}
          </div>
        </div>
      )}

      {/* Where the result lives. For a call in a sale that is the sale, stated
          as the sale's; for a call scored on its own it is this call's. */}
      {journey && (
        <div className="bg-card border border-border rounded-card px-5 py-4 mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="text-table-cell text-text-secondary">Scored with the sale</span>
          {journey.overall_score != null && (
            <span className="text-card-value text-text-primary tabular-nums">
              {Math.floor(Number(journey.overall_score))}%
            </span>
          )}
          {!scoreOnly && journey.status === 'scored' && journey.pass != null && (
            <span
              className={`inline-flex items-center px-2.5 py-[3px] rounded-full text-badge font-semibold ${
                journey.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
              }`}
            >
              {journey.pass ? 'Passed' : 'Failed'}
            </span>
          )}
          <span className="text-table-cell text-text-secondary flex-1 min-w-[200px]">
            {items.length > 0
              ? `${counts.attention} of ${items.length} checkpoints on this call need attention`
              : 'No checkpoint on the sale was decided on this call'}
          </span>
          {journey.feedback_status && <FeedbackStatusBadge status={journey.feedback_status} />}
        </div>
      )}

      {!journey && primaryScore && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Tile
            label="Overall score"
            value={primaryScore.overall_score == null ? '—' : `${Math.floor(Number(primaryScore.overall_score))}%`}
            sub={
              scoreOnly || primaryScore.pass == null ? (
                `Pass mark ${passMark}%`
              ) : (
                <span className={primaryScore.pass ? 'text-pass font-semibold' : 'text-fail font-semibold'}>
                  {primaryScore.pass ? 'Passed' : 'Failed'} · pass mark {passMark}%
                </span>
              )
            }
          />
          <Tile
            label="Failed"
            value={`${items.filter((i) => i.result === 'fail').length} of ${items.length}`}
            sub={severitySummary(items)}
          />
          <Tile
            label="Waiting on you"
            value={String(items.filter((i) => i.result === 'manual_review').length)}
            sub="Verdicts held for a person"
          />
        </div>
      )}

      {/* Phone: the two halves are tabs, because neither is readable at a third
          of a screen and a transcript nested in a scrolling page is worse. */}
      {(items.length > 0 || transcriptShown) && (
        <div className="lg:hidden sticky top-0 z-10 bg-page py-2 -mt-2 mb-2">
          <div className="grid grid-cols-2 gap-1 p-1 bg-card border border-border rounded-btn">
            {(['checkpoints', 'transcript'] as Pane[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPane(p)}
                aria-pressed={pane === p}
                className={`min-h-[36px] rounded-btn text-table-cell font-semibold transition-colors ${
                  pane === p ? 'bg-primary-light text-text-primary' : 'text-text-secondary hover:bg-table-header'
                }`}
              >
                {p === 'checkpoints' ? `Checkpoints${items.length ? ` (${items.length})` : ''}` : 'Transcript'}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4 items-start">
        <section
          aria-label="Checkpoints decided on this call"
          className={`bg-card border border-border rounded-card overflow-hidden ${
            pane === 'checkpoints' ? '' : 'hidden'
          } lg:block`}
        >
          {items.length === 0 ? (
            <div className="px-5 py-8 space-y-3">
              <h3 className="text-section-title text-text-primary">
                {journey ? 'No checkpoint was decided on this call' : 'Nothing has been scored on this call'}
              </h3>
              <p className="text-table-cell text-text-secondary leading-relaxed max-w-prose">
                {journey
                  ? 'The sale was scored across all of its calls, and every verdict came from what was said on another one. This call was read too.'
                  : processing
                    ? 'The scorecard runs once the recording has been transcribed.'
                    : 'No scorecard result is stored for this call.'}
              </p>
              {journey && journey.siblings.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {journey.siblings.map((s) => (
                    <Link
                      key={s.id}
                      to={`/calls/${s.id}`}
                      className="inline-flex items-center gap-2 min-h-[32px] px-3 py-1.5 rounded-btn border border-border text-table-cell font-semibold text-text-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      {s.call_number != null ? `Call ${s.call_number}` : 'Untranscribed call'}
                      <span className="font-normal text-text-secondary">
                        {s.item_count} checkpoint{s.item_count === 1 ? '' : 's'}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
                <h3 className="text-section-title text-text-primary">Checkpoints from this call</h3>
                <p className="text-xs text-text-secondary">
                  {filter === 'attention' ? 'Worst first' : 'In the order they were said'}
                </p>
              </div>
              <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-border">
                {(
                  [
                    ['attention', 'Needs attention'],
                    ['passed', 'Passed'],
                    ['all', 'All'],
                  ] as [Filter, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    aria-pressed={filter === key}
                    className={`inline-flex items-center gap-2 min-h-[32px] px-3 py-1.5 rounded-btn text-table-cell transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      filter === key
                        ? 'bg-primary-light text-text-primary font-semibold'
                        : 'text-text-secondary hover:bg-table-header'
                    }`}
                  >
                    {label}
                    <span
                      className={`text-xs font-semibold px-1.5 rounded-full ${
                        filter === key ? 'bg-card text-text-primary' : 'bg-table-header text-text-secondary'
                      }`}
                    >
                      {counts[key]}
                    </span>
                  </button>
                ))}
              </div>
              {shown.length === 0 ? (
                <p className="px-5 py-6 text-table-cell text-text-secondary">
                  Nothing on this call needs attention.
                </p>
              ) : (
                shown.map((item) => (
                  <CallCheckpointRow
                    key={item.id}
                    item={item}
                    position={positionById.get(item.id)}
                    open={openItem === item.id}
                    onToggle={() => toggleItem(item)}
                    onShowInTranscript={() => setPane('transcript')}
                    transcriptShown={transcriptShown}
                    canAction={canAction}
                    canCorrect={canAction && canLearn}
                    onCorrect={() =>
                      setCorrectingItem({
                        itemScoreId: item.id,
                        label: item.label,
                        pass: item.result === 'pass',
                        evidence: item.evidence,
                      })
                    }
                    onResolve={(result) => handleResolve(item, result)}
                    resolving={resolving === item.id}
                    passThreshold={passMark}
                    scoredOn={journey ? 'sale' : 'call'}
                  />
                ))
              )}
            </>
          )}
        </section>

        <div className={`${pane === 'transcript' ? '' : 'hidden'} lg:block lg:sticky lg:top-4`}>
          {transcriptShown && call.transcript_text && (
            <CallTranscript
              callId={call.id}
              transcript={call.transcript_text}
              lineTimes={lineTimes}
              markers={markers}
              highlightIndex={highlightIndex}
              cue={cue}
              onCue={(seconds, note) => setCue({ seconds, note })}
              onSelectMarker={selectItem}
              hasAudio={Boolean(call.file_key)}
              durationSeconds={duration}
              label={`Call ${journey?.call_number ?? ''}`.trim()}
              className="lg:max-h-[calc(100vh-2rem)]"
            />
          )}

          {/* Withheld rather than absent. Said plainly, because "no transcript"
              and "you are not permitted to read this transcript" send someone
              looking in completely different places. Audio stays available: the
              restriction is on the stored readable record, not on listening. */}
          {call.transcript_restricted && (
            <section aria-label="Recording" className="bg-card border border-border rounded-card overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <h3 className="text-section-title text-text-primary">Recording</h3>
                {call.file_key && (
                  <AudioPlayer
                    callId={call.id}
                    startAt={cue?.seconds ?? null}
                    duration={duration}
                    label="This call"
                    className="mt-3"
                  />
                )}
                {cue?.note && <p className="text-xs text-text-secondary mt-2">{cue.note}</p>}
              </div>
              <div className="px-5 py-6 flex items-start gap-3">
                <svg className="w-5 h-5 text-text-muted flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="5" y="11" width="14" height="9" rx="1.5" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
                <div>
                  <p className="text-table-cell text-text-primary font-medium">
                    Transcript restricted to administrators
                  </p>
                  <p className="text-xs text-text-muted mt-1 leading-relaxed">
                    Your organisation stores transcripts with personal and health details in readable form, and
                    access to those is limited to administrators. Every verdict, the quote it was decided on and
                    when it was said are still shown, and you can listen to any moment.
                  </p>
                </div>
              </div>
            </section>
          )}

          {!transcriptShown && !call.transcript_restricted && !processing && (
            <section aria-label="Transcript" className="bg-card border border-border rounded-card px-5 py-6">
              <h3 className="text-section-title text-text-primary">No transcript</h3>
              <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                {call.status === 'failed'
                  ? 'This call could not be transcribed, so there is nothing to read or score against.'
                  : 'This call has not been transcribed.'}
              </p>
            </section>
          )}
        </div>
      </div>

      {/* After the review, for a call scored on its own. For a call in a sale,
          coaching and feedback belong to the sale and live on its page — the
          one exception is a call fed back on its own before it joined a sale,
          whose round is still shown below. */}
      {call.status === 'scored' && user && (!journey || hasCallRound) && (
        <section aria-label="After the review" className="mt-6">
          <h3 className="text-section-title text-text-primary mb-2">After the review</h3>
          <div className="bg-card border border-border rounded-card overflow-hidden">
            {!journey && (
            <ReviewSection
              id="call-section-coaching"
              title="Coaching"
              summary={
                primaryScore?.coaching
                  ? 'A coaching brief was written for this call'
                  : 'No coaching brief for this call'
              }
              actionLabel="Show"
              open={openSection === 'coaching'}
              onToggle={() => setOpenSection(openSection === 'coaching' ? null : 'coaching')}
            >
              <CoachingPanel
                coaching={primaryScore?.coaching ?? null}
                plan={user.organization_plan}
                callStatus={call.status}
                isAdmin={isAdmin}
                priorCoachingCount={primaryScore?.prior_coaching_count}
                embedded
              />
            </ReviewSection>
            )}
            {isAdmin && !journey && (
              <ReviewSection
                id="call-section-share"
                title="Share with client"
                summary="A read-only link to this call, with an expiry you choose"
                actionLabel="Show"
                open={openSection === 'share'}
                onToggle={() => setOpenSection(openSection === 'share' ? null : 'share')}
              >
                <ShareLinksPanel callId={call.id} />
              </ReviewSection>
            )}
            {/* Sendable for a call scored on its own at a firm set to score
                calls. Also shown, read-only, wherever a round already exists —
                the firm has since switched to scoring sales, or the call has
                since joined a sale — so what the adviser was told is never
                hidden. The panel says why a new round can't be sent. */}
            {showCallFeedback && (
              <ReviewSection
                id="call-section-feedback"
                title="Adviser feedback"
                summary={feedbackSummary}
                actionLabel={feedbackAction}
                open={openSection === 'feedback'}
                onToggle={toggleFeedbackSection}
              >
                <FeedbackPanel
                  subject={feedbackSubject}
                  canAction={canAction}
                  composeSignal={composeSignal}
                  embedded
                />
              </ReviewSection>
            )}
          </div>
        </section>
      )}

      {correctingItem && (
        <ScoreCorrectionModal
          kind={journey ? 'journey' : 'call'}
          parentId={journey ? journey.id : call.id}
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

function Tile({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-card px-4 py-3">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className="text-card-value text-text-primary tabular-nums mt-0.5">{value}</div>
      <div className="text-xs text-text-secondary mt-0.5 hidden sm:block">{sub}</div>
    </div>
  );
}

/** "1 critical · 2 high" — the split that decides how urgent a failure list is. */
function severitySummary(items: CallCheckpointItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.result !== 'fail' || !item.severity) continue;
    counts.set(item.severity, (counts.get(item.severity) ?? 0) + 1);
  }
  const order = ['critical', 'high', 'medium', 'low'];
  const parts = order.filter((s) => counts.get(s)).map((s) => `${counts.get(s)} ${s}`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing failed';
}
