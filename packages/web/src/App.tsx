import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Calls } from './pages/Calls';
import { CallDetail } from './pages/CallDetail';
import { Upload } from './pages/Upload';
import { PublicCallView } from './pages/PublicCallView';
import { Welcome } from './pages/Welcome';

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
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
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
                  <Route path="/settings" element={<OrganizationSettings />} />
                  <Route path="/insights" element={<AIInsights />} />
                </Routes>
              </Suspense>
            </Layout>
          </PrivateRoute>
        }
      />
    </Routes>
  );
}
