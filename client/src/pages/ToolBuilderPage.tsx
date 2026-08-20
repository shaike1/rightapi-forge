import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Archive, Check, ChevronRight, Cloud, GitCompare, History, MessageSquare, Play,
  Plus, Redo2, RefreshCw, Rocket, Search, ShieldCheck, Undo2, Wrench,
} from 'lucide-react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { api } from '../lib/api'
import styles from './ToolBuilderPage.module.css'

type Lifecycle = 'draft' | 'ready' | 'archived'
interface CatalogTool { id: string; name: string; slug: string; description: string; owner: string; revision: number; lifecycle: Lifecycle; releaseStatus: string; health: 'healthy' | 'not_deployed' | 'degraded'; deploymentId?: string; deployedRevision?: number; launches: number; updatedAt: string }
interface PageSpec { id: string; name: string; path: string; layout: 'dashboard' | 'list' | 'detail' | 'form' | 'custom'; components: Array<{ id: string; type: string; title?: string }> }
interface AppSpec { metadata: { name: string; slug: string; description: string }; pages: PageSpec[]; dataModels: unknown[]; actions: unknown[]; integrations: unknown[]; roles: unknown[]; deploymentTarget: { visibility: 'private' | 'tenant' | 'public' } }
interface Project { id: string; name: string; status: Lifecycle; currentRevision: number; updatedAt: string; revision: { spec: AppSpec; message: string; actor: string; createdAt: string } }
interface EditState { canUndo: boolean; canRedo: boolean; undoDepth: number; redoDepth: number }
interface Revision { revision: number; message: string; actor: string; createdAt: string; spec: AppSpec }
interface Release { id: string; revision: number; status: string; risk: string; requiredApprovals: number; approvals: unknown[] }
interface Connection { id: string; ref: string; name: string; provider: string; capabilities: string[]; status: 'ready' | 'disabled' }
type View = 'catalog' | 'builder' | 'connections'

export default function ToolBuilderPage() {
  const [view, setView] = useState<View>('catalog')
  const [tools, setTools] = useState<CatalogTool[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [editState, setEditState] = useState<EditState | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [releases, setReleases] = useState<Release[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    const [catalog, projectList, connectionList] = await Promise.all([
      api.get<{ tools: CatalogTool[] }>('/api/builder/catalog'),
      api.get<{ projects: Project[] }>('/api/builder/projects?includeArchived=true'),
      api.get<{ connections: Connection[] }>('/api/builder/connections'),
    ])
    setTools(catalog.tools); setProjects(projectList.projects); setConnections(connectionList.connections)
  }, [])

  const loadProject = useCallback(async (id: string) => {
    const [detail, history, releaseList] = await Promise.all([
      api.get<{ project: Project; editState: EditState }>(`/api/builder/projects/${id}`),
      api.get<{ revisions: Revision[] }>(`/api/builder/projects/${id}/revisions`),
      api.get<{ releases: Release[] }>(`/api/builder/projects/${id}/releases`),
    ])
    setSelectedId(id); setProject(detail.project); setEditState(detail.editState); setRevisions(history.revisions); setReleases(releaseList.releases)
  }, [])

  useEffect(() => { load().catch(error => fail(error)) }, [load])

  async function act(name: string, work: () => Promise<void>) {
    setBusy(name); setNotice(null)
    try { await work(); setNotice({ kind: 'ok', text: 'Saved' }) } catch (error) { fail(error) } finally { setBusy('') }
  }
  function fail(error: unknown) { setNotice({ kind: 'error', text: error instanceof Error ? friendly(error.message) : String(error) }) }

  async function createProject(message: string) {
    await act('create', async () => {
      const result = await api.post<{ project: Project }>('/api/builder/conversations', { message })
      await load(); await loadProject(result.project.id); setView('builder')
    })
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim(); return q ? tools.filter(tool => `${tool.name} ${tool.description} ${tool.owner}`.toLowerCase().includes(q)) : tools
  }, [tools, query])

  return (
    <Layout title="Tool Builder" actions={<Button size="sm" variant="ghost" onClick={() => load()} title="Refresh"><RefreshCw size={15} /> Refresh</Button>}>
      <div className={styles.tabs} role="tablist">
        <Tab active={view === 'catalog'} onClick={() => setView('catalog')} icon={<Wrench size={16} />}>Catalog</Tab>
        <Tab active={view === 'builder'} onClick={() => setView('builder')} icon={<MessageSquare size={16} />}>Build</Tab>
        <Tab active={view === 'connections'} onClick={() => setView('connections')} icon={<Cloud size={16} />}>Connections</Tab>
      </div>
      {notice && <div className={`${styles.notice} ${notice.kind === 'error' ? styles.error : ''}`}>{notice.text}</div>}
      {view === 'catalog' && <Catalog tools={filtered} query={query} setQuery={setQuery} open={id => { loadProject(id).then(() => setView('builder')).catch(fail) }} launch={id => act('launch', async () => { const result = await api.post<{ accessUrl: string }>(`/api/builder/catalog/${id}/launch`, {}); window.open(result.accessUrl, '_blank', 'noopener,noreferrer'); await load() })} lifecycle={(id, status) => act('lifecycle', async () => { await api.patch(`/api/builder/catalog/${id}/lifecycle`, { status }); await load() })} />}
      {view === 'builder' && <Builder projects={projects} project={project} editState={editState} revisions={revisions} releases={releases} busy={busy} select={id => loadProject(id).catch(fail)} createProject={createProject} run={(name, fn) => act(name, async () => { await fn(); if (selectedId) await loadProject(selectedId); await load() })} />}
      {view === 'connections' && <Connections connections={connections} busy={busy} create={(input) => act('connection', async () => { await api.post('/api/builder/connections', input); await load() })} toggle={(item) => act('connection', async () => { await api.patch(`/api/builder/connections/${item.id}/status`, { status: item.status === 'ready' ? 'disabled' : 'ready' }); await load() })} />}
    </Layout>
  )
}

