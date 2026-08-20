import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { usePushNotifications } from './hooks/usePushNotifications'
import InstallPrompt from './components/InstallPrompt'
import PortalPage from './pages/PortalPage'
import DashboardPage from './pages/DashboardPage'
import IncidentsPage from './pages/IncidentsPage'
import IncidentDetailPage from './pages/IncidentDetailPage'
import WorkflowsPage from './pages/WorkflowsPage'
import WorkflowBuilderPage from './pages/WorkflowBuilderPage'
import SkillStudioPage from './pages/SkillStudioPage'
import AgentDesignerPage from './pages/AgentDesignerPage'
import ToolManagerPage from './pages/ToolManagerPage'
import LiveConsolePage from './pages/LiveConsolePage'
import ConfigCenterPage from './pages/ConfigCenterPage'
import RunbooksPage from './pages/RunbooksPage'
import RunbookEditorPage from './pages/RunbookEditorPage'
import RunbookRunPage from './pages/RunbookRunPage'
import IntegrationsPage from './pages/IntegrationsPage'
import SLAPage from './pages/SLAPage'
import ReportsPage from './pages/ReportsPage'
import ProblemsPage from './pages/ProblemsPage'
import AssetsPage from './pages/AssetsPage'
import ChangesPage from './pages/ChangesPage'
import KnowledgeBasePage from './pages/KnowledgeBasePage'
import ServersPage from './pages/ServersPage'
import MonitoringPage from './pages/MonitoringPage'
import MissionControlPage from './pages/MissionControlPage'
import TaskQueuePage from './pages/TaskQueuePage'
import JiraPage from './pages/JiraPage'
import A2APage from './pages/A2APage'
import AgentsPage from './pages/AgentsPage'
import AgentChatPage from './pages/AgentChatPage'
import SchedulerPage from './pages/SchedulerPage'
import SecurityPage from './pages/SecurityPage'
import PerformancePage from './pages/PerformancePage'
import UsersPage from './pages/UsersPage'
import MCPPage from './pages/MCPPage'
import McpClientsPage from './pages/McpClientsPage'
import SettingsPage from './pages/SettingsPage'
import AlertRulesPage from './pages/AlertRulesPage'
import SSHPage from './pages/SSHPage'
import OperationsPage from './pages/OperationsPage'
import KubernetesPage from './pages/KubernetesPage'
import DevelopPage from './pages/DevelopPage'
import AutonomyPage from './pages/AutonomyPage'
import AIInsightsPage from './pages/AIInsightsPage'
import OnboardingPage from './pages/OnboardingPage'
import TenantSettingsPage from './pages/TenantSettingsPage'
import SuperAdminPage from './pages/SuperAdminPage'
import ToolBuilderPage from './pages/ToolBuilderPage'
import ChatWidget from './components/ChatWidget'

/** Internal routes wrapper — uses useAuth inside the AuthProvider so
 *  we can role-gate the admin tree. A `requester` who lands on any
 *  /app/* page (which is everything except /portal here) gets
 *  redirected to /portal; the portal stays open to all roles. */
