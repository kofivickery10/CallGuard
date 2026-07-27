import { Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Layout } from './components/Layout';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { lazyWithRetry } from './lib/lazyWithRetry';
import { Login } from './pages/Login';
import { TwoFactorEnroll } from './pages/TwoFactorEnroll';
import { Dashboard } from './pages/Dashboard';
import { Calls } from './pages/Calls';
import { CallDetail } from './pages/CallDetail';
import { Upload } from './pages/Upload';
import { PublicCallView } from './pages/PublicCallView';
import { SetPassword } from './pages/SetPassword';
import { Welcome } from './pages/Welcome';
import { Impersonate } from './pages/Impersonate';

// Lazy-loaded admin-heavy pages (most users never visit)
const Scorecards = lazyWithRetry(() => import('./pages/Scorecards').then((m) => ({ default: m.Scorecards })));
const ScorecardEditor = lazyWithRetry(() => import('./pages/ScorecardEditor').then((m) => ({ default: m.ScorecardEditor })));
const DataCaptureForms = lazyWithRetry(() => import('./pages/DataCaptureForms').then((m) => ({ default: m.DataCaptureForms })));
const DataCaptureFormEditor = lazyWithRetry(() => import('./pages/DataCaptureFormEditor').then((m) => ({ default: m.DataCaptureFormEditor })));
const DataCapture = lazyWithRetry(() => import('./pages/DataCapture').then((m) => ({ default: m.DataCapture })));
const Team = lazyWithRetry(() => import('./pages/Team').then((m) => ({ default: m.Team })));
const KnowledgeBase = lazyWithRetry(() => import('./pages/KnowledgeBase').then((m) => ({ default: m.KnowledgeBase })));
const Integrations = lazyWithRetry(() => import('./pages/Integrations').then((m) => ({ default: m.Integrations })));
const Alerts = lazyWithRetry(() => import('./pages/Alerts').then((m) => ({ default: m.Alerts })));
const Notifications = lazyWithRetry(() => import('./pages/Notifications').then((m) => ({ default: m.Notifications })));
const Breaches = lazyWithRetry(() => import('./pages/Breaches').then((m) => ({ default: m.Breaches })));
const AdviserRiskPage = lazyWithRetry(() => import('./pages/AdviserRisk').then((m) => ({ default: m.AdviserRiskPage })));
const ComplianceDocs = lazyWithRetry(() => import('./pages/ComplianceDocs').then((m) => ({ default: m.ComplianceDocs })));
const OrganizationSettings = lazyWithRetry(() => import('./pages/OrganizationSettings').then((m) => ({ default: m.OrganizationSettings })));
const AIInsights = lazyWithRetry(() => import('./pages/AIInsights').then((m) => ({ default: m.AIInsights })));
const ReviewQueue = lazyWithRetry(() => import('./pages/ReviewQueue').then((m) => ({ default: m.ReviewQueue })));
const AuditLog = lazyWithRetry(() => import('./pages/AuditLog').then((m) => ({ default: m.AuditLog })));
const Calibration = lazyWithRetry(() => import('./pages/Calibration').then((m) => ({ default: m.Calibration })));
const SupportInbox = lazyWithRetry(() => import('./pages/SupportInbox').then((m) => ({ default: m.SupportInbox })));
const Customers = lazyWithRetry(() => import('./pages/Customers'));
const CustomerProfile = lazyWithRetry(() => import('./pages/CustomerProfile'));
const Journeys = lazyWithRetry(() => import('./pages/Journeys').then((m) => ({ default: m.Journeys })));
const JourneyDetail = lazyWithRetry(() => import('./pages/JourneyDetail').then((m) => ({ default: m.JourneyDetail })));
const Account = lazyWithRetry(() => import('./pages/Account'));
const BillingOverview = lazyWithRetry(() => import('./pages/BillingOverview'));
const Settings = lazyWithRetry(() => import('./pages/Settings'));
const Products = lazyWithRetry(() => import('./pages/Products'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64 text-text-muted text-table-cell">
      Loading...
    </div>
  );
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  // 2FA is mandatory — unenrolled users are sent to enrolment before any page.
  if (user.totp_enabled === false) return <Navigate to="/enroll-2fa" />;
  return <>{children}</>;
}

// Gate for the enrolment screen: requires a session, but is reachable while the
// user is still unenrolled (PrivateRoute would otherwise bounce them here forever).
function EnrolRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  return <>{children}</>;
}

export function App() {
  const location = useLocation();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/impersonate" element={<Impersonate />} />
      <Route path="/enroll-2fa" element={<EnrolRoute><TwoFactorEnroll /></EnrolRoute>} />
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/shared/:token" element={<PublicCallView />} />
      <Route path="/set-password/:token" element={<SetPassword />} />
      <Route
        path="/*"
        element={
          <PrivateRoute>
            <Layout>
              <ChunkErrorBoundary resetKey={location.pathname}>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/calls" element={<Calls />} />
                    <Route path="/calls/upload" element={<Upload />} />
                    <Route path="/calls/:id" element={<CallDetail />} />
                    <Route path="/scorecards" element={<Scorecards />} />
                    <Route path="/products" element={<Products />} />
                    <Route path="/scorecards/new" element={<ScorecardEditor />} />
                    <Route path="/scorecards/:id/edit" element={<ScorecardEditor />} />
                    <Route path="/capture-forms" element={<DataCaptureForms />} />
                    <Route path="/capture-forms/new" element={<DataCaptureFormEditor />} />
                    <Route path="/capture-forms/:id/edit" element={<DataCaptureFormEditor />} />
                    <Route path="/data-capture" element={<DataCapture />} />
                    <Route path="/team" element={<Team />} />
                    <Route path="/knowledge-base" element={<KnowledgeBase />} />
                    <Route path="/integrations" element={<Integrations />} />
                    <Route path="/alerts" element={<Alerts />} />
                    <Route path="/notifications" element={<Notifications />} />
                    <Route path="/breaches" element={<Breaches />} />
                    <Route path="/adviser-risk" element={<AdviserRiskPage />} />
                    <Route path="/compliance-docs" element={<ComplianceDocs />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/settings/organization" element={<OrganizationSettings />} />
                    <Route path="/insights" element={<AIInsights />} />
                    <Route path="/review-queue" element={<ReviewQueue />} />
                    <Route path="/audit-log" element={<AuditLog />} />
                    <Route path="/calibration" element={<Calibration />} />
                    <Route path="/support-inbox" element={<SupportInbox />} />
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/customers/:id" element={<CustomerProfile />} />
                    <Route path="/journeys" element={<Journeys />} />
                    <Route path="/journeys/:id" element={<JourneyDetail />} />
                    <Route path="/account" element={<Account />} />
                    <Route path="/billing" element={<BillingOverview />} />
                  </Routes>
                </Suspense>
              </ChunkErrorBoundary>
            </Layout>
          </PrivateRoute>
        }
      />
    </Routes>
  );
}
