import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDropzone, isVideoRecording, recordingProblem } from '../components/FileDropzone';
import { BulkImportDrawer } from '../components/BulkImportDrawer';
import { RecentUploadsRail } from '../components/RecentUploadsRail';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { formatFileSize } from '../lib/format';
import { hasFeature, MAX_FILE_SIZE_BYTES } from '@callguard/shared';
import type { Call, OrganizationInfo } from '@callguard/shared';

// The sentence the API 400s with when a call is ticked "resulted in a sale"
// without a phone that normalises — kept in step with routes/calls.ts.
const SALE_NEEDS_PHONE_MESSAGE =
  "To score this call as a sale, add the customer's phone number — it's how the call is matched to the customer's other calls.";

// A light client-side stand-in for the server's normalizePhone (services/ingestion.ts):
// good enough to catch "empty" and "obviously not a phone number" before a
// round trip. The API's check is authoritative; this is just the inline hint.
function hasUsablePhone(value: string): boolean {
  return value.replace(/\D/g, '').length >= 7;
}

// Anything this long, or any meeting recording, takes minutes rather than
// seconds to transcribe — so the page stops promising "under a minute".
const LONG_RECORDING_BYTES = MAX_FILE_SIZE_BYTES / 4;

interface AdviserOption {
  id: string;
  name: string;
}

interface ScorecardSummary {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

interface CustomerMatch {
  id: string;
  name: string | null;
  phone_normalized: string;
  call_count: number;
}

/** 'other' reveals the free-text name box; '' means "not recorded". */
const NOT_LISTED = 'other';

const todayIso = () => new Date().toLocaleDateString('en-CA');

const fieldCls =
  'w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary placeholder:text-text-muted disabled:opacity-60 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const labelCls = 'block text-xs font-medium text-text-muted mb-1';
const helpCls = 'text-xs text-text-muted mt-1.5';

export function Upload() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isSupervisor = user?.role === 'supervisor';
  // Admin and supervisor may attribute an upload to any adviser; an adviser's
  // upload is always self-assigned (enforced on the API too), and a viewer
  // can't reach this page at all (see canUpload below).
  const canPickAdviser = isAdmin || isSupervisor;
  const canUpload = isAdmin || isSupervisor || user?.role === 'adviser';
  // Whose plan/role lets them see a customer at all — the same gate the
  // Customers page uses. Without it the phone lookup would 403 on every keypress.
  const canSeeCustomers = hasFeature(
    user?.organization_plan ?? null,
    'customer_journey',
    user?.feature_overrides
  );

  const [file, setFile] = useState<File | null>(null);
  const [fileRefused, setFileRefused] = useState('');
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [callDate, setCallDate] = useState(todayIso);
  const [customerPhone, setCustomerPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [isSale, setIsSale] = useState(false);
  const [scorecardId, setScorecardId] = useState('');
  const [pickingScorecard, setPickingScorecard] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Upload progress. 'sent' is "every byte has left the browser" — the server
  // is storing it (and pulling the audio out of a video container) by then.
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'sent'>('idle');
  const [sentBytes, setSentBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const inFlight = phase !== 'idle';

  const { data: advisers } = useQuery({
    queryKey: ['upload-advisers'],
    queryFn: () => api.get<{ data: AdviserOption[] }>('/calls/assignable-advisers'),
    enabled: canPickAdviser,
  });

  // Read by everyone who can upload, not just admins: the outcome panel names
  // the scorecard the call will be judged against, which is not an admin-only
  // fact about the firm.
  const { data: scorecards } = useQuery({
    queryKey: ['scorecards'],
    queryFn: () => api.get<{ data: ScorecardSummary[] }>('/scorecards'),
    enabled: !!user,
  });

  const {
    data: organization,
    isLoading: orgLoading,
    isError: orgError,
  } = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationInfo>('/organization'),
    enabled: !!user,
  });

  // The firm's scoring mode decides almost everything this page says: a firm
  // that scores sales holds a call until a sale arrives, a firm that scores
  // calls scores this one on its own. null until it's known — nothing claims
  // either behaviour before then.
  const salesScoring: boolean | null = organization
    ? organization.scoring_scope === 'sales_only'
    : null;