function Tab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return <button className={`${styles.tab} ${active ? styles.activeTab : ''}`} onClick={onClick} role="tab" aria-selected={active}>{icon}{children}</button>
}

function Catalog({ tools, query, setQuery, open, launch, lifecycle }: { tools: CatalogTool[]; query: string; setQuery: (v: string) => void; open: (id: string) => void; launch: (id: string) => void; lifecycle: (id: string, status: Lifecycle) => void }) {
  return <section className={styles.catalog}>
    <div className={styles.listToolbar}><label className={styles.search}><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tools" /></label><span>{tools.length} tools</span></div>
    <div className={styles.tableWrap}><table><thead><tr><th>Tool</th><th>Owner</th><th>Revision</th><th>Release</th><th>Health</th><th>Usage</th><th aria-label="Actions" /></tr></thead><tbody>
      {tools.map(tool => <tr key={tool.id}><td><button className={styles.toolLink} onClick={() => open(tool.id)}>{tool.name}<small>{tool.description || tool.slug}</small></button></td><td>{tool.owner}</td><td>r{tool.revision}</td><td><Status value={tool.releaseStatus} /></td><td><Status value={tool.health} /></td><td>{tool.launches}</td><td className={styles.rowActions}>{tool.lifecycle === 'archived' ? <button title="Restore" onClick={() => lifecycle(tool.id, 'draft')}><RefreshCw size={15} /></button> : <>{tool.health === 'healthy' && <button title="Launch tool" onClick={() => launch(tool.id)}><Play size={15} /></button>}<button title="Open editor" onClick={() => open(tool.id)}><ChevronRight size={17} /></button><button title="Archive" onClick={() => lifecycle(tool.id, 'archived')}><Archive size={15} /></button></>}</td></tr>)}
      {tools.length === 0 && <tr><td colSpan={7} className={styles.empty}>No tools match this view.</td></tr>}
    </tbody></table></div>
  </section>
}

function Builder({ projects, project, editState, revisions, releases, busy, select, createProject, run }: { projects: Project[]; project: Project | null; editState: EditState | null; revisions: Revision[]; releases: Release[]; busy: string; select: (id: string) => void; createProject: (message: string) => void; run: (name: string, fn: () => Promise<unknown>) => void }) {
  const [newTool, setNewTool] = useState('')
  return <div className={styles.builderGrid}>
    <aside className={styles.projectRail}>
      <form onSubmit={e => { e.preventDefault(); if (newTool.trim()) { createProject(newTool.trim()); setNewTool('') } }} className={styles.newTool}>
        <input value={newTool} onChange={e => setNewTool(e.target.value)} placeholder="New tool request" aria-label="New tool request" />
        <button title="Create tool" disabled={!newTool.trim() || busy === 'create'}><Plus size={16} /></button>
      </form>
      <div className={styles.projectList}>{projects.filter(item => item.status !== 'archived').map(item => <button key={item.id} className={project?.id === item.id ? styles.selectedProject : ''} onClick={() => select(item.id)}><span>{item.name}</span><small>r{item.currentRevision} · {item.status}</small></button>)}</div>
    </aside>
    {!project ? <div className={styles.blank}><Wrench size={28} /><strong>Select a tool or create one</strong></div> : <Editor project={project} editState={editState} revisions={revisions} releases={releases} busy={busy} run={run} />}
  </div>
}

