// CMDB / Asset inventory.
//
// Two-pane layout:
//   • Left: filterable asset list (type tabs + search + tag chip)
//   • Right: selected asset detail — metadata, relationships
//     (incoming + outgoing), impact tree (downstream BFS), and a
//     button to flip the impact view to upstream
//
// Tree view is a recursive indented list rather than react-flow — keeps
// the bundle small while still conveying the dependency graph clearly.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Server as ServerIcon, Layers, Box, Network, Database as DbIcon, Tag,
  ChevronRight, ChevronDown, Search, Plus, RefreshCw, ArrowUpFromLine, ArrowDownToLine, Trash2, Save, X,
} from 'lucide-react'
import Layout from '../components/Layout'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import styles from './AssetsPage.module.css'

type AssetType = 'server' | 'service' | 'application' | 'network' | 'database' | 'other'
type RelationshipType = 'hosts' | 'runs' | 'depends_on' | 'connects_to'

interface Asset {
  id: string
  type: AssetType
  name: string
  description: string | null
  metadata: Record<string, unknown>
  serverId: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

interface AssetWithRel extends Asset {
  relationships: {
    downstream: Array<{ id: string; childId: string; type: RelationshipType }>
    upstream:   Array<{ id: string; parentId: string; type: RelationshipType }>
  }
}

interface ImpactNode {
  asset: Asset
  depth: number
  reachedVia: RelationshipType | null
  parentId: string | null
}
interface ImpactReport {
  rootId: string
  direction: 'downstream' | 'upstream'
  maxDepth: number
  nodes: ImpactNode[]
  edges: Array<{ parentId: string; childId: string; type: RelationshipType }>
  truncated: boolean
}

// lucide-react icons accept extra props (color, strokeWidth, etc.);
// `React.ElementType` keeps callers free to forward whatever they need
// without TS narrowing complaints when the component type is widened.
const TYPE_ICON: Record<AssetType, React.ElementType> = {
  server: ServerIcon,
  service: Layers,
  application: Box,
  network: Network,
  database: DbIcon,
  other: Tag,
}
const TYPE_COLOR: Record<AssetType, string> = {
  server: '#306EF0',
  service: '#22C55E',
  application: '#E8734A',
  network: '#06B6D4',
  database: '#9333EA',
  other: '#6B7280',
}

const TYPES: AssetType[] = ['server', 'service', 'application', 'network', 'database', 'other']

export default function AssetsPage() {
  const { id: routeId } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const isOperator = isAdmin || user?.role === 'operator'

  const [assets, setAssets] = useState<Asset[]>([])
  const [stats, setStats] = useState<{ total: number; byType: Record<string, number>; relationships: number } | null>(null)
  const [filterType, setFilterType] = useState<AssetType | 'all'>('all')
  const [filterTag, setFilterTag] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(routeId ?? null)
  const [selectedAsset, setSelectedAsset] = useState<AssetWithRel | null>(null)
  const [impact, setImpact] = useState<ImpactReport | null>(null)
  const [impactDirection, setImpactDirection] = useState<'downstream' | 'upstream'>('downstream')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // ── Fetch list ──
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (filterType !== 'all') params.set('type', filterType)
      if (filterTag) params.set('tag', filterTag)
      if (search.trim()) params.set('q', search.trim())
      const data = await api.get<{ assets: Asset[]; stats: any }>(`/api/assets?${params.toString()}`)
      setAssets(Array.isArray(data?.assets) ? data.assets : [])
      setStats(data?.stats ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load assets')
      setAssets([])
    } finally {
      setLoading(false)
    }
  }, [filterType, filterTag, search])

  useEffect(() => { refresh() }, [refresh])

  // ── Fetch selection ──
  useEffect(() => {
    if (!selectedId) { setSelectedAsset(null); setImpact(null); return }
    let cancelled = false
    api.get<{ asset: AssetWithRel }>(`/api/assets/${selectedId}`)
      .then(d => { if (!cancelled) setSelectedAsset(d?.asset ?? null) })
      .catch(() => { if (!cancelled) setSelectedAsset(null) })
    api.get<ImpactReport>(`/api/assets/${selectedId}/impact?direction=${impactDirection}&maxDepth=5`)
      .then(d => { if (!cancelled) setImpact(d ?? null) })
      .catch(() => { if (!cancelled) setImpact(null) })
    return () => { cancelled = true }
  }, [selectedId, impactDirection])

  useEffect(() => {
    if (routeId && routeId !== selectedId) setSelectedId(routeId)
  }, [routeId, selectedId])

  const onPick = (a: Asset) => {
    setSelectedId(a.id)
    navigate(`/assets/${a.id}`, { replace: false })
  }

  const filteredCount = assets.length

  return (
    <Layout title="Assets" subtitle="CMDB — every monitored server, service, app, and network device, plus the relationships between them.">
      {error && <div className={styles.error}>{error}</div>}
      {stats && (
        <div className={styles.statRow}>
          <StatTile label="Total assets" value={stats.total} color="var(--accent)" />
          {TYPES.map(t => (
            <StatTile key={t} label={t} value={stats.byType?.[t] ?? 0} color={TYPE_COLOR[t]} icon={TYPE_ICON[t]} />
          ))}
          <StatTile label="Relationships" value={stats.relationships} color="var(--warm)" />
        </div>
      )}

      <div className={styles.shell}>
        {/* ── Left: list ── */}
        <div className={styles.listPane}>
          <div className={styles.filterRow}>
            <div className={styles.searchBox}>
              <Search size={14} />
              <input
                type="text"
                placeholder="Search name or description…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <button type="button" className={styles.iconBtn} onClick={refresh} title="Refresh">
              <RefreshCw size={14} />
            </button>
            {isOperator && (
              <button type="button" className={styles.primaryBtn} onClick={() => setCreating(true)}>
                <Plus size={14} /> New
              </button>
            )}
          </div>

          <div className={styles.typeTabs}>
            <button
              type="button"
              className={`${styles.typeTab} ${filterType === 'all' ? styles.typeTabActive : ''}`}
              onClick={() => setFilterType('all')}
            >
              All ({assets.length})
            </button>
            {TYPES.map(t => {
              const Icon = TYPE_ICON[t]
              return (
                <button
                  key={t}
                  type="button"
                  className={`${styles.typeTab} ${filterType === t ? styles.typeTabActive : ''}`}
                  style={filterType === t ? { borderColor: TYPE_COLOR[t], color: TYPE_COLOR[t] } : undefined}
                  onClick={() => setFilterType(t)}
                >
                  <Icon size={12} /> {t}
                </button>
              )
            })}
          </div>

          {filterTag && (
            <div className={styles.activeTagRow}>
              <span>Filter: <strong>#{filterTag}</strong></span>
              <button type="button" className={styles.iconBtn} onClick={() => setFilterTag('')} aria-label="Clear tag filter">
                <X size={12} />
              </button>
            </div>
          )}

          {loading && <div className={styles.empty}>Loading…</div>}
          {!loading && filteredCount === 0 && <div className={styles.empty}>No assets match.</div>}
          {!loading && filteredCount > 0 && (
            <ul className={styles.assetList}>
              {assets.map(a => {
                const Icon = TYPE_ICON[a.type]
                return (
                  <li
                    key={a.id}
                    className={`${styles.assetItem} ${selectedId === a.id ? styles.assetItemActive : ''}`}
                    onClick={() => onPick(a)}
                  >
                    <span className={styles.assetIcon} style={{ color: TYPE_COLOR[a.type] }}>
                      <Icon size={14} />
                    </span>
                    <span className={styles.assetMain}>
                      <span className={styles.assetName}>{a.name}</span>
                      <span className={styles.assetId}>{a.id}</span>
                    </span>
                    {a.tags.length > 0 && (
                      <span className={styles.assetTags}>
                        {a.tags.slice(0, 2).map(t => (
                          <button
                            key={t}
                            type="button"
                            className={styles.tagPill}
                            onClick={(e) => { e.stopPropagation(); setFilterTag(t) }}
                          >#{t}</button>
                        ))}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* ── Right: detail ── */}
        <div className={styles.detailPane}>
          {!selectedAsset && <div className={styles.empty}>Pick an asset on the left to see relationships + impact.</div>}
          {selectedAsset && (
            <AssetDetail
              asset={selectedAsset}
              impact={impact}
              impactDirection={impactDirection}
              setImpactDirection={setImpactDirection}
              isOperator={isOperator}
              isAdmin={isAdmin}
              onChanged={refresh}
              onNavigate={(id) => { setSelectedId(id); navigate(`/assets/${id}`) }}
            />
          )}
        </div>
      </div>

      {creating && (
        <CreateAssetModal
          onClose={() => setCreating(false)}
          onCreated={(a) => { setCreating(false); refresh(); setSelectedId(a.id); navigate(`/assets/${a.id}`) }}
        />
      )}
    </Layout>
  )
}

// ── Stat tile ───────────────────────────────────────────────────────

function StatTile({ label, value, color, icon: Icon }: { label: string; value: number; color: string; icon?: React.ElementType }) {
  return (
    <div className={styles.stat} style={{ borderLeftColor: color }}>
      <span className={styles.statLabel}>
        {Icon && <Icon size={11} />} {label}
      </span>
      <span className={styles.statValue}>{value}</span>
    </div>
  )
}

// ── Detail ──────────────────────────────────────────────────────────

function AssetDetail({ asset, impact, impactDirection, setImpactDirection, isOperator, isAdmin, onChanged, onNavigate }: {
  asset: AssetWithRel
  impact: ImpactReport | null
  impactDirection: 'downstream' | 'upstream'
  setImpactDirection: (d: 'downstream' | 'upstream') => void
  isOperator: boolean
  isAdmin: boolean
  onChanged: () => void
  onNavigate: (id: string) => void
}) {
  const Icon = TYPE_ICON[asset.type]
  const color = TYPE_COLOR[asset.type]

  const remove = async () => {
    if (!confirm(`Delete ${asset.id} (${asset.name})? Relationships will cascade.`)) return
    try {
      await api.delete(`/api/assets/${asset.id}`)
      onChanged()
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <span className={styles.detailIcon} style={{ background: color + '22', color }}>
          <Icon size={20} />
        </span>
        <div className={styles.detailHeadText}>
          <h2 className={styles.detailName}>{asset.name}</h2>
          <div className={styles.detailMeta}>
            <span className={styles.assetIdMono}>{asset.id}</span>
            <span className={styles.detailType} style={{ color }}>{asset.type}</span>
            {asset.serverId && <span className={styles.serverLink}>↪ server: <code>{asset.serverId}</code></span>}
          </div>
        </div>
        {isAdmin && (
          <button type="button" className={styles.dangerBtn} onClick={remove} title="Delete asset">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {asset.description && <p className={styles.desc}>{asset.description}</p>}

      {asset.tags.length > 0 && (
        <div className={styles.tagRow}>
          {asset.tags.map(t => <span key={t} className={styles.tag}>#{t}</span>)}
        </div>
      )}

      {Object.keys(asset.metadata || {}).length > 0 && (
        <details className={styles.section}>
          <summary>Metadata</summary>
          <table className={styles.kvTable}>
            <tbody>
              {Object.entries(asset.metadata).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td><code>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <details className={styles.section} open>
        <summary>
          Relationships ({asset.relationships.downstream.length} out, {asset.relationships.upstream.length} in)
        </summary>
        <RelationshipsBlock
          asset={asset}
          isOperator={isOperator}
          onChanged={onChanged}
          onNavigate={onNavigate}
        />
      </details>

      <details className={styles.section} open>
        <summary>Impact tree</summary>
        <div className={styles.impactControls}>
          <div className={styles.impactToggle}>
            <button
              type="button"
              className={`${styles.toggleBtn} ${impactDirection === 'downstream' ? styles.toggleBtnActive : ''}`}
              onClick={() => setImpactDirection('downstream')}
            >
              <ArrowDownToLine size={12} /> Downstream
            </button>
            <button
              type="button"
              className={`${styles.toggleBtn} ${impactDirection === 'upstream' ? styles.toggleBtnActive : ''}`}
              onClick={() => setImpactDirection('upstream')}
            >
              <ArrowUpFromLine size={12} /> Upstream
            </button>
          </div>
          {impact?.truncated && <span className={styles.truncWarn}>↳ depth-limited at {impact.maxDepth} — more nodes exist beyond</span>}
        </div>
        {impact && <ImpactTree report={impact} onNavigate={onNavigate} />}
      </details>
    </div>
  )
}

// ── Relationships block (with add form for operators) ───────────────

function RelationshipsBlock({ asset, isOperator, onChanged, onNavigate }: {
  asset: AssetWithRel
  isOperator: boolean
  onChanged: () => void
  onNavigate: (id: string) => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [otherId, setOtherId] = useState('')
  const [type, setType] = useState<RelationshipType>('depends_on')
  const [direction, setDirection] = useState<'out' | 'in'>('out')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!otherId.trim()) { setErr('child id required'); return }
    setSubmitting(true); setErr(null)
    try {
      const body = direction === 'out'
        ? { parentId: asset.id, childId: otherId.trim(), type }
        : { parentId: otherId.trim(), childId: asset.id, type }
      await api.post('/api/assets/relationships', body)
      setOtherId('')
      setShowForm(false)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (relId: string) => {
    if (!confirm('Remove this relationship?')) return
    try {
      await api.delete(`/api/assets/relationships/${relId}`)
      onChanged()
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }

  return (
    <div className={styles.relBlock}>
      {asset.relationships.downstream.length === 0 && asset.relationships.upstream.length === 0 && (
        <p className={styles.dimText}>No relationships yet — use Add to wire this asset to others.</p>
      )}
      {asset.relationships.downstream.length > 0 && (
        <div>
          <h5 className={styles.relSubHead}>Outgoing</h5>
          <ul className={styles.relList}>
            {asset.relationships.downstream.map(r => (
              <li key={r.id}>
                <span>{asset.id} —<code>{r.type}</code>→ <a onClick={(e) => { e.preventDefault(); onNavigate(r.childId) }} href={`#/assets/${r.childId}`}>{r.childId}</a></span>
                {isOperator && (
                  <button type="button" className={styles.iconBtn} onClick={() => remove(r.id)} title="Remove">
                    <X size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {asset.relationships.upstream.length > 0 && (
        <div>
          <h5 className={styles.relSubHead}>Incoming</h5>
          <ul className={styles.relList}>
            {asset.relationships.upstream.map(r => (
              <li key={r.id}>
                <span><a onClick={(e) => { e.preventDefault(); onNavigate(r.parentId) }} href={`#/assets/${r.parentId}`}>{r.parentId}</a> —<code>{r.type}</code>→ {asset.id}</span>
                {isOperator && (
                  <button type="button" className={styles.iconBtn} onClick={() => remove(r.id)} title="Remove">
                    <X size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {isOperator && (
        <>
          {!showForm && (
            <button type="button" className={styles.smallBtn} onClick={() => setShowForm(true)}>
              <Plus size={12} /> Add relationship
            </button>
          )}
          {showForm && (
            <form className={styles.relForm} onSubmit={submit}>
              <select value={direction} onChange={e => setDirection(e.target.value as 'out' | 'in')} disabled={submitting}>
                <option value="out">this → other</option>
                <option value="in">other → this</option>
              </select>
              <select value={type} onChange={e => setType(e.target.value as RelationshipType)} disabled={submitting}>
                <option value="hosts">hosts</option>
                <option value="runs">runs</option>
                <option value="depends_on">depends_on</option>
                <option value="connects_to">connects_to</option>
              </select>
              <input
                type="text"
                placeholder="other asset id (AST-…)"
                value={otherId}
                onChange={e => setOtherId(e.target.value)}
                disabled={submitting}
              />
              <button type="submit" disabled={submitting || !otherId.trim()} className={styles.smallBtn}>
                <Save size={12} /> Add
              </button>
              <button type="button" onClick={() => setShowForm(false)} className={styles.iconBtn}>
                <X size={12} />
              </button>
              {err && <span className={styles.errorText}>{err}</span>}
            </form>
          )}
        </>
      )}
    </div>
  )
}

// ── Impact tree (indented recursive view) ───────────────────────────

function ImpactTree({ report, onNavigate }: { report: ImpactReport; onNavigate: (id: string) => void }) {
  // Build a parentId → children[] map from the BFS nodes.
  const byParent = useMemo(() => {
    const m = new Map<string, ImpactNode[]>()
    for (const n of report.nodes) {
      if (!n.parentId) continue
      const list = m.get(n.parentId) ?? []
      list.push(n)
      m.set(n.parentId, list)
    }
    return m
  }, [report])
  const root = report.nodes.find(n => n.depth === 0)
  if (!root) return <p className={styles.dimText}>No impact reachable.</p>
  if (report.nodes.length === 1) return <p className={styles.dimText}>No connected assets.</p>
  return (
    <ul className={styles.tree}>
      <ImpactRow node={root} byParent={byParent} onNavigate={onNavigate} isRoot />
    </ul>
  )
}

function ImpactRow({ node, byParent, onNavigate, isRoot }: {
  node: ImpactNode
  byParent: Map<string, ImpactNode[]>
  onNavigate: (id: string) => void
  isRoot?: boolean
}) {
  const children = byParent.get(node.asset.id) ?? []
  const [open, setOpen] = useState(true)
  const Icon = TYPE_ICON[node.asset.type]
  return (
    <li>
      <div className={styles.treeRow}>
        {children.length > 0 ? (
          <button type="button" className={styles.iconBtn} onClick={() => setOpen(o => !o)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : <span className={styles.treeSpacer} />}
        <span style={{ color: TYPE_COLOR[node.asset.type] }}><Icon size={12} /></span>
        <a className={styles.treeLink} onClick={(e) => { e.preventDefault(); if (!isRoot) onNavigate(node.asset.id) }} href={`#/assets/${node.asset.id}`}>
          {node.asset.name}
        </a>
        <span className={styles.treeMeta}>{node.asset.id}</span>
        {node.reachedVia && <span className={styles.treeEdge}>via <code>{node.reachedVia}</code></span>}
        {isRoot && <span className={styles.rootBadge}>root</span>}
      </div>
      {open && children.length > 0 && (
        <ul className={styles.tree}>
          {children.map(c => <ImpactRow key={c.asset.id} node={c} byParent={byParent} onNavigate={onNavigate} />)}
        </ul>
      )}
    </li>
  )
}

// ── Create modal ────────────────────────────────────────────────────

function CreateAssetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (a: Asset) => void }) {
  const [type, setType] = useState<AssetType>('service')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setErr('name required'); return }
    setSubmitting(true); setErr(null)
    try {
      const { asset } = await api.post<{ asset: Asset }>('/api/assets', {
        type, name: name.trim(), description: description.trim() || null,
        tags: tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
      })
      onCreated(asset)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'create failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.modalBg} onClick={onClose}>
      <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className={styles.modalHead}>
          <h3>New asset</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </header>
        <label className={styles.field}>
          <span>Type</span>
          <select value={type} onChange={e => setType(e.target.value as AssetType)} disabled={submitting}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Name</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)} maxLength={120} disabled={submitting} required />
        </label>
        <label className={styles.field}>
          <span>Description</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} maxLength={2000} disabled={submitting} />
        </label>
        <label className={styles.field}>
          <span>Tags (comma-separated)</span>
          <input type="text" value={tagsRaw} onChange={e => setTagsRaw(e.target.value)} placeholder="prod, db, critical" disabled={submitting} />
        </label>
        {err && <div className={styles.error}>{err}</div>}
        <div className={styles.modalFoot}>
          <button type="button" onClick={onClose} className={styles.smallBtn}>Cancel</button>
          <button type="submit" disabled={submitting || !name.trim()} className={styles.primaryBtn}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
