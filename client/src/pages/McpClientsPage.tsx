import { useEffect, useMemo, useState, useCallback } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Modal from '../components/Modal'
import { api } from '../lib/api'
import { toast } from '../hooks/useToast'
import styles from './McpClientsPage.module.css'

type Transport = 'http' | 'sse' | 'stdio'

interface ServerDef {
  id: string
  name: string
  description?: string
  transport: Transport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  enabled: boolean
  exposeToAgents: boolean
  hasAuthToken: boolean
}

interface ServerStatus {
  id: string
  name: string
  transport: Transport
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  enabled: boolean
  exposeToAgents: boolean
  lastConnectedAt?: string
  lastError?: string
  toolCount: number
}

interface ServerSummary {
  def: ServerDef
  status: ServerStatus
}

interface ToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
}

const STATUS_COLOR: Record<ServerStatus['status'], string> = {
  connected: 'var(--success)',
  connecting: 'var(--warning)',
  disconnected: 'var(--text3)',
  error: 'var(--danger)',
}

const EMPTY_FORM: ServerFormState = {
  id: '',
  name: '',
  description: '',
  transport: 'http',
  url: '',
  authToken: '',
  headersJson: '',
  command: '',
  argsCsv: '',
  envJson: '',
  enabled: true,
  exposeToAgents: true,
}

interface ServerFormState {
  id: string
  name: string
  description: string
  transport: Transport
  url: string
  authToken: string
  headersJson: string
  command: string
  argsCsv: string
  envJson: string
  enabled: boolean
  exposeToAgents: boolean
}