function Editor({ project, editState, revisions, releases, busy, run }: { project: Project; editState: EditState | null; revisions: Revision[]; releases: Release[]; busy: string; run: (name: string, fn: () => Promise<unknown>) => void }) {
  const [message, setMessage] = useState('')
  const [pageId, setPageId] = useState(project.revision.spec.pages[0]?.id ?? '')
  const [componentId, setComponentId] = useState('')
  const [compareFrom, setCompareFrom] = useState(Math.max(1, project.currentRevision - 1))
  const [diff, setDiff] = useState<Record<string, any> | null>(null)
  useEffect(() => { setPageId(project.revision.spec.pages[0]?.id ?? ''); setComponentId(''); setDiff(null) }, [project.id, project.currentRevision])
  const page = project.revision.spec.pages.find(item => item.id === pageId) ?? project.revision.spec.pages[0]
  const component = page?.components.find(item => item.id === componentId)
  const latest = releases[0]
  const send = () => { if (!message.trim()) return; const text = message.trim(); setMessage(''); run('message', () => api.post(`/api/builder/projects/${project.id}/messages`, { message: text, expectedRevision: project.currentRevision })) }
  const edit = (payload: unknown) => run('visual', () => api.post(`/api/builder/projects/${project.id}/visual-edits`, { expectedRevision: project.currentRevision, edit: payload }))
  return <div className={styles.editor}>
    <div className={styles.editorToolbar}><div><strong>{project.name}</strong><span>Revision {project.currentRevision}</span></div><div className={styles.iconActions}>
      <button title="Undo" disabled={!editState?.canUndo || !!busy} onClick={() => run('undo', () => api.post(`/api/builder/projects/${project.id}/undo`, { expectedRevision: project.currentRevision }))}><Undo2 size={16} /></button>
      <button title="Redo" disabled={!editState?.canRedo || !!busy} onClick={() => run('redo', () => api.post(`/api/builder/projects/${project.id}/redo`, { expectedRevision: project.currentRevision }))}><Redo2 size={16} /></button>
      <button title="Run quality gates" disabled={!!busy} onClick={() => run('gate', () => api.post(`/api/builder/projects/${project.id}/gates`, {}))}><ShieldCheck size={16} /></button>
      <button title="Open isolated preview" disabled={!!busy} onClick={() => run('preview', async () => { const result = await api.post<{ session: { accessUrl: string } }>(`/api/builder/projects/${project.id}/previews`, {}); window.open(result.session.accessUrl, '_blank', 'noopener,noreferrer') })}><Play size={16} /></button>
      <button title="Request release" disabled={!!busy} onClick={() => run('release', () => api.post(`/api/builder/projects/${project.id}/releases`, {}))}><Rocket size={16} /></button>
    </div></div>
    <div className={styles.editorBody}>
      <section className={styles.canvasPane}>
        <div className={styles.pageTabs}>{project.revision.spec.pages.map(item => <button key={item.id} className={item.id === page?.id ? styles.activePage : ''} onClick={() => { setPageId(item.id); setComponentId('') }}>{item.name}</button>)}</div>
        {page && <div className={styles.previewCanvas}><header><div className={styles.previewMark}>{project.name.slice(0, 2).toUpperCase()}</div><nav>{project.revision.spec.pages.map(item => <button key={item.id} className={item.id === page.id ? styles.previewActive : ''} onClick={() => { setPageId(item.id); setComponentId('') }}>{item.name}</button>)}</nav></header><main><h2>{page.name}</h2><p>{project.revision.spec.metadata.description}</p>{page.components.length ? <div className={styles.componentGrid}>{page.components.map(item => <button className={item.id === componentId ? styles.selectedComponent : ''} onClick={() => setComponentId(item.id)} key={item.id}><strong>{item.title || item.id}</strong><small>{item.type}</small></button>)}</div> : <div className={styles.previewEmpty}>No components on this page</div>}</main></div>}
        <form className={styles.chatBar} onSubmit={e => { e.preventDefault(); send() }}><MessageSquare size={17} /><input value={message} onChange={e => setMessage(e.target.value)} placeholder="Describe the next change" /><Button size="sm" variant="primary" disabled={!message.trim() || !!busy}>Send</Button></form>
      </section>
      <aside className={styles.inspector}>
        <div className={styles.inspectorSection}><h3>Properties</h3><label>Tool name<input key={`${project.currentRevision}-name`} defaultValue={project.revision.spec.metadata.name} onBlur={e => e.target.value !== project.revision.spec.metadata.name && edit({ target: 'metadata', property: 'name', value: e.target.value })} /></label><label>Description<textarea key={`${project.currentRevision}-description`} defaultValue={project.revision.spec.metadata.description} onBlur={e => e.target.value !== project.revision.spec.metadata.description && edit({ target: 'metadata', property: 'description', value: e.target.value })} /></label>{page && <><label>Page name<input key={`${project.currentRevision}-${page.id}-name`} defaultValue={page.name} onBlur={e => e.target.value !== page.name && edit({ target: 'page', id: page.id, property: 'name', value: e.target.value })} /></label><label>Layout<select value={page.layout} onChange={e => edit({ target: 'page', id: page.id, property: 'layout', value: e.target.value })}>{['dashboard','list','detail','form','custom'].map(value => <option key={value}>{value}</option>)}</select></label></>}{component && <label>Component title<input key={`${project.currentRevision}-${page?.id}-${component.id}`} defaultValue={component.title || ''} onBlur={e => e.target.value !== (component.title || '') && edit({ target: 'component', pageId: page?.id, id: component.id, property: 'title', value: e.target.value })} /></label>}</div>
        <div className={styles.inspectorSection}><h3><History size={15} /> History</h3><div className={styles.compare}><select value={compareFrom} onChange={e => setCompareFrom(Number(e.target.value))}>{revisions.filter(item => item.revision !== project.currentRevision).map(item => <option key={item.revision} value={item.revision}>Revision {item.revision}</option>)}</select><button title="Compare revisions" disabled={project.currentRevision < 2} onClick={() => api.get<{ diff: Record<string, any> }>(`/api/builder/projects/${project.id}/revisions/compare?from=${compareFrom}&to=${project.currentRevision}`).then(result => setDiff(result.diff))}><GitCompare size={15} /></button></div>{diff && <DiffSummary diff={diff} />}</div>
        <div className={styles.inspectorSection}><h3><Rocket size={15} /> Release</h3>{latest ? <><Status value={latest.status} /><p>Revision {latest.revision} · {latest.risk} risk · {latest.approvals.length}/{latest.requiredApprovals} approvals</p>{latest.status === 'pending_review' && <Button size="xs" onClick={() => run('review', () => api.post(`/api/builder/releases/${latest.id}/review`, { decision: 'approved', note: 'Reviewed in builder' }))}><Check size={14} /> Approve</Button>}{latest.status === 'approved' && <Button size="xs" variant="primary" onClick={() => run('deploy', () => api.post(`/api/builder/releases/${latest.id}/deploy`, {}))}><Rocket size={14} /> Deploy</Button>}</> : <p>No release requested.</p>}</div>
      </aside>
    </div>
  </div>
}

