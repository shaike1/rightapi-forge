import { useState, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, AlertTriangle, Workflow, BookOpen, Server, Container,
  LineChart, BellRing, Target, Settings2, ListTodo,
  Ticket, Network, Brain, Terminal,
  Bot, Wand2, MessageCircle, FlaskConical, Wrench, Sparkles, Radio, Clock, Plug,
  Lock, Activity, Rocket, Users, Settings, ShieldCheck, FileText, Repeat,
  Bell, ChevronLeft, ChevronRight, Sun, Moon, LogOut, X, Download, Boxes, GitBranch, Hammer, Github,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useWebSocket } from '../hooks/useWebSocket'
import { useNotifications } from '../hooks/useNotifications'
import styles from './Sidebar.module.css'

interface NavItem {
  to: string
  icon: ReactNode
  label: string
}

interface NavSection {
  label: string
  items: NavItem[]
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Operations',
    items: [
      { to: '/',                 icon: <LayoutDashboard size={18} />, label: 'Dashboard' },
      { to: '/incidents',        icon: <AlertTriangle size={18} />,   label: 'Incidents' },
      { to: '/problems',         icon: <Repeat size={18} />,          label: 'Problems' },
      { to: '/changes',          icon: <GitBranch size={18} />,       label: 'Changes' },
      { to: '/runbooks',         icon: <BookOpen size={18} />,        label: 'Runbooks' },
      { to: '/knowledge-base',   icon: <Brain size={18} />,           label: 'Knowledge Base' },
      { to: '/sla',              icon: <ShieldCheck size={18} />,     label: 'SLA' },
      { to: '/reports',          icon: <FileText size={18} />,        label: 'Reports' },
      { to: '/mission-control',  icon: <Target size={18} />,          label: 'Mission Control' },
      { to: '/operations',       icon: <Settings2 size={18} />,       label: 'Operations' },
      { to: '/task-queue',       icon: <ListTodo size={18} />,        label: 'Task Queue' },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { to: '/servers',          icon: <Server size={18} />,          label: 'Servers' },
      { to: '/assets',           icon: <Boxes size={18} />,           label: 'Assets (CMDB)' },
      { to: '/alert-rules',      icon: <BellRing size={18} />,        label: 'Alert Rules' },
      { to: '/performance',      icon: <Activity size={18} />,        label: 'Performance' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/agents',           icon: <Bot size={18} />,             label: 'Agents' },
      { to: '/agent-chat',       icon: <MessageCircle size={18} />,   label: 'Agent Chat' },
      { to: '/skill-studio',     icon: <FlaskConical size={18} />,    label: 'Skills' },
      { to: '/live-console',     icon: <Radio size={18} />,           label: 'Live Console' },
      { to: '/autonomy',         icon: <Activity size={18} />,        label: 'Autonomy' },
      { to: '/ai-insights',      icon: <Brain size={18} />,           label: 'AI Insights' },
    ],
  },
  {
    label: 'Development',
    items: [
      { to: '/workflow-builder', icon: <Workflow size={18} />,        label: 'Workflow Builder' },
      { to: '/agent-designer',   icon: <Wand2 size={18} />,           label: 'Agent Designer' },
      { to: '/tool-manager',     icon: <Wrench size={18} />,          label: 'Tool Manager' },
      { to: '/develop',          icon: <Sparkles size={18} />,        label: 'Develop' },
      { to: '/tool-builder',     icon: <Hammer size={18} />,          label: 'Tool Builder' },
      { to: '/scheduler',        icon: <Clock size={18} />,           label: 'Scheduler' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { to: '/mcp',              icon: <Brain size={18} />,           label: 'MCP Server' },
      { to: '/mcp-clients',      icon: <Plug size={18} />,            label: 'MCP Clients' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/config-center',    icon: <Rocket size={18} />,          label: 'Config & Deploy' },
      { to: '/security',         icon: <Lock size={18} />,            label: 'Security' },
    ],
  },
]

const sourceRepositoryUrl = typeof document === 'undefined'
  ? ''
  : document.querySelector<HTMLMetaElement>('meta[name="rightapi-source"]')?.content || ''
const publicSourceAvailable = sourceRepositoryUrl.startsWith('https://')

const ADMIN_ITEMS: NavItem[] = [
  { to: '/integrations',    icon: <Plug size={18} />,     label: 'Integrations' },
  { to: '/users',           icon: <Users size={18} />,    label: 'Users' },
  { to: '/tenant-settings', icon: <ShieldCheck size={18} />, label: 'Tenant Settings' },
  { to: '/settings',        icon: <Settings size={18} />, label: 'Settings' },
]

const INSTALL_DISMISSED_KEY = 'beacon_install_dismissed'
const COLLAPSE_KEY = 'beacon_sidebar_collapsed'

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const { connected, lastEvent } = useWebSocket()
  const { notifications, unreadCount, markRead, markAllRead, clearAll } = useNotifications(lastEvent)
  const [bellOpen, setBellOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement>(null)
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const isSuperadmin = user?.role === 'superadmin'
  const [installEvent, setInstallEvent] = useState<any>(null)
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(COLLAPSE_KEY) === '1')

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    document.documentElement.style.setProperty('--sidebar-w', collapsed ? '72px' : '248px')
  }, [collapsed])

  useEffect(() => {
    if (localStorage.getItem(INSTALL_DISMISSED_KEY)) return
    const handler = (e: Event) => { e.preventDefault(); setInstallEvent(e) }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function handleInstall() {
    if (!installEvent) return
    installEvent.prompt()
    const { outcome } = await installEvent.userChoice
    if (outcome === 'accepted' || outcome === 'dismissed') {
      localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
      setInstallEvent(null)
    }
  }

  function dismissInstall() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
    setInstallEvent(null)
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false)
      }
    }
    if (bellOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [bellOpen])

  function handleBellClick() {
    setBellOpen(v => !v)
  }

  function severityBorder(severity: string) {
    if (severity === 'critical') return 'var(--danger)'
    if (severity === 'warning') return 'var(--warning)'
    return 'var(--accent)'
  }

  function timeAgo(ts: number) {
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.brand}>
        <div className={styles.brandMark}>RF</div>
        {!collapsed && (
          <div className={styles.brandText}>
            <span className={styles.brandTitle}>RightAPI</span>
            <span className={styles.brandSub}>Forge</span>
          </div>
        )}
        <button
          className={styles.collapseBtn}
          onClick={() => setCollapsed(v => !v)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label="Toggle sidebar"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      <div className={styles.statusBar}>
        <span
          className={styles.liveDot}
          data-connected={connected}
          title={connected ? 'Live — real-time connected' : 'Connecting…'}
        />
        {!collapsed && (
          <span className={styles.liveLabel}>
            {connected ? 'Live' : 'Connecting…'}
          </span>
        )}
        <div ref={bellRef} className={styles.bellWrap}>
          <button
            className={styles.bellBtn}
            onClick={handleBellClick}
            title="Notifications"
            aria-label="Notifications"
          >
            <Bell size={16} />
            {unreadCount > 0 && (
              <span className={styles.bellBadge}>{unreadCount > 9 ? '9+' : unreadCount}</span>
            )}
          </button>
          {bellOpen && (
            <div className={styles.bellDropdown}>
              <div className={styles.bellHeader}>
                <span>Notifications</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={styles.clearBtn} onClick={markAllRead}>Mark all read</button>
                  <button className={styles.clearBtn} onClick={clearAll}>Clear</button>
                </div>
              </div>
              {notifications.length === 0 ? (
                <div className={styles.bellEmpty}>No notifications yet</div>
              ) : (
                <ul className={styles.bellList}>
                  {notifications.slice(0, 20).map(n => (
                    <li
                      key={n.id}
                      className={`${styles.bellItem} ${!n.read ? styles.bellItem_unread : ''}`}
                      style={{ borderLeft: `3px solid ${severityBorder(n.severity)}` }}
                      onClick={() => { if (!n.read) markRead(n.id) }}
                    >
                      <div className={styles.bellItemTitle}>{n.title}</div>
                      <div className={styles.bellItemMsg}>{n.message}</div>
                      <div className={styles.bellItemTime}>{timeAgo(n.ts)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <nav className={styles.nav}>
        {NAV_SECTIONS.map(section => (
          <div key={section.label} className={styles.navGroup}>
            {!collapsed && <span className={styles.sectionLabel}>{section.label}</span>}
            {section.items.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `${styles.navItem} ${isActive ? styles.active : ''}`
                }
              >
                <span className={styles.navIcon}>{item.icon}</span>
                {!collapsed && <span className={styles.navLabel}>{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}

        {isAdmin && (
          <div className={styles.navGroup}>
            {!collapsed && <span className={styles.sectionLabel}>Admin</span>}
            {ADMIN_ITEMS.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `${styles.navItem} ${isActive ? styles.active : ''}`
                }
              >
                <span className={styles.navIcon}>{item.icon}</span>
                {!collapsed && <span className={styles.navLabel}>{item.label}</span>}
              </NavLink>
            ))}
            {isSuperadmin && (
              <NavLink
                to="/superadmin"
                title={collapsed ? 'Super Admin' : undefined}
                className={({ isActive }) =>
                  `${styles.navItem} ${isActive ? styles.active : ''}`
                }
              >
                <span className={styles.navIcon}><ShieldCheck size={18} /></span>
                {!collapsed && <span className={styles.navLabel}>Super Admin</span>}
              </NavLink>
            )}
          </div>
        )}
      </nav>

      <div className={styles.footer}>
        {installEvent && !collapsed && (
          <div className={styles.installBanner}>
            <Download size={14} />
            <span style={{ flex: 1 }}>Install RightAPI Forge</span>
            <button className={styles.installBtn} onClick={handleInstall}>Install</button>
            <button className={styles.installDismiss} onClick={dismissInstall} aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        )}

        {user && user.username && !collapsed && (
          <div className={styles.userCard}>
            <div className={styles.avatar}>
              {user.username[0]?.toUpperCase() ?? '?'}
            </div>
            <div className={styles.userInfo}>
              <div className={styles.username}>{user.username}</div>
              <div className={styles.role}>{user.role}</div>
            </div>
          </div>
        )}

        {publicSourceAvailable && (
          <a
            className={styles.legalNotice}
            href={sourceRepositoryUrl}
            target="_blank"
            rel="noreferrer"
            title="View corresponding source code"
          >
            <Github size={14} />
            {!collapsed && <span>AGPL-3.0-or-later · Source</span>}
          </a>
        )}

        <div className={styles.actions}>
          <button
            className={styles.iconBtn}
            onClick={toggle}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            {!collapsed && <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>}
          </button>
          <button
            className={styles.iconBtn}
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={15} />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </div>
    </aside>
  )
}