  const activeScorecard = scorecards?.data.find((s) => s.is_active) ?? null;
  const chosenScorecard = scorecardId
    ? (scorecards?.data.find((s) => s.id === scorecardId) ?? null)
    : activeScorecard;
  const scorecardChoices = scorecards?.data ?? [];

  // Debounced customer lookup — never blocks the upload, and says nothing at
  // all when it can't be trusted (no permission, or the request failed).
  const [debouncedPhone, setDebouncedPhone] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedPhone(customerPhone.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [customerPhone]);

  const {
    data: customerMatch,
    isFetching: matchFetching,
    isSuccess: matchLoaded,
  } = useQuery({
    queryKey: ['upload-customer-match', debouncedPhone],
    enabled: canSeeCustomers && hasUsablePhone(debouncedPhone),
    queryFn: async () => {
      const res = await api.get<{ customers: CustomerMatch[] }>(
        `/customers?search=${encodeURIComponent(debouncedPhone)}&limit=5`
      );
      // The search is a partial match, so only claim a customer when the
      // stored number really ends with the digits that were typed.
      const digits = debouncedPhone.replace(/\D/g, '');
      const tail = digits.slice(-9);
      return (
        res.customers.find((c) => c.phone_normalized.replace(/\D/g, '').endsWith(tail)) ?? null
      );
    },
    retry: false,
  });

  const saleNeedsPhone = isSale && !hasUsablePhone(customerPhone);
  const whyDisabled = !file
    ? 'Choose a recording first.'
    : saleNeedsPhone
      ? SALE_NEEDS_PHONE_MESSAGE
      : '';

  const isLongRecording = !!file && (isVideoRecording(file) || file.size > LONG_RECORDING_BYTES);

  const chooseFile = (chosen: File) => {
    setFileRefused('');
    setError('');
    setFile(chosen);
  };

  const removeFile = () => {
    setFile(null);
    setError('');
    setFileRefused('');
  };

