// Design-sync bundle entry for the CallGuard tenant web app.
//
// packages/web is a Vite application, not a published component library, so
// there is no dist/ entry with shipped .d.ts for the converter to bundle.
// This barrel is that entry: it re-exports the component surface we want the
// claude.ai/design agent to build with, and nothing else (pages, routing and
// the API client stay out of the export list even though components pull them
// in as dependencies).
//
// Referenced by .design-sync/config.json — keep it in step with
// `componentSrcMap` there when components are added or removed.

export { AgentFilter } from '../packages/web/src/components/AgentFilter';
export { AlertRuleModal } from '../packages/web/src/components/AlertRuleModal';
export { AssignAgentDropdown } from '../packages/web/src/components/AssignAgentDropdown';
export { AudioPlayer } from '../packages/web/src/components/AudioPlayer';
export { SeverityBadge, StatusBadge } from '../packages/web/src/components/BreachBadges';
export { BreachDetailDrawer } from '../packages/web/src/components/BreachDetailDrawer';
export { CallStatusBadge } from '../packages/web/src/components/CallStatusBadge';
export { CapturePanel } from '../packages/web/src/components/CapturePanel';
export { CaptureResultBadge } from '../packages/web/src/components/CaptureResultBadge';
export { CoachingPanel } from '../packages/web/src/components/CoachingPanel';
export { CountUp } from '../packages/web/src/components/CountUp';
export { DialogProvider, useDialog } from '../packages/web/src/components/DialogProvider';
export { FeedbackHeaderAction, FeedbackPanel } from '../packages/web/src/components/FeedbackPanel';
export { FileDropzone } from '../packages/web/src/components/FileDropzone';
export { InviteAgentModal } from '../packages/web/src/components/InviteAgentModal';
export { ItemResultBadge } from '../packages/web/src/components/ItemResultBadge';
export { JourneyStatusBadge } from '../packages/web/src/components/JourneyStatusBadge';
export { Layout } from '../packages/web/src/components/Layout';
export { Logo } from '../packages/web/src/components/Logo';
export { NotificationBell } from '../packages/web/src/components/NotificationBell';
export { AmendmentBadge, ReconciliationBadge } from '../packages/web/src/components/ReconciliationBadge';
export { ReconciliationPanel } from '../packages/web/src/components/ReconciliationPanel';
export { ReviewEvidencePanel } from '../packages/web/src/components/ReviewEvidencePanel';
export { RiskLevelBadge } from '../packages/web/src/components/RiskLevelBadge';
export { ScoreCorrectionModal } from '../packages/web/src/components/ScoreCorrectionModal';
export { ScoreGauge } from '../packages/web/src/components/ScoreGauge';
export { ScorecardResultCard } from '../packages/web/src/components/ScorecardResultCard';
export { ShareLinksPanel } from '../packages/web/src/components/ShareLinksPanel';
export { SupportWidget } from '../packages/web/src/components/SupportWidget';
export { ThemeToggle } from '../packages/web/src/components/ThemeToggle';
export { TranscriptViewer } from '../packages/web/src/components/TranscriptViewer';
export { TrendCharts } from '../packages/web/src/components/TrendCharts';
