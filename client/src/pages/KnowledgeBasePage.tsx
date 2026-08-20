// Knowledge Base — searchable article store.
//
// Layout:
//   • Search bar (full-text via /api/knowledge?q=…)
//   • Filter chips (status: all / published / draft / archived)
//   • Two-pane: list (left) + detail (right) with markdown render +
//     edit-in-place mode + upvote
//   • New article button (operator+)
//
// Markdown is rendered with a tiny custom transformer — no external
// deps so the client bundle stays lean. Supports headings, lists,
// bold/italic, code, blockquotes, links.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BookOpen, Plus, RefreshCw, X, Save, Search, ThumbsUp, Tag, Edit3, Trash2, Eye, FileText } from 'lucide-react'
import Layout from '../components/Layout'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import styles from './KnowledgeBasePage.module.css'

type Status = 'draft' | 'published' | 'archived'

interface Article {
  id: string
  title: string
  content: string
  tags: string[]
  linkedIncidents: string[]
  usefulCount: number
  createdBy: string | null
  status: Status
  createdAt: string
  updatedAt: string
  rank?: number
}

const STATUS_COLOR: Record<Status, string> = {
  draft: '#F59E0B',
  published: '#22C55E',
  archived: '#9CA3AF',
}
const STATUSES: Status[] = ['draft', 'published', 'archived']