  // Warn before a reload or a closed tab throws away an upload mid-flight.
  useEffect(() => {
    if (!inFlight) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [inFlight]);

  const startUpload = async () => {
    if (!file || inFlight) return;
    setError('');
    setPhoneError('');

    // Re-check the file: it has been sitting in the form, and the reasons it
    // could be refused are the same ones the dropzone checked.
    const problem = recordingProblem(file);
    if (problem) {
      setFileRefused(problem);
      return;
    }
    if (saleNeedsPhone) {
      setPhoneError(SALE_NEEDS_PHONE_MESSAGE);
      return;
    }

    const form = new FormData();
    form.append('audio', file);
    if (canPickAdviser) {
      if (agentId && agentId !== NOT_LISTED) {
        form.append('agent_id', agentId);
        const selected = advisers?.data.find((a) => a.id === agentId);
        if (selected) form.append('agent_name', selected.name);
      } else if (agentId === NOT_LISTED && agentName.trim()) {
        form.append('agent_name', agentName.trim());
      }
    }
    if (isAdmin && scorecardId) form.append('scorecard_id', scorecardId);
    // call_date orders the calls inside a sale, and with them which one counts
    // as the wrap-up, so it is only sent when it adds something: a date the
    // operator actually changed. A date box carries no time of day, so sending
    // "today" would replace the real upload time with midnight and leave
    // several of today's uploads indistinguishable in that ordering.
    if (callDate && callDate !== todayIso()) form.append('call_date', callDate);
    if (customerPhone.trim()) form.append('customer_phone', customerPhone.trim());
    if (salesScoring && isSale) form.append('mark_as_sale', 'true');

    const controller = new AbortController();
    abortRef.current = controller;
    setSentBytes(0);
    setTotalBytes(file.size);
    setPhase('uploading');

    try {
      const call = await api.upload<Call>('/calls/upload', form, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          setSentBytes(loaded);
          if (total != null) setTotalBytes(total);
        },
        onSent: () => setPhase('sent'),
      });
      queryClient.invalidateQueries({ queryKey: ['calls'] });
      queryClient.invalidateQueries({ queryKey: ['my-uploads'] });
      navigate(`/calls/${call.id}`);
    } catch (err) {
      setPhase('idle');
      if ((err as Error).name === 'AbortError') return;
      const message = (err as Error).message;
      if (message === SALE_NEEDS_PHONE_MESSAGE) setPhoneError(message);
      setError(message);
    } finally {
      abortRef.current = null;
    }
  };

  const cancelUpload = () => abortRef.current?.abort();

  const percent =
    totalBytes && totalBytes > 0 ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 0;

  const progressLine =
    phase === 'sent'
      ? file && isVideoRecording(file)
        ? 'Extracting the audio…'
        : 'Storing the recording…'
      : `Uploading ${formatFileSize(sentBytes)} of ${formatFileSize(totalBytes ?? file?.size ?? 0)}`;

  const outcome = useMemo(
    () =>
      outcomeSentence({
        salesScoring,
        isSale,
        chosenScorecard,
        customerMatch,
        file,
        isLongRecording,
      }),
    [salesScoring, isSale, chosenScorecard, customerMatch, file, isLongRecording]
  );

  if (!canUpload) {
    return (
      <div className="max-w-[700px]">
        <div className="mb-7">
          <h2 className="text-page-title text-text-primary">Upload a call</h2>
        </div>
        <div className="bg-card border border-border rounded-card p-10 text-center">
          <div className="text-base font-semibold text-text-primary">
            You don't have permission to upload calls
          </div>
          <p className="text-table-cell text-text-secondary mt-1.5">
            Ask an administrator at {user?.organization_name ?? 'your firm'} if you need to add a
            recording.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row lg:items-start gap-6">
      <div className="w-full max-w-[700px] min-w-0">
        <Link
          to="/calls"
          className="inline-flex items-center gap-1.5 text-table-cell text-text-secondary hover:text-text-primary mb-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        >
          <svg
            viewBox="0 0 24 24"
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Calls
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div>
            <h2 className="text-page-title text-text-primary">Upload a call</h2>
            <p className="text-page-sub text-text-subtle mt-1">
              {salesScoring === null
                ? "For recordings that don't come from your dialler."
                : salesScoring
                  ? "For recordings that don't come from your dialler — a Teams or Zoom meeting, or a one-off call."
                  : "For recordings that don't come from your dialler. Each call is scored on its own."}
            </p>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              className="text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
            >
              Import many recordings
            </button>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void startUpload();
          }}
          className="bg-card border border-border rounded-card shadow-card"
        >
          {/* The recording comes first, before any details — and choosing one
              starts nothing. */}
          <section className="p-5 border-b border-border">
            <h3 className="text-section-title text-text-primary mb-3">Recording</h3>

            {file ? (
              <div className="border border-border rounded-card p-3 flex items-center gap-3">
                <span className="w-10 h-10 shrink-0 rounded-btn bg-primary-light flex items-center justify-center">
                  <svg
                    viewBox="0 0 24 24"
                    className="w-5 h-5 stroke-primary"
                    fill="none"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-table-cell font-semibold text-text-primary truncate" title={file.name}>
                    {file.name}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <span className="text-xs text-text-muted">{formatFileSize(file.size)}</span>
                    {isVideoRecording(file) && (
                      <span className="text-badge font-semibold px-2.5 py-[3px] rounded-full bg-processing-bg text-processing">
                        Video · only the audio is kept
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={removeFile}
                  disabled={inFlight}
                  className="shrink-0 min-h-[44px] sm:min-h-0 px-3 py-2 rounded-btn text-table-cell font-semibold text-text-secondary hover:bg-sidebar-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  aria-label={`Remove ${file.name}`}
                >
                  Remove
                </button>
              </div>
            ) : (
              <FileDropzone
                onFileChosen={chooseFile}
                onFileRefused={setFileRefused}
                disabled={inFlight}
              />
            )}

            {fileRefused && (
              <p role="alert" className="mt-3 bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
                {fileRefused}
              </p>
            )}
          </section>

          {/* About the call */}
          <section className="p-5 border-b border-border">
            <h3 className="text-section-title text-text-primary mb-4">About the call</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                {canPickAdviser ? (
                  <>
                    <label htmlFor="upload-adviser" className={labelCls}>
                      Adviser
                    </label>
                    <select
                      id="upload-adviser"
                      value={agentId}
                      onChange={(e) => setAgentId(e.target.value)}
                      disabled={inFlight}
                      aria-describedby="upload-adviser-help"
                      className={fieldCls}
                    >
                      <option value="">Not recorded</option>
                      {advisers?.data.map((adviser) => (
                        <option key={adviser.id} value={adviser.id}>
                          {adviser.name}
                        </option>
                      ))}
                      <option value={NOT_LISTED}>Someone not listed…</option>
                    </select>
                    {agentId === NOT_LISTED && (
                      <input
                        type="text"
                        value={agentName}
                        onChange={(e) => setAgentName(e.target.value)}
                        disabled={inFlight}
                        placeholder="Their name"
                        aria-label="Name of the adviser on this call"
                        className={`${fieldCls} mt-2`}
                      />
                    )}
                    <p id="upload-adviser-help" className={helpCls}>
                      Who the call is attributed to in reporting and coaching.
                    </p>
                  </>
                ) : (
                  <>
                    {/* Not a control: an adviser's upload is always their own
                        (routes/calls.ts forces it), so there is nothing to pick. */}
                    <span className={labelCls}>Adviser</span>
                    <p className="px-3 py-2 rounded-btn border border-border bg-page text-table-cell text-text-primary">
                      You · {user?.name}
                    </p>
                    <p className={helpCls}>Your uploads are always attributed to you.</p>
                  </>
                )}
              </div>

              <div>
                <label htmlFor="upload-call-date" className={labelCls}>
                  Date of the call
                </label>
                <input
                  id="upload-call-date"
                  type="date"
                  value={callDate}
                  max={todayIso()}
                  onChange={(e) => setCallDate(e.target.value)}
                  disabled={inFlight}
                  aria-describedby="upload-call-date-help"
                  className={fieldCls}
                />
                <p id="upload-call-date-help" className={helpCls}>
                  When the conversation happened, if that isn't today.
                </p>
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="upload-customer-phone" className={labelCls}>
                  Customer phone{' '}
                  {isSale ? (
                    <span className="text-fail font-semibold">(required for a sale)</span>
                  ) : (
                    <span className="font-normal">(optional)</span>
                  )}
                </label>
                <input
                  id="upload-customer-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={customerPhone}
                  onChange={(e) => {
                    setCustomerPhone(e.target.value);
                    if (phoneError) setPhoneError('');
                  }}
                  disabled={inFlight}
                  placeholder="e.g. 07473 123456"
                  aria-required={isSale}
                  aria-invalid={!!phoneError}
                  aria-describedby={`upload-customer-phone-help${phoneError ? ' upload-customer-phone-error' : ''}`}
                  className={`${fieldCls} sm:max-w-[320px]`}
                />
                {phoneError && (
                  <p id="upload-customer-phone-error" role="alert" className="text-xs text-fail mt-1.5">
                    {phoneError}
                  </p>
                )}
                <p id="upload-customer-phone-help" className={helpCls}>
                  Matches the call to the customer's other calls.
                </p>
                {/* Only ever shown once the lookup has actually answered — a
                    failed request must not read as "New customer". */}
                {canSeeCustomers && hasUsablePhone(debouncedPhone) && matchLoaded && !matchFetching && (
                  <p className="text-xs text-text-secondary mt-1" aria-live="polite">
                    {customerMatch
                      ? `Matches ${customerMatch.name ?? 'a customer already on file'} · ${
                          customerMatch.call_count === 1
                            ? '1 other call'
                            : `${customerMatch.call_count} other calls`
                        }`
                      : 'New customer'}
                  </p>
                )}
              </div>

              {isAdmin && scorecardChoices.length > 1 && (
                <div className="sm:col-span-2">
                  {pickingScorecard ? (
                    <>
                      <label htmlFor="upload-scorecard" className={labelCls}>
                        Scorecard
                      </label>
                      <select
                        id="upload-scorecard"
                        value={scorecardId}
                        onChange={(e) => setScorecardId(e.target.value)}
                        disabled={inFlight}
                        aria-describedby="upload-scorecard-help"
                        className={`${fieldCls} sm:max-w-[420px]`}
                      >
                        <option value="">
                          {activeScorecard ? `${activeScorecard.name} (active)` : 'The active scorecard'}
                        </option>
                        {scorecardChoices
                          .filter((s) => !s.is_active)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                      <p id="upload-scorecard-help" className={helpCls}>
                        Leave on the active scorecard unless this call belongs to a different
                        campaign or client.
                      </p>
                    </>
                  ) : (
                    <>
                      <span className={labelCls}>Scorecard</span>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-table-cell text-text-primary">
                          {chosenScorecard?.name ?? 'The active scorecard'}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPickingScorecard(true)}
                          aria-label="Change the scorecard this call is scored against"
                          className="text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                        >
                          Change
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* The sale question, for firms that score sales */}
          {salesScoring && (
            <section className="p-5 border-b border-border">
              <h3 id="upload-sale-question" className="text-section-title text-text-primary mb-1">
                Did this call end in a sale?
              </h3>
              <p className="text-table-cell text-text-secondary mb-3">
                Your firm scores sales, so this decides whether the call is scored now or kept
                until a sale arrives.
              </p>
              <div
                role="radiogroup"
                aria-labelledby="upload-sale-question"
                className="grid grid-cols-1 sm:grid-cols-2 gap-3"
              >
                {[
                  {
                    value: true,
                    title: 'Yes — score the sale now',
                    hint: "Scored together with the customer's other calls",
                  },
                  {
                    value: false,
                    title: 'No, or not yet',
                    hint: 'Kept, and scored when the sale arrives from your CRM',
                  },
                ].map((option) => (
                  <label
                    key={String(option.value)}
                    className={`flex items-start gap-2.5 p-3 rounded-card border cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-primary/40 ${
                      isSale === option.value
                        ? 'border-primary bg-primary-light/50'
                        : 'border-border hover:bg-sidebar-hover'
                    }`}
                  >
                    <input
                      type="radio"
                      name="upload-sale"
                      checked={isSale === option.value}
                      onChange={() => setIsSale(option.value)}
                      disabled={inFlight}
                      className="mt-0.5 accent-primary focus-visible:outline-none"
                    />
                    <span>
                      <span className="block text-table-cell font-semibold text-text-primary">
                        {option.title}
                      </span>
                      <span className="block text-xs text-text-muted mt-0.5">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {/* What happens next — one sentence, built from the mode, the sale
              answer and the scorecard. */}
          <section className="p-5">
            {orgError ? (
              <p className="bg-review-bg text-review px-3 py-2 rounded-btn text-table-cell">
                We couldn't check how your firm scores calls, so this page can't say what happens
                after the upload. Reload the page to try again — uploading still works.
              </p>
            ) : orgLoading ? (
              <div
                className="h-10 rounded-card bg-[length:800px_100%] animate-skeleton-shimmer"
                style={{
                  backgroundImage:
                    'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                }}
                aria-busy="true"
              />
            ) : (
              <div className="bg-primary-light border border-border rounded-card p-4">
                <p className="text-table-cell text-text-secondary">
                  {outcome.map((part, i) =>
                    part.strong ? (
                      <span key={i} className="font-semibold text-text-primary">
                        {part.text}
                      </span>
                    ) : (
                      <span key={i}>{part.text}</span>
                    )
                  )}
                </p>
              </div>
            )}
          </section>

          {/* The action row, or the progress that replaces it in flight */}
          <div className="px-5 py-4 sticky bottom-0 bg-card border-t border-border rounded-b-card sm:static">
            {error && !inFlight && (
              <p role="alert" className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">
                {error}
              </p>
            )}

            {inFlight ? (
              <div>
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="text-table-cell text-text-primary" aria-live="polite">
                    {progressLine}
                  </p>
                  <span className="text-table-cell font-semibold text-text-primary tabular-nums">
                    {phase === 'sent' ? '100%' : `${percent}%`}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={phase === 'sent' ? 100 : percent}
                  className="h-2 rounded-full bg-border overflow-hidden"
                >
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${phase === 'sent' ? 100 : percent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 mt-3">
                  <p className="text-xs text-text-muted">Leave this page open until it finishes.</p>
                  <button
                    type="button"
                    onClick={cancelUpload}
                    className="px-[18px] py-[9px] min-h-[44px] sm:min-h-0 rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-text-muted flex-1 min-w-[180px]">{whyDisabled}</p>
                <div className="flex items-center gap-2">
                  <Link
                    to="/calls"
                    className="px-[18px] py-[9px] min-h-[44px] sm:min-h-0 inline-flex items-center rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    Cancel
                  </Link>
                  <button
                    type="submit"
                    disabled={!file || saleNeedsPhone}
                    className="px-[18px] py-[9px] min-h-[44px] sm:min-h-0 rounded-btn text-table-cell font-semibold bg-primary-ink text-on-solid hover:bg-primary-ink-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {/* Only promises scoring where scoring really follows:
                        a firm that scores calls, or a sale being scored now.
                        While the firm's mode is unknown it promises nothing. */}
                    {error
                      ? 'Try again'
                      : salesScoring === false || (salesScoring && isSale)
                        ? 'Upload and score'
                        : 'Upload'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </form>
      </div>

      <aside className="hidden lg:block w-full lg:w-[320px] lg:shrink-0">
        <RecentUploadsRail salesScoring={salesScoring} />
      </aside>

      {bulkOpen && <BulkImportDrawer onClose={() => setBulkOpen(false)} />}
    </div>
  );
}

interface OutcomePart {
  text: string;
  /** The part of the sentence that says what happens, emphasised. */
  strong?: boolean;
}

/**
 * One sentence saying what will happen to this recording, built from the firm's
 * scoring mode, the sale answer and the scorecard it will be judged against.
 *
 * It only claims a time it can stand behind: nothing about how long until a
 * file has been chosen, and "a few minutes" for a meeting recording or a long
 * one rather than "under a minute".
 */
function outcomeSentence({
  salesScoring,
  isSale,
  chosenScorecard,
  customerMatch,
  file,
  isLongRecording,
}: {
  salesScoring: boolean | null;
  isSale: boolean;
  chosenScorecard: { name: string } | null;
  customerMatch: { name: string | null } | null | undefined;
  file: File | null;
  isLongRecording: boolean;
}): OutcomePart[] {
  const scorecard = chosenScorecard ? chosenScorecard.name : 'your active scorecard';

  if (salesScoring && isSale) {
    const customer = customerMatch?.name ? `${customerMatch.name}'s` : "this customer's";
    return [
      { text: "We'll transcribe it, then score it as a sale", strong: true },
      {
        text:
          ` together with ${customer} other calls, against ${scorecard}.` +
          (isLongRecording ? ' A long meeting takes a few minutes.' : '') +
          " You'll go straight to the call.",
      },
    ];
  }

  if (salesScoring) {
    return [
      { text: "We'll transcribe it and keep it.", strong: true },
      {
        text:
          " Your firm scores sales, so it's scored when a sale for this customer arrives from your CRM.",
      },
    ];
  }

  // Not known yet (the panel shows a skeleton instead, so this is belt and
  // braces): say only what is true whichever way the firm is set up.
  if (salesScoring === null) {
    return [{ text: "We'll transcribe it and keep it.", strong: true }];
  }

  // A firm that scores every call on its own. The timing claim is only made
  // once there is a file to make it about.
  const timing = !file ? '' : isLongRecording ? ' — a few minutes for a long meeting — ' : ' — usually under a minute — ';
  return [
    { text: "We'll transcribe it", strong: true },
    ...(timing ? [{ text: timing }] : [{ text: ', ' }]),
    { text: `then score it against ${scorecard}.`, strong: true },
    { text: " You'll go straight to the call." },
  ];
}
