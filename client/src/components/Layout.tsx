import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'
import Sidebar from './Sidebar'
import { ToastContainer } from './Toast'
import styles from './Layout.module.css'

interface BreadcrumbItem {
  label: string
  to?: string
}

interface Props {
  title: string
  subtitle?: string
  actions?: ReactNode
  breadcrumbs?: BreadcrumbItem[]
  children: ReactNode
}

const PATH_LABELS: Record<string, string> = {
  '': 'Dashboard',
  incidents: 'Incidents',
  workflows: 'Workflows',
  'workflow-builder': 'Workflow Builder',
  'skill-studio': 'Skills',
  'agent-designer': 'Agent Designer',
  'tool-manager': 'Tool Manager',
  'live-console': 'Live Console',
  'config-center': 'Config & Deploy',
  runbooks: 'Runbooks',
  servers: 'Servers',
  monitoring: 'Monitoring',
  'mission-control': 'Mission Control',
  'task-queue': 'Task Queue',
  jira: 'Jira',
  a2a: 'A2A Mesh',
  agents: 'Agents',
  'agent-chat': 'Agent Chat',
  scheduler: 'Scheduler',
  security: 'Security',
  performance: 'Performance',
  users: 'Users',
  mcp: 'MCP Server',
  'alert-rules': 'Alert Rules',
  settings: 'Settings',
  ssh: 'SSH Terminal',
  operations: 'Operations',
  kubernetes: 'Kubernetes',
  develop: 'Develop',
  'tool-builder': 'Tool Builder',
}

function deriveBreadcrumbs(pathname: string): BreadcrumbItem[] {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return [{ label: 'Dashboard' }]
  return segments.map((seg, i) => {
    const label = PATH_LABELS[seg] ?? seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const isLast = i === segments.length - 1
    const to = isLast ? undefined : '/' + segments.slice(0, i + 1).join('/')
    return { label, to }
  })
}

export default function Layout({ title, subtitle, actions, breadcrumbs, children }: Props) {
  const location = useLocation()
  const crumbs = breadcrumbs ?? deriveBreadcrumbs(location.pathname)

  return (
    <div className={styles.shell}>
      <Sidebar />
      <main className={styles.main}>
        <div className={styles.headerBar}>
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            <Link to="/" className={styles.breadcrumbHome} aria-label="Home">
              <Home size={14} />
            </Link>
            {crumbs.map((c, i) => (
              <span key={i} className={styles.breadcrumbSegment}>
                <ChevronRight size={13} className={styles.breadcrumbSep} />
                {c.to
                  ? <Link to={c.to} className={styles.breadcrumbLink}>{c.label}</Link>
                  : <span className={styles.breadcrumbCurrent}>{c.label}</span>
                }
              </span>
            ))}
          </nav>
        </div>

        <div className={styles.pageHeader}>
          <div className={styles.pageHeaderText}>
            <h1 className={styles.pageTitle}>{title}</h1>
            {subtitle && <p className={styles.pageSubtitle}>{subtitle}</p>}
          </div>
          {actions && <div className={styles.pageActions}>{actions}</div>}
        </div>

        <div className={styles.pageContent}>
          {children}
        </div>
      </main>
      <ToastContainer />
    </div>
  )
}