export default function KnowledgeBasePage() {
  const { id: routeId } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const isOperator = isAdmin || user?.role === 'operator'

  const [articles, setArticles] = useState<Article[]>([])
  const [stats, setStats] = useState<{ total: number; byStatus: Record<string, number>; topUseful: number } | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(routeId ?? null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('q', search.trim())
      const data = await api.get<{ articles: Article[]; stats: any }>(`/api/knowledge?${params.toString()}`)
      setArticles(Array.isArray(data?.articles) ? data.articles : [])
      setStats(data?.stats ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load articles')
      setArticles([])
    } finally { setLoading(false) }
  }, [statusFilter, search])

  // Debounce search a touch so every keystroke doesn't hammer the API.
  useEffect(() => {
    const t = setTimeout(refresh, 200)
    return () => clearTimeout(t)
  }, [refresh])
  useEffect(() => { if (routeId && routeId !== selectedId) setSelectedId(routeId) }, [routeId, selectedId])

  const selected = useMemo(() => articles.find(a => a.id === selectedId) ?? null, [articles, selectedId])

  return (
    <Layout title="Knowledge Base" subtitle="Operator-curated answers + AI-grounding context. Highly-upvoted articles short-circuit the LLM.">
      {error && <div className={styles.error}>{error}</div>}
      {stats && (
        <div className={styles.statRow}>
          <StatTile label="Articles" value={stats.total} color="var(--accent)" />
          {STATUSES.map(s => <StatTile key={s} label={s} value={stats.byStatus?.[s] ?? 0} color={STATUS_COLOR[s]} />)}
          <StatTile label="Top useful" value={stats.topUseful} color="var(--warm)" />
        </div>
      )}

      <div className={styles.shell}>
        <div className={styles.listPane}>
          <div className={styles.filterRow}>
            <div className={styles.searchBox}>
              <Search size={14} />
              <input type="text" placeholder="Search title or content…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <button type="button" className={styles.iconBtn} onClick={refresh} title="Refresh"><RefreshCw size={14} /></button>
            {isOperator && <button type="button" className={styles.primaryBtn} onClick={() => setCreating(true)}><Plus size={14} /> New</button>}
          </div>

          <div className={styles.chipRow}>
            <button type="button" className={`${styles.chip} ${statusFilter === 'all' ? styles.chipActive : ''}`} onClick={() => setStatusFilter('all')}>All</button>
            {STATUSES.map(s => (
              <button
                key={s}
                type="button"
                className={`${styles.chip} ${statusFilter === s ? styles.chipActive : ''}`}
                style={statusFilter === s ? { borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] } : undefined}
                onClick={() => setStatusFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>

          {loading && <div className={styles.empty}>Loading…</div>}
          {!loading && articles.length === 0 && <div className={styles.empty}>No articles match.</div>}
          {!loading && articles.length > 0 && (
            <ul className={styles.articleList}>
              {articles.map(a => (
                <li
                  key={a.id}
                  className={`${styles.item} ${selectedId === a.id ? styles.itemActive : ''}`}
                  onClick={() => { setSelectedId(a.id); navigate(`/knowledge-base/${a.id}`) }}
                >
                  <span className={styles.itemStatus} style={{ background: STATUS_COLOR[a.status] }} title={a.status} />
                  <span className={styles.itemMain}>
                    <span className={styles.itemTitle}>{a.title}</span>
                    <span className={styles.itemMeta}>
                      <code>{a.id}</code>
                      {a.usefulCount > 0 && <> · <ThumbsUp size={10} /> {a.usefulCount}</>}
                      {a.tags.length > 0 && <> · {a.tags.slice(0, 2).map(t => `#${t}`).join(' ')}</>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.detailPane}>
          {!selected && <div className={styles.empty}>Pick an article on the left, or create a new one.</div>}
          {selected && (
            <ArticleDetail
              article={selected}
              isAdmin={isAdmin}
              isOperator={isOperator}
              onChanged={refresh}
            />
          )}
        </div>
      </div>

      {creating && (
        <CreateArticleModal
          onClose={() => setCreating(false)}
          onCreated={(a) => { setCreating(false); refresh(); setSelectedId(a.id); navigate(`/knowledge-base/${a.id}`) }}
        />
      )}
    </Layout>
  )
}

function StatTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={styles.stat} style={{ borderLeftColor: color }}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  )
}

function ArticleDetail({ article, isAdmin, isOperator, onChanged }: { article: Article; isAdmin: boolean; isOperator: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(article.title)
  const [content, setContent] = useState(article.content)
  const [tags, setTags] = useState<string>(article.tags.join(', '))
  const [status, setStatus] = useState<Status>(article.status)
  const [saving, setSaving] = useState(false)

  // Reset editor state when switching articles.
  useEffect(() => {
    setEditing(false)
    setTitle(article.title)
    setContent(article.content)
    setTags(article.tags.join(', '))
    setStatus(article.status)
  }, [article.id])

  const save = async () => {
    setSaving(true)
    try {
      await api.put(`/api/knowledge/${article.id}`, {
        title: title.trim(),
        content,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        status,
      })
      setEditing(false)
      onChanged()
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally { setSaving(false) }
  }
  const upvote = async () => {
    try { await api.post(`/api/knowledge/${article.id}/useful`); onChanged() }
    catch (e) { alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`) }
  }
  const publish = async () => {
    try { await api.post(`/api/knowledge/${article.id}/publish`); onChanged() }
    catch (e) { alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`) }
  }
  const remove = async () => {
    if (!confirm(`Delete ${article.id}?`)) return
    try { await api.delete(`/api/knowledge/${article.id}`); onChanged() }
    catch (e) { alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`) }
  }

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <span className={styles.detailIcon} style={{ background: STATUS_COLOR[article.status] + '22', color: STATUS_COLOR[article.status] }}>
          <FileText size={20} />
        </span>
        <div className={styles.detailHeadText}>
          {!editing ? (
            <h2 className={styles.detailTitle}>{article.title}</h2>
          ) : (
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} className={styles.titleInput} maxLength={200} />
          )}
          <div className={styles.detailMeta}>
            <code>{article.id}</code>
            <span style={{ color: STATUS_COLOR[article.status] }}>{article.status}</span>
            <span><ThumbsUp size={11} /> {article.usefulCount}</span>
            {article.createdBy && <span>by <strong>{article.createdBy}</strong></span>}
          </div>
        </div>
        <div className={styles.actionBar}>
          {!editing && (
            <>
              <button type="button" className={styles.smallBtn} onClick={upvote} title="Mark useful">
                <ThumbsUp size={12} /> Useful
              </button>
              {isOperator && (
                <>
                  {article.status === 'draft' && (
                    <button type="button" className={styles.smallBtn} onClick={publish} title="Publish">
                      <Eye size={12} /> Publish
                    </button>
                  )}
                  <button type="button" className={styles.smallBtn} onClick={() => setEditing(true)}>
                    <Edit3 size={12} /> Edit
                  </button>
                  {isAdmin && (
                    <button type="button" className={styles.dangerBtn} onClick={remove}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </>
              )}
            </>
          )}
          {editing && (
            <>
              <button type="button" className={styles.smallBtn} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
              <button type="button" className={styles.primaryBtn} onClick={save} disabled={saving}>
                <Save size={12} /> {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {!editing && article.tags.length > 0 && (
        <div className={styles.tagRow}>
          {article.tags.map(t => <span key={t} className={styles.tag}><Tag size={10} /> {t}</span>)}
        </div>
      )}

      {!editing && (
        <article className={styles.markdown}>
          <MarkdownView text={article.content} />
        </article>
      )}

      {editing && (
        <div className={styles.editForm}>
          <label className={styles.field}><span>Status</span>
            <select value={status} onChange={e => setStatus(e.target.value as Status)} disabled={saving}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className={styles.field}><span>Tags (comma-separated)</span>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)} disabled={saving} />
          </label>
          <label className={styles.field}><span>Content (Markdown)</span>
            <textarea value={content} onChange={e => setContent(e.target.value)} rows={20} disabled={saving} className={styles.editor} />
          </label>
        </div>
      )}

      {article.linkedIncidents.length > 0 && (
        <div className={styles.linkedSection}>
          <h4>Linked incidents</h4>
          <ul>
            {article.linkedIncidents.map(id => (
              <li key={id}>
                <a href={`/app/incidents/${id}`} className={styles.link}>{id}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── Minimal Markdown renderer ──────────────────────────────────────
// Handles: # heading, ## heading, ### heading, **bold**, *italic*,
// `code`, > blockquote, - list, [text](url), `` ```fence``` blocks.
// Enough for the auto-drafted articles + operator-typed ones; users
// can paste in long-form docs without losing structure.

function MarkdownView({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let listBuf: string[] = []
  let codeBuf: string[] = []
  let inCode = false

  const flushList = () => {
    if (listBuf.length > 0) {
      blocks.push(
        <ul key={`list-${blocks.length}`} className={styles.mdList}>
          {listBuf.map((l, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inlineMd(l) }} />)}
        </ul>,
      )
      listBuf = []
    }
  }
  const flushCode = () => {
    if (codeBuf.length > 0) {
      blocks.push(<pre key={`pre-${blocks.length}`} className={styles.mdPre}><code>{codeBuf.join('\n')}</code></pre>)
      codeBuf = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (inCode) { flushCode(); inCode = false }
      else { flushList(); inCode = true }
      i++; continue
    }
    if (inCode) { codeBuf.push(line); i++; continue }
    if (line.match(/^\s*[-*]\s+/)) {
      listBuf.push(line.replace(/^\s*[-*]\s+/, ''))
      i++; continue
    } else { flushList() }
    if (line.startsWith('### ')) { blocks.push(<h3 key={i} dangerouslySetInnerHTML={{ __html: inlineMd(line.slice(4)) }} />); i++; continue }
    if (line.startsWith('## '))  { blocks.push(<h2 key={i} dangerouslySetInnerHTML={{ __html: inlineMd(line.slice(3)) }} />); i++; continue }
    if (line.startsWith('# '))   { blocks.push(<h1 key={i} dangerouslySetInnerHTML={{ __html: inlineMd(line.slice(2)) }} />); i++; continue }
    if (line.startsWith('> '))   { blocks.push(<blockquote key={i} dangerouslySetInnerHTML={{ __html: inlineMd(line.slice(2)) }} />); i++; continue }
    if (line.trim() === '')      { blocks.push(<br key={`br-${i}`} />); i++; continue }
    blocks.push(<p key={i} dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />)
    i++
  }
  flushList(); flushCode()
  return <>{blocks}</>
}

function inlineMd(s: string): string {
  // Escape first so user input can't inject HTML.
  let out = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  out = out.replace(/(INC-[A-F0-9]+)/g, '<a href="/app/incidents/$1">$1</a>')
  return out
}

// ── Create modal ───────────────────────────────────────────────────

function CreateArticleModal({ onClose, onCreated }: { onClose: () => void; onCreated: (a: Article) => void }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [status, setStatus] = useState<Status>('draft')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) { setErr('title required'); return }
    if (!content.trim()) { setErr('content required'); return }
    setSubmitting(true); setErr(null)
    try {
      const { article } = await api.post<{ article: Article }>('/api/knowledge', {
        title: title.trim(),
        content,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        status,
      })
      onCreated(article)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'create failed')
    } finally { setSubmitting(false) }
  }

  return (
    <div className={styles.modalBg} onClick={onClose}>
      <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className={styles.modalHead}>
          <h3>New article</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </header>
        <label className={styles.field}><span>Title</span>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} disabled={submitting} required />
        </label>
        <label className={styles.field}><span>Content (Markdown)</span>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={14} disabled={submitting} className={styles.editor} required placeholder="## Problem&#10;&#10;Describe the symptom…&#10;&#10;## Resolution&#10;&#10;Step-by-step fix…" />
        </label>
        <div className={styles.row2}>
          <label className={styles.field}><span>Status</span>
            <select value={status} onChange={e => setStatus(e.target.value as Status)} disabled={submitting}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className={styles.field}><span>Tags (comma-separated)</span>
            <input type="text" value={tags} onChange={e => setTags(e.target.value)} disabled={submitting} placeholder="postgres, restart, faq" />
          </label>
        </div>
        {err && <div className={styles.error}>{err}</div>}
        <div className={styles.modalFoot}>
          <button type="button" onClick={onClose} className={styles.smallBtn}>Cancel</button>
          <button type="submit" disabled={submitting || !title.trim() || !content.trim()} className={styles.primaryBtn}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
