export type UserRole = 'superadmin' | 'admin' | 'operator' | 'viewer' | 'requester'

export interface User {
  id: string
  username: string
  email?: string
  role: UserRole
  /** Tenant the user belongs to. Set by the multitenant migration —
   *  pre-migration logins resolve to the system tenant. */
  tenantId?: string
}

export interface Incident {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  status: 'open' | 'investigating' | 'mitigating' | 'resolved' | 'closed'
  assignedTo?: string
  source?: string
  createdAt: string
  updatedAt: string
  slaBreached?: boolean
  slaMinutes?: number
}

export interface Workflow {
  id: string
  name: string
  description?: string
  steps: WorkflowStep[]
  createdAt: string
  status?: string
}

export interface WorkflowStep {
  id: string
  type: string
  config: Record<string, unknown>
}

/** ServerRegistry row as returned by /api/servers. The local entry has
 *  host=null/sshUser=null and uses nsenter; remote entries hold SSH info. */
export interface Server {
  id: string
  name: string
  host: string | null
  sshUser: string | null
  sshPort: number
  sshKeyPath: string | null
  tags: string[]
  sshOptions: Record<string, string>
  enabled: boolean
  isLocal: boolean
  lastSeen: string | null
  lastCheckStatus: 'ok' | 'error' | 'unknown'
  lastCheckAt: string | null
  createdAt: string
  updatedAt: string
}

/** Time-series point returned by /api/metrics-history/series. */
export interface MetricPoint {
  ts: number       // epoch ms
  value: number
}

export interface MetricSeries {
  serverId: string
  metricType: 'cpu' | 'memory' | 'disk' | 'load1' | 'load5'
  dimension: string | null
  points: MetricPoint[]
}

export interface MetricSample {
  timestamp: string
  serverId: string
  metricType: 'cpu' | 'memory' | 'disk' | 'load1' | 'load5'
  value: number
  dimension: string | null
}

/** Item in the /api/activity/recent feed. */
export interface ActivityItem {
  id: string
  timestamp: string
  kind:
    | 'incident_opened'
    | 'incident_escalated'
    | 'incident_resolved'
    | 'incident_closed'
    | 'agent_note'
    | 'agent_action'
    | 'escalation_level'
    | 'remediation_step'
  message: string
  actor: string
  actorName?: string
  incidentId?: string
  incidentTitle?: string
  serverId?: string | null
  level?: number
}

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  action: string
  enabled: boolean
  lastRun?: string
  nextRun?: string
  lastStatus?: string
}

export interface Agent {
  id: string
  name: string
  type: string
  status: 'idle' | 'busy' | 'error' | 'offline'
  model?: string
  skills?: string[]
  lastActivity?: string
  tasksCompleted?: number
}
