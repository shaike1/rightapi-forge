import { useEffect, useState, useCallback } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import { toast } from '../hooks/useToast'
import styles from './MCPPage.module.css'

interface McpTool {
  name: string
  category: string
  description: string
}

interface McpData {
  tools: McpTool[]
  endpoint: string
}

const MCP_URL = `${window.location.origin}/mcp`

const CLAUDE_CONFIG = `{
  "mcpServers": {
    "itops-agents": {
      "url": "${MCP_URL}",
      "transport": "http"
    }
  }
}`

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }, [text])

  return (
    <button className={styles.copyBtn} onClick={handleCopy} aria-label={`Copy ${label}`}>
      {copied ? '✓ Copied' : label}
    </button>
  )
}

const CATEGORY_ORDER = ['Incidents', 'Agents', 'Skills', 'Runbooks']

function groupByCategory(tools: McpTool[]): Map<string, McpTool[]> {
  const map = new Map<string, McpTool[]>()
  for (const tool of tools) {
    const cat = tool.category || 'Other'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(tool)
  }
  // Re-order: known categories first, then any extras alphabetically
  const ordered = new Map<string, McpTool[]>()
  for (const cat of CATEGORY_ORDER) {
    if (map.has(cat)) ordered.set(cat, map.get(cat)!)
  }
  for (const [cat, tools] of map) {
    if (!ordered.has(cat)) ordered.set(cat, tools)
  }
  return ordered
}

export default function MCPPage() {
  const [data, setData] = useState<McpData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/mcp/tools')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<McpData>
      })
      .then(d => { setData(d); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [])

  const endpoint = data?.endpoint ?? '/mcp'
  const tools = Array.isArray(data?.tools) ? data!.tools : []
  const toolCount = tools.length
  const grouped = groupByCategory(tools)

  const copyEndpoint = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL)
      toast.success('Endpoint URL copied')
    } catch {
      toast.error('Failed to copy')
    }
  }, [])

  return (
    <Layout title="MCP Server" subtitle="Model Context Protocol — connect LLMs to IT ops">

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>MCP Endpoint</div>
          <button className={styles.endpointBtn} onClick={copyEndpoint} title="Click to copy full URL">
            <span className={styles.statMono}>{endpoint}</span>
            <span className={styles.clipIcon}>⎘</span>
          </button>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statLabel}>Tools Available</div>
          <div className={styles.statValue}>
            {loading ? '—' : toolCount}
          </div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statLabel}>Protocol</div>
          <div className={styles.statValue}>MCP 1.0 / HTTP</div>
        </div>
      </div>

      {/* ── Connection guide ───────────────────────────────────────────────── */}
      <Card className={styles.fullWidth}>
        <CardHeader title="Connection Guide" subtitle="How to connect this MCP server to your AI client" />
        <CardBody>
          <div className={styles.guideGrid}>

            <div className={styles.guideSection}>
              <h3 className={styles.guideTitle}>
                <span className={styles.guideBadge}>1</span>
                Claude Desktop
              </h3>
              <p className={styles.guideHint}>
                Add this block to your <code className={styles.inlineCode}>claude_desktop_config.json</code>:
              </p>
              <div className={styles.codeBlock}>
                <pre><code>{CLAUDE_CONFIG}</code></pre>
                <CopyButton text={CLAUDE_CONFIG} label="Copy config" />
              </div>
            </div>

            <div className={styles.guideSection}>
              <h3 className={styles.guideTitle}>
                <span className={styles.guideBadge}>2</span>
                Cursor / Windsurf / other MCP clients
              </h3>
              <p className={styles.guideHint}>
                Add this HTTP URL as an MCP server in your client settings:
              </p>
              <div className={styles.codeBlock}>
                <pre><code>{MCP_URL}</code></pre>
                <CopyButton text={MCP_URL} label="Copy URL" />
              </div>
            </div>

          </div>
        </CardBody>
      </Card>

      {/* ── Tools catalogue ────────────────────────────────────────────────── */}
      <Card className={styles.catalogueCard}>
        <CardHeader title="Tools Catalogue" subtitle="All available MCP tools grouped by category" />
        <CardBody>
          {loading && <div className={styles.loading}>Loading tools…</div>}
          {error && <div className={styles.errorMsg}>Failed to load tools: {error}</div>}
          {!loading && !error && grouped.size === 0 && (
            <div className={styles.empty}>No tools found.</div>
          )}
          {!loading && !error && Array.from(grouped.entries()).map(([category, tools]) => (
            <div key={category} className={styles.categorySection}>
              <div className={styles.categoryHeader}>
                <span className={styles.categoryName}>{category}</span>
                <span className={styles.categoryCount}>{tools.length}</span>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th} style={{ width: '30%' }}>Tool</th>
                    <th className={styles.th}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map(tool => (
                    <tr key={tool.name} className={styles.tr}>
                      <td className={styles.td}>
                        <span className={styles.toolName}>{tool.name}</span>
                      </td>
                      <td className={styles.td}>
                        <span className={styles.toolDesc}>{tool.description}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </CardBody>
      </Card>

    </Layout>
  )
}
