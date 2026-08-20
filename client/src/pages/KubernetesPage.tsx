import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import Badge from '../components/Badge'
import StatCard from '../components/StatCard'
import { api } from '../lib/api'
import styles from './KubernetesPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface K8sStatus { configured: boolean; version: string | null }

interface Pod {
  name: string; namespace: string; status: string
  restarts: number; age: string; node: string
}

interface Deployment {
  name: string; namespace: string; ready: string
  upToDate: number; available: number; age: string
}

interface Node {
  name: string; status: string; roles: string
  age: string; version: string; cpu: string; memory: string
}

interface K8sEvent {
  type: string; reason: string; object: string; message: string; age: string
}

type TabId = 'pods' | 'deployments' | 'nodes' | 'events'

// ── Helpers ───────────────────────────────────────────────────────────────────

function podStatusVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'Running') return 'success'
  if (status === 'Pending' || status === 'ContainerCreating') return 'warning'
  if (status === 'Failed' || status === 'CrashLoopBackOff' || status === 'Error' || status === 'OOMKilled') return 'danger'
  return 'neutral'
}

function nodeStatusVariant(status: string): 'success' | 'danger' {
  return status === 'Ready' ? 'success' : 'danger'
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function KubernetesPage() {
  const [k8sStatus, setK8sStatus] = useState<K8sStatus>({ configured: false, version: null })
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [selectedNs, setSelectedNs] = useState<string>('') // '' = all
  const [activeTab, setActiveTab] = useState<TabId>('pods')
  const [pods, setPods] = useState<Pod[]>([])
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [nodes, setNodes] = useState<Node[]>([])
  const [events, setEvents] = useState<K8sEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [tabLoading, setTabLoading] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const st = await api.get<K8sStatus>('/api/k8s/status')
      setK8sStatus(st)
    } catch {
      setK8sStatus({ configured: false, version: null })
    }
  }, [])

  const fetchNamespaces = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; items: { name: string }[] }>('/api/k8s/namespaces')
      if (res.configured && Array.isArray(res.items)) setNamespaces(res.items.map(n => n.name))
    } catch {}
  }, [])

  const fetchTabData = useCallback(async (tab: TabId, ns: string) => {
    setTabLoading(true)
    const nsParam = ns ? `?namespace=${encodeURIComponent(ns)}` : ''
    try {
      if (tab === 'pods') {
        const res = await api.get<{ configured: boolean; items: Pod[] }>(`/api/k8s/pods${nsParam}`)
        setPods(Array.isArray(res?.items) ? res.items : [])
      } else if (tab === 'deployments') {
        const res = await api.get<{ configured: boolean; items: Deployment[] }>(`/api/k8s/deployments${nsParam}`)
        setDeployments(Array.isArray(res?.items) ? res.items : [])
      } else if (tab === 'nodes') {
        const res = await api.get<{ configured: boolean; items: Node[] }>('/api/k8s/nodes')
        setNodes(Array.isArray(res?.items) ? res.items : [])
      } else if (tab === 'events') {
        const res = await api.get<{ configured: boolean; items: K8sEvent[] }>(`/api/k8s/events${nsParam}`)
        setEvents(Array.isArray(res?.items) ? res.items : [])
      }
    } catch {}
    setTabLoading(false)
  }, [])

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true)
      await fetchStatus()
      await fetchNamespaces()
      setLoading(false)
    }
    init()
  }, [fetchStatus, fetchNamespaces])

  // Reload tab when tab or namespace changes
  useEffect(() => {
    if (!loading) fetchTabData(activeTab, selectedNs)
  }, [activeTab, selectedNs, loading, fetchTabData])

  const handleRefresh = () => {
    fetchStatus()
    fetchNamespaces()
    fetchTabData(activeTab, selectedNs)
  }

  // ── Derived stats ──────────────────────────────────────────────────────────
  const runningPods = pods.filter(p => p.status === 'Running').length

  // ── Not configured state ───────────────────────────────────────────────────
  if (!loading && !k8sStatus.configured) {
    return (
      <Layout title="Kubernetes" subtitle="Container orchestration monitoring">
        <div className={styles.notConfigured}>
          <div className={styles.notConfiguredIcon}>☸️</div>
          <h2 className={styles.notConfiguredTitle}>Kubernetes not configured</h2>
          <p className={styles.notConfiguredText}>
            No kubeconfig file was found. To connect to a Kubernetes cluster,
            set the <code className={styles.code}>KUBECONFIG</code> environment variable
            or place your kubeconfig at:
          </p>
          <ul className={styles.pathList}>
            <li><code className={styles.code}>$KUBECONFIG</code></li>
            <li><code className={styles.code}>/data/itops-agents/kubeconfig</code></li>
            <li><code className={styles.code}>~/.kube/config</code></li>
          </ul>
          <p className={styles.notConfiguredText}>Then restart the server.</p>
        </div>
      </Layout>
    )
  }

  const TABS: { id: TabId; label: string }[] = [
    { id: 'pods', label: 'Pods' },
    { id: 'deployments', label: 'Deployments' },
    { id: 'nodes', label: 'Nodes' },
    { id: 'events', label: 'Events' },
  ]

  return (
    <Layout title="Kubernetes" subtitle="Container orchestration monitoring">
      {/* Header bar */}
      <div className={styles.headerBar}>
        <div className={styles.headerLeft}>
          <span className={styles.headerTitle}>☸️ Kubernetes</span>
          {k8sStatus.version && (
            <span className={styles.version}>{k8sStatus.version}</span>
          )}
        </div>
        <div className={styles.headerRight}>
          <select
            className={styles.nsSelect}
            value={selectedNs}
            onChange={e => setSelectedNs(e.target.value)}
          >
            <option value="">All namespaces</option>
            {namespaces.map(ns => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
          <button className={styles.refreshBtn} onClick={handleRefresh} title="Refresh">
            ↺ Refresh
          </button>
          <span className={`${styles.statusBadge} ${k8sStatus.configured ? styles.statusConnected : styles.statusNotConfigured}`}>
            {k8sStatus.configured ? '● Connected' : '○ Not configured'}
          </span>
        </div>
      </div>

      {/* Stat cards */}
      <div className={styles.statsRow}>
        <StatCard label="Total Pods" value={loading ? '—' : pods.length} color="neutral" />
        <StatCard label="Running Pods" value={loading ? '—' : runningPods} color={runningPods > 0 ? 'success' : 'neutral'} />
        <StatCard label="Deployments" value={loading ? '—' : deployments.length} color="neutral" />
        <StatCard label="Nodes" value={loading ? '—' : nodes.length} color={nodes.length > 0 ? 'success' : 'neutral'} />
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={styles.tabContent}>
        {tabLoading ? (
          <div className={styles.loading}>Loading…</div>
        ) : (
          <>
            {/* Pods tab */}
            {activeTab === 'pods' && (
              pods.length === 0 ? (
                <div className={styles.empty}>No pods found{selectedNs ? ` in namespace "${selectedNs}"` : ''}.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.th}>Name</th>
                        <th className={styles.th}>Namespace</th>
                        <th className={styles.th}>Status</th>
                        <th className={styles.th}>Restarts</th>
                        <th className={styles.th}>Age</th>
                        <th className={styles.th}>Node</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pods.map((pod, i) => (
                        <tr key={i} className={styles.tr}>
                          <td className={`${styles.td} ${styles.tdName}`}>{pod.name}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{pod.namespace}</td>
                          <td className={styles.td}>
                            <Badge variant={podStatusVariant(pod.status)}>{pod.status}</Badge>
                          </td>
                          <td className={`${styles.td} ${styles.tdMono} ${pod.restarts > 0 ? styles.tdWarn : ''}`}>
                            {pod.restarts}
                          </td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{pod.age}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{pod.node}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* Deployments tab */}
            {activeTab === 'deployments' && (
              deployments.length === 0 ? (
                <div className={styles.empty}>No deployments found{selectedNs ? ` in namespace "${selectedNs}"` : ''}.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.th}>Name</th>
                        <th className={styles.th}>Namespace</th>
                        <th className={styles.th}>Ready</th>
                        <th className={styles.th}>Up-to-date</th>
                        <th className={styles.th}>Available</th>
                        <th className={styles.th}>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deployments.map((dep, i) => (
                        <tr key={i} className={styles.tr}>
                          <td className={`${styles.td} ${styles.tdName}`}>{dep.name}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{dep.namespace}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{dep.ready}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{dep.upToDate}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{dep.available}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{dep.age}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* Nodes tab */}
            {activeTab === 'nodes' && (
              nodes.length === 0 ? (
                <div className={styles.empty}>No nodes found.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.th}>Name</th>
                        <th className={styles.th}>Status</th>
                        <th className={styles.th}>Roles</th>
                        <th className={styles.th}>Age</th>
                        <th className={styles.th}>Version</th>
                        <th className={styles.th}>CPU</th>
                        <th className={styles.th}>Memory</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nodes.map((node, i) => (
                        <tr key={i} className={styles.tr}>
                          <td className={`${styles.td} ${styles.tdName}`}>{node.name}</td>
                          <td className={styles.td}>
                            <Badge variant={nodeStatusVariant(node.status)}>{node.status}</Badge>
                          </td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{node.roles}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{node.age}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{node.version}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{node.cpu}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{node.memory}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* Events tab */}
            {activeTab === 'events' && (
              events.length === 0 ? (
                <div className={styles.empty}>No events found{selectedNs ? ` in namespace "${selectedNs}"` : ''}.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.th}>Type</th>
                        <th className={styles.th}>Reason</th>
                        <th className={styles.th}>Object</th>
                        <th className={styles.th}>Message</th>
                        <th className={styles.th}>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((ev, i) => (
                        <tr key={i} className={`${styles.tr} ${ev.type === 'Warning' ? styles.trWarning : ''}`}>
                          <td className={styles.td}>
                            <Badge variant={ev.type === 'Warning' ? 'warning' : 'neutral'}>{ev.type}</Badge>
                          </td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{ev.reason}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{ev.object}</td>
                          <td className={`${styles.td} ${styles.tdMessage}`}>{ev.message}</td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{ev.age}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </>
        )}
      </div>
    </Layout>
  )
}