function DiffSummary({ diff }: { diff: Record<string, any> }) { const groups = ['pages', 'dataModels', 'actions', 'integrations', 'roles']; return <div className={styles.diff}>{groups.map(group => { const value = diff[group]; const count = (value?.added?.length || 0) + (value?.removed?.length || 0) + (value?.changed?.length || 0); return count ? <span key={group}>{group}: {count}</span> : null })}{diff.metadataChanged && <span>metadata changed</span>}{diff.deploymentChanged && <span>deployment changed</span>}</div> }

function Connections({ connections, busy, create, toggle }: { connections: Connection[]; busy: string; create: (input: unknown) => void; toggle: (item: Connection) => void }) {
  const [form, setForm] = useState({ name: '', provider: 'http', baseUrl: '', capabilities: 'GET /issues', key: 'header:authorization', secret: '' })
  return <div className={styles.connectionsGrid}><form className={styles.connectionForm} onSubmit={e => { e.preventDefault(); create({ name: form.name, provider: form.provider, capabilities: form.capabilities.split(',').map(v => v.trim()).filter(Boolean), credentials: { ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}), [form.key]: form.secret } }); setForm({ ...form, name: '', secret: '' }) }}><h2>New connection</h2><label>Name<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label><label>Provider<select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>{['http','github','slack','custom'].map(v => <option key={v}>{v}</option>)}</select></label>{['http','custom'].includes(form.provider) && <label>HTTPS base URL<input required type="url" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com" /></label>}<label>Approved operations<input required value={form.capabilities} onChange={e => setForm({ ...form, capabilities: e.target.value })} placeholder="GET /issues, POST /issues" /></label><div className={styles.secretRow}><label>Credential key<input required value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} /></label><label>Secret<input required type="password" autoComplete="new-password" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} /></label></div><Button variant="primary" loading={busy === 'connection'}><Plus size={15} /> Add connection</Button></form><section className={styles.connectionList}><h2>Managed connections</h2>{connections.map(item => <div className={styles.connectionItem} key={item.id}><div><strong>{item.name}</strong><code>{item.ref}</code><small>{item.provider} · {item.capabilities.join(', ')}</small></div><button className={`${styles.toggle} ${item.status === 'ready' ? styles.toggleOn : ''}`} onClick={() => toggle(item)} aria-label={`${item.status === 'ready' ? 'Disable' : 'Enable'} ${item.name}`}><span /></button></div>)}{!connections.length && <div className={styles.empty}>No managed connections.</div>}</section></div>
}

function Status({ value }: { value: string }) { return <span className={styles.status} data-value={value}>{value.replace(/_/g, ' ')}</span> }
function friendly(raw: string) { try { const parsed = JSON.parse(raw); return parsed.error || raw } catch { return raw } }