export default function McpClientsPage() {
  const [servers, setServers] = useState<ServerSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ServerFormState | null>(null)
  const [editIsNew, setEditIsNew] = useState(false)

  const [tools, setTools] = useState<Record<string, ToolDescriptor[]>>({})
  const [toolBusy, setToolBusy] = useState<string | null>(null)

  const [callPanel, setCallPanel] = useState<null | { serverId: string; tool: string; args: string }>(null)
  const [callResult, setCallResult] = useState<string>('')
  const [callRunning, setCallRunning] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.get<{ servers: ServerSummary[] }>('/api/mcp-clients/servers')
      const list = Array.isArray(data?.servers) ? data.servers : []
      setServers(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Auto-refresh every 10s so connection state stays current.
  useEffect(() => {
    const t = setInterval(() => { void refresh() }, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const totalConnected = useMemo(
    () => servers.filter(s => s.status.status === 'connected').length,
    [servers],
  )
  const totalTools = useMemo(
    () => servers.reduce((sum, s) => sum + (s.status.toolCount || 0), 0),
    [servers],
  )

  async function withBusy<T>(id: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusyId(id)
    try {
      return await fn()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function connectServer(id: string) {
    await withBusy(id, async () => {
      await api.post(`/api/mcp-clients/servers/${id}/connect`)
      toast.success(`Connecting ${id}…`)
      await refresh()
    })
  }

  async function disconnectServer(id: string) {
    await withBusy(id, async () => {
      await api.post(`/api/mcp-clients/servers/${id}/disconnect`)
      toast.success(`Disconnected ${id}`)
      await refresh()
    })
  }

  async function deleteServer(id: string) {
    if (!confirm(`Delete MCP server "${id}"?`)) return
    await withBusy(id, async () => {
      await api.delete(`/api/mcp-clients/servers/${id}`)
      toast.success(`Deleted ${id}`)
      await refresh()
    })
  }

  async function testServer(id: string) {
    await withBusy(id, async () => {
      const res = await api.post<{ ok: boolean; toolCount?: number; error?: string }>(
        `/api/mcp-clients/servers/${id}/test`,
      )
      if (res.ok) {
        toast.success(`Connected — ${res.toolCount ?? 0} tools available`)
      } else {
        toast.error(`Test failed: ${res.error || 'unknown error'}`)
      }
      await refresh()
    })
  }

  async function loadTools(id: string) {
    setToolBusy(id)
    try {
      const res = await api.get<{ tools: ToolDescriptor[] }>(`/api/mcp-clients/servers/${id}/tools`)
      setTools(prev => ({ ...prev, [id]: Array.isArray(res?.tools) ? res.tools : [] }))
    } catch (e) {
      toast.error(`Failed to list tools: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setToolBusy(null)
    }
  }

  async function saveServer() {
    if (!editing) return
    const body = formToBody(editing)
    if (typeof body === 'string') {
      toast.error(body)
      return
    }
    try {
      if (editIsNew) {
        await api.post('/api/mcp-clients/servers', body)
        toast.success(`Added ${body.id}`)
      } else {
        await api.put(`/api/mcp-clients/servers/${body.id}`, body)
        toast.success(`Updated ${body.id}`)
      }
      setEditing(null)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  function startEdit(s?: ServerSummary) {
    if (!s) {
      setEditing(EMPTY_FORM)
      setEditIsNew(true)
      return
    }
    setEditIsNew(false)
    setEditing({
      id: s.def.id,
      name: s.def.name || '',
      description: s.def.description || '',
      transport: s.def.transport,
      url: s.def.url || '',
      authToken: '',
      headersJson: s.def.headers ? JSON.stringify(s.def.headers, null, 2) : '',
      command: s.def.command || '',
      argsCsv: (s.def.args || []).join(' '),
      envJson: '',
      enabled: !!s.def.enabled,
      exposeToAgents: !!s.def.exposeToAgents,
    })
  }

  async function runToolCall() {
    if (!callPanel) return
    setCallRunning(true)
    setCallResult('')
    try {
      let args: unknown = {}
      if (callPanel.args.trim()) {
        try { args = JSON.parse(callPanel.args) }
        catch (e) {
          toast.error(`Args must be valid JSON: ${e instanceof Error ? e.message : String(e)}`)
          setCallRunning(false)
          return
        }
      }
      const res = await api.post<{ ok: boolean; content?: unknown; error?: string }>(
        `/api/mcp-clients/servers/${callPanel.serverId}/call`,
        { tool: callPanel.tool, args },
      )
      setCallResult(JSON.stringify(res, null, 2))
    } catch (e) {
      setCallResult(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2))
    } finally {
      setCallRunning(false)
    }
  }

  return (
    <Layout title="MCP Clients" subtitle="Connect ITOps to external Model Context Protocol servers">
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Servers</div>
          <div className={styles.statValue}>{servers.length}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Connected</div>
          <div className={styles.statValue}>{totalConnected}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Tools available</div>
          <div className={styles.statValue}>{totalTools}</div>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Connected MCP servers"
          subtitle="Servers ITOps can call as a client (the inverse of the MCP Server page)"
          actions={
            <Button variant="primary" size="sm" onClick={() => startEdit()}>+ Add server</Button>
          }
        />
        <CardBody>
          {loading && <div className={styles.empty}>Loading…</div>}
          {error && <div className={styles.errorMsg}>Failed to load servers: {error}</div>}
          {!loading && !error && servers.length === 0 && (
            <div className={styles.empty}>
              No MCP servers configured. Click <strong>Add server</strong> to wire one in
              (e.g. OpenClaw at http://10.0.0.115:18789/mcp).
            </div>
          )}
          {servers.map(s => (
            <div key={s.def.id} className={styles.serverRow}>
              <div className={styles.serverHeader}>
                <div>
                  <div className={styles.serverName}>
                    <span
                      className={styles.statusDot}
                      style={{ background: STATUS_COLOR[s.status.status] }}
                      title={s.status.status}
                    />
                    {s.def.name}
                    <span className={styles.serverId}>({s.def.id})</span>
                  </div>
                  {s.def.description && <div className={styles.serverDesc}>{s.def.description}</div>}
                  <div className={styles.serverMeta}>
                    <span>{s.def.transport}</span>
                    <span>·</span>
                    <span className={styles.mono}>
                      {s.def.transport === 'stdio' ? s.def.command : s.def.url}
                    </span>
                    {s.def.hasAuthToken && <><span>·</span><span>auth</span></>}
                    {s.def.exposeToAgents && <><span>·</span><span>agents</span></>}
                    <span>·</span>
                    <span>{s.status.toolCount} tools</span>
                  </div>
                  {s.status.lastError && (
                    <div className={styles.errMsg}>Last error: {s.status.lastError}</div>
                  )}
                </div>

                <div className={styles.actions}>
                  <Button size="sm" onClick={() => testServer(s.def.id)} disabled={busyId === s.def.id}>
                    Test
                  </Button>
                  {s.status.status === 'connected' ? (
                    <Button size="sm" variant="secondary" onClick={() => disconnectServer(s.def.id)} disabled={busyId === s.def.id}>
                      Disconnect
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => connectServer(s.def.id)} disabled={busyId === s.def.id}>
                      Connect
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => startEdit(s)}>Edit</Button>
                  <Button size="sm" variant="danger" onClick={() => deleteServer(s.def.id)} disabled={busyId === s.def.id}>
                    Delete
                  </Button>
                </div>
              </div>

              <div className={styles.toolsArea}>
                <div className={styles.toolsHeader}>
                  <span>Tools</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => loadTools(s.def.id)}
                    disabled={s.status.status !== 'connected' || toolBusy === s.def.id}
                  >
                    {toolBusy === s.def.id ? 'Loading…' : 'Refresh'}
                  </Button>
                </div>
                {tools[s.def.id]?.length ? (
                  <ul className={styles.toolsList}>
                    {tools[s.def.id].map(t => (
                      <li key={t.name} className={styles.toolItem}>
                        <div className={styles.toolName}>{t.name}</div>
                        {t.description && <div className={styles.toolDesc}>{t.description}</div>}
                        <div className={styles.toolActions}>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setCallPanel({ serverId: s.def.id, tool: t.name, args: '{}' })
                              setCallResult('')
                            }}
                          >
                            Try…
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className={styles.toolsEmpty}>
                    {s.status.status === 'connected'
                      ? 'No tools loaded yet. Click Refresh.'
                      : 'Connect to list tools.'}
                  </div>
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editIsNew ? 'Add MCP server' : `Edit ${editing?.id ?? ''}`}
        width={620}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveServer}>Save & connect</Button>
          </>
        }
      >
        {editing && (
          <ServerForm
            value={editing}
            isNew={editIsNew}
            onChange={setEditing}
          />
        )}
      </Modal>

      <Modal
        open={!!callPanel}
        onClose={() => { setCallPanel(null); setCallResult('') }}
        title={callPanel ? `Call ${callPanel.serverId}/${callPanel.tool}` : ''}
        width={640}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCallPanel(null); setCallResult('') }}>Close</Button>
            <Button variant="primary" onClick={runToolCall} loading={callRunning}>Invoke</Button>
          </>
        }
      >
        {callPanel && (
          <div className={styles.callForm}>
            <label className={styles.label}>Arguments (JSON)</label>
            <textarea
              className={styles.textarea}
              rows={6}
              value={callPanel.args}
              onChange={e => setCallPanel({ ...callPanel, args: e.target.value })}
              spellCheck={false}
            />
            {callResult && (
              <>
                <label className={styles.label}>Result</label>
                <pre className={styles.resultPre}>{callResult}</pre>
              </>
            )}
          </div>
        )}
      </Modal>
    </Layout>
  )
}

function ServerForm({
  value, isNew, onChange,
}: {
  value: ServerFormState
  isNew: boolean
  onChange: (next: ServerFormState) => void
}) {
  const set = (patch: Partial<ServerFormState>) => onChange({ ...value, ...patch })
  return (
    <div className={styles.form}>
      <div className={styles.row}>
        <label className={styles.label}>ID</label>
        <input
          className={styles.input}
          value={value.id}
          disabled={!isNew}
          onChange={e => set({ id: e.target.value })}
          placeholder="openclaw"
        />
      </div>
      <div className={styles.row}>
        <label className={styles.label}>Name</label>
        <input className={styles.input} value={value.name} onChange={e => set({ name: e.target.value })} placeholder="OpenClaw" />
      </div>
      <div className={styles.row}>
        <label className={styles.label}>Description</label>
        <input className={styles.input} value={value.description} onChange={e => set({ description: e.target.value })} placeholder="Optional" />
      </div>
      <div className={styles.row}>
        <label className={styles.label}>Transport</label>
        <select
          className={styles.input}
          value={value.transport}
          onChange={e => set({ transport: e.target.value as Transport })}
        >
          <option value="http">HTTP (Streamable)</option>
          <option value="sse">SSE</option>
          <option value="stdio">stdio (local subprocess)</option>
        </select>
      </div>
      {(value.transport === 'http' || value.transport === 'sse') && (
        <>
          <div className={styles.row}>
            <label className={styles.label}>URL</label>
            <input className={styles.input} value={value.url} onChange={e => set({ url: e.target.value })} placeholder="http://10.0.0.115:18789/mcp" />
          </div>
          <div className={styles.row}>
            <label className={styles.label}>Auth token (optional)</label>
            <input className={styles.input} type="password" value={value.authToken} onChange={e => set({ authToken: e.target.value })} placeholder="leave blank to keep existing" />
          </div>
          <div className={styles.row}>
            <label className={styles.label}>Headers (JSON, optional)</label>
            <textarea className={styles.textarea} rows={3} value={value.headersJson} onChange={e => set({ headersJson: e.target.value })} placeholder='{"X-API-Key": "…"}' />
          </div>
        </>
      )}
      {value.transport === 'stdio' && (
        <>
          <div className={styles.row}>
            <label className={styles.label}>Command</label>
            <input className={styles.input} value={value.command} onChange={e => set({ command: e.target.value })} placeholder="npx" />
          </div>
          <div className={styles.row}>
            <label className={styles.label}>Args (space-separated)</label>
            <input className={styles.input} value={value.argsCsv} onChange={e => set({ argsCsv: e.target.value })} placeholder="-y @some/mcp-server" />
          </div>
          <div className={styles.row}>
            <label className={styles.label}>Env (JSON, optional)</label>
            <textarea className={styles.textarea} rows={3} value={value.envJson} onChange={e => set({ envJson: e.target.value })} placeholder='{"FOO": "bar"}' />
          </div>
        </>
      )}
      <div className={styles.checkRow}>
        <label><input type="checkbox" checked={value.enabled} onChange={e => set({ enabled: e.target.checked })} /> Enabled (auto-connect on boot)</label>
      </div>
      <div className={styles.checkRow}>
        <label><input type="checkbox" checked={value.exposeToAgents} onChange={e => set({ exposeToAgents: e.target.checked })} /> Expose tools to agents (via the <code>mcp</code> skill)</label>
      </div>
    </div>
  )
}

function formToBody(f: ServerFormState): Record<string, unknown> | string {
  if (!f.id.trim()) return 'ID is required'
  if (!/^[a-zA-Z0-9_.-]+$/.test(f.id.trim())) return 'ID must match [a-zA-Z0-9_.-]+'
  const body: Record<string, unknown> = {
    id: f.id.trim(),
    name: f.name.trim() || f.id.trim(),
    description: f.description.trim() || undefined,
    transport: f.transport,
    enabled: f.enabled,
    exposeToAgents: f.exposeToAgents,
  }
  if (f.transport === 'http' || f.transport === 'sse') {
    if (!f.url.trim()) return 'URL is required'
    body.url = f.url.trim()
    if (f.authToken) body.authToken = f.authToken
    if (f.headersJson.trim()) {
      try { body.headers = JSON.parse(f.headersJson) }
      catch { return 'Headers must be valid JSON' }
    }
  } else {
    if (!f.command.trim()) return 'Command is required'
    body.command = f.command.trim()
    if (f.argsCsv.trim()) body.args = f.argsCsv.trim().split(/\s+/)
    if (f.envJson.trim()) {
      try { body.env = JSON.parse(f.envJson) }
      catch { return 'Env must be valid JSON' }
    }
  }
  return body
}
