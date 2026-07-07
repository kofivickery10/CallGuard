import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { TwoFactorEnroll } from './pages/TwoFactorEnroll';
import { Dashboard } from './pages/Dashboard';
import { Calls } from './pages/Calls';
import { CallDetail } from './pages/CallDetail';
import { Upload } from './pages/Upload';
import { PublicCallView } from './pages/PublicCallView';
import { Welcome } from './pages/Welcome';
import { Impersonate } from './pages/Impersonate';

// Lazy-loaded admin-heavy pages (most users never visit)
const Scorecards = lazy(() => import('./pages/Scorecards').then((m) => ({ default: m.Scorecards })));
const ScorecardEditor = lazy(() => import('./pages/ScorecardEditor').then((m) => ({ default: m.ScorecardEditor })));
const Team = lazy(() => import('./pages/Team').then((m) => ({ default: m.Team })));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase').then((m) => ({ default: m.KnowledgeBase })));
const Integrations = lazy(() => import('./pages/Integrations').then((m) => ({ default: m.Integrations })));
const Alerts = lazy(() => import('./pages/Alerts').then((m) => ({ default: m.Alerts })));
const Notifications = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.Notifications })));
const Breaches = lazy(() => import('./pages/Breaches').then((m) => ({ default: m.Breaches })));
const AdviserRiskPage = lazy(() => import('./pages/AdviserRisk').then((m) => ({ default: m.AdviserRiskPage })));
const ComplianceDocs = lazy(() => import('./pages/ComplianceDocs').then((m) => ({ default: m.ComplianceDocs })));
const OrganizationSettings = lazy(() => import('./pages/OrganizationSettings').then((m) => ({ default: m.OrganizationSettings })));
const AIInsights = lazy(() => import('./pages/AIInsights').then((m) => ({ default: m.AIInsights })));
const ReviewQueue = lazy(() => import('./pages/ReviewQueue').then((m) => ({ default: m.ReviewQueue })));
const AuditLog = lazy(() => import('./pages/AuditLog').then((m) => ({ default: m.AuditLog })));
const Calibration = lazy(() => import('./pages/Calibration').then((m) => ({ default: m.Calibration })));
const SupportInbox = lazy(() => import('./pages/SupportInbox').then((m) => ({ default: m.SupportInbox })));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerProfile = lazy(() => import('./pages/CustomerProfile'));
const Account = lazy(() => import('./pages/Account'));
const BillingOverview = lazy(() => import('./pages/BillingOverview'));
const Settings = lazy(() => import('./pages/Settings'));

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
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/impersonate" element={<Impersonate />} />
      <Route path="/enroll-2fa" element={<EnrolRoute><TwoFactorEnroll /></EnrolRoute>} />
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/shared/:token" element={<PublicCallView />} />
      <Route
        path="/*"
        element={
          <PrivateRoute>
            <Layout>
              <Suspense fallback={<PageLoader />}>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/calls" element={<Calls />} />
                  <Route path="/calls/upload" element={<Upload />} />
                  <Route path="/calls/:id" element={<CallDetail />} />
                  <Route path="/scorecards" element={<Scorecards />} />
                  <Route path="/scorecards/new" element={<ScorecardEditor />} />
                  <Route path="/scorecards/:id/edit" element={<ScorecardEditor />} />
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
                  <Route path="/account" element={<Account />} />
                  <Route path="/billing" element={<BillingOverview />} />
                </Routes>
              </Suspense>
            </Layout>
          </PrivateRoute>
        }
      />
    </Routes>
  );
}