function AppRoutes() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  usePushNotifications()

  useEffect(() => {
    if (loading || !user) return
    if (user.role === 'requester' && !location.pathname.startsWith('/portal')) {
      navigate('/portal', { replace: true })
    }
  }, [user, loading, location.pathname, navigate])

  // First-login redirect to the onboarding wizard. We check
  // /api/onboarding/status on every navigation but cache the
  // "completed" answer in sessionStorage so the redirect only fires
  // until the tenant is finished. Admins can re-enter via /onboarding.
  useEffect(() => {
    if (loading || !user) return
    if (location.pathname.startsWith('/onboarding')) return
    if (location.pathname.startsWith('/portal')) return
    if (sessionStorage.getItem('onb_complete') === 'true') return
    // Only admins land on the wizard — operators/viewers tag along
    // with whatever the admin set up.
    if (user.role !== 'admin' && user.role !== 'superadmin') return
    import('./lib/api').then(({ api }) =>
      api.get<{ state: { completed: boolean } }>('/api/onboarding/status').then(s => {
        if (s?.state?.completed) {
          sessionStorage.setItem('onb_complete', 'true')
        } else if (!location.pathname.startsWith('/onboarding')) {
          navigate('/onboarding', { replace: true })
        }
      }).catch(() => { /* non-fatal — leave the user where they are */ }),
    )
  }, [user, loading, location.pathname, navigate])

  // While the auth context is resolving the current user, hold off on
  // mounting any routed page. Without this gate, pages mount with no
  // user/token context, fire API calls that 401, and the screen flashes
  // through their loading/error states before the real redirect happens.
  if (loading) return <AuthLoadingScreen />

  return (
    <Routes>
      <Route path="/portal" element={<PortalPage />} />
      <Route path="/portal/*" element={<PortalPage />} />
      <Route path="/" element={<DashboardPage />} />
        <Route path="/incidents"       element={<IncidentsPage />} />
        <Route path="/incidents/:id"   element={<IncidentDetailPage />} />
        <Route path="/workflows"       element={<WorkflowsPage />} />
        <Route path="/workflow-builder" element={<WorkflowBuilderPage />} />
        <Route path="/skill-studio"     element={<SkillStudioPage />} />
        <Route path="/agent-designer"   element={<AgentDesignerPage />} />
        <Route path="/tool-manager"     element={<ToolManagerPage />} />
        <Route path="/live-console"     element={<LiveConsolePage />} />
        <Route path="/config-center"    element={<ConfigCenterPage />} />
        <Route path="/runbooks"               element={<RunbooksPage />} />
        <Route path="/runbooks/new"           element={<RunbookEditorPage />} />
        <Route path="/runbooks/edit/:id"      element={<RunbookEditorPage />} />
        <Route path="/runbooks/runs/:id"      element={<RunbookRunPage />} />
        <Route path="/integrations"           element={<IntegrationsPage />} />
        <Route path="/sla"                    element={<SLAPage />} />
        <Route path="/reports"                element={<ReportsPage />} />
        <Route path="/problems"               element={<ProblemsPage />} />
        <Route path="/problems/:id"           element={<ProblemsPage />} />
        <Route path="/assets"                 element={<AssetsPage />} />
        <Route path="/assets/:id"             element={<AssetsPage />} />
        <Route path="/changes"                element={<ChangesPage />} />
        <Route path="/changes/:id"            element={<ChangesPage />} />
        <Route path="/knowledge-base"         element={<KnowledgeBasePage />} />
        <Route path="/knowledge-base/:id"     element={<KnowledgeBasePage />} />
        <Route path="/servers"         element={<ServersPage />} />
        <Route path="/monitoring"      element={<MonitoringPage />} />
        <Route path="/mission-control" element={<MissionControlPage />} />
        <Route path="/task-queue"      element={<TaskQueuePage />} />
        <Route path="/jira"            element={<JiraPage />} />
        <Route path="/a2a"             element={<A2APage />} />
        <Route path="/agents"          element={<AgentsPage />} />
        <Route path="/agent-chat"      element={<AgentChatPage />} />
        <Route path="/scheduler"       element={<SchedulerPage />} />
        <Route path="/security"        element={<SecurityPage />} />
        <Route path="/performance"     element={<PerformancePage />} />
        <Route path="/users"           element={<UsersPage />} />
        <Route path="/mcp"             element={<MCPPage />} />
        <Route path="/mcp-clients"     element={<McpClientsPage />} />
        <Route path="/alert-rules"     element={<AlertRulesPage />} />
        <Route path="/settings"        element={<SettingsPage />} />
        <Route path="/ssh"             element={<SSHPage />} />
        <Route path="/operations"      element={<OperationsPage />} />
        <Route path="/kubernetes"      element={<KubernetesPage />} />
        <Route path="/develop"         element={<DevelopPage />} />
        <Route path="/tool-builder"    element={<ToolBuilderPage />} />
        <Route path="/autonomy"        element={<AutonomyPage />} />
        <Route path="/ai-insights"     element={<AIInsightsPage />} />
        <Route path="/onboarding"      element={<OnboardingPage />} />
        <Route path="/tenant-settings" element={<TenantSettingsPage />} />
        <Route path="/superadmin"      element={<SuperAdminPage />} />
        {/* Convenience aliases — short URLs that match the sidebar labels. */}
        <Route path="/skills"          element={<Navigate to="/skill-studio" replace />} />
        <Route path="/live"            element={<Navigate to="/live-console" replace />} />
        <Route path="/config"          element={<Navigate to="/config-center" replace />} />
        <Route path="*"                element={<Navigate to="/incidents" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
      <ChatWidgetGate />
      <InstallPromptGate />
    </AuthProvider>
  )
}

/** Full-page spinner shown while the auth context is still resolving
 *  the current user. Kept inline + tokenised so it matches the rest of
 *  the chrome without pulling in another module. */
function AuthLoadingScreen() {
  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)',
      }}
      aria-busy="true"
      aria-label="Loading"
    >
      <div
        style={{
          width: 28, height: 28,
          border: '3px solid var(--border)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'itops-auth-spin 0.8s linear infinite',
        }}
      />
      <style>{`@keyframes itops-auth-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

/** Hide the floating chat bubble on the portal — the portal embeds the
 *  ChatWidget inline, so a second floating instance would be a duplicate. */
function ChatWidgetGate() {
  const location = useLocation()
  if (location.pathname.startsWith('/portal')) return null
  return <ChatWidget />
}

/** The admin Sidebar already captures `beforeinstallprompt` and surfaces
 *  an install affordance. To avoid double-prompting, only show the
 *  floating banner on /portal where the sidebar isn't rendered. */
function InstallPromptGate() {
  const location = useLocation()
  if (!location.pathname.startsWith('/portal')) return null
  return <InstallPrompt />
}
