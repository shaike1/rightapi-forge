import { useState, useEffect, useRef, useCallback } from 'react'
import Layout from '../components/Layout'
import { Card, CardBody } from '../components/Card'
import StatCard from '../components/StatCard'
import { api } from '../lib/api'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './AgentChatPage.module.css'

interface Agent {
  id: string
  name: string
  type: string
  status: 'idle' | 'busy' | 'error' | 'offline'
}

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  agentId: string
  content: string
  timestamp: string
}

interface SystemContext {
  incidents: { open: number; critical: number; high: number }
  agents: { total: number; active: number; idle: number }
  tasks: { pending: number; active: number; completed_today: number }
  alerts: { active: number; suppressed: number }
  servers: { total: number; healthy: number; degraded: number }
  generatedAt: string
}

// ── System Context Bar ────────────────────────────────────────────────────────

function SystemContextBar() {
  const [ctx, setCtx] = useState<SystemContext | null>(null)
  const [expanded, setExpanded] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchCtx = useCallback(() => {
    api.get<SystemContext>('/api/system/context')
      .then(data => setCtx(data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchCtx()
    timerRef.current = setInterval(fetchCtx, 30_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [fetchCtx])

  if (!ctx) return null

  const inc = ctx.incidents ?? { critical: 0, high: 0, open: 0 }
  const ag  = ctx.agents    ?? { active: 0, idle: 0, total: 0 }
  const tk  = ctx.tasks     ?? { pending: 0, active: 0, completed_today: 0 }
  const al  = ctx.alerts    ?? { active: 0, suppressed: 0 }
  const sv  = ctx.servers   ?? { healthy: 0, degraded: 0, total: 0 }

  return (
    <div className={styles.contextBar}>
      <div className={styles.contextBarRow} onClick={() => setExpanded(e => !e)}>
        <span className={styles.contextBarItems}>
          <span className={styles.ctxChip}>
            <span className={styles.ctxDotRed} />
            {inc.critical} incidents
          </span>
          <span className={styles.ctxChip}>
            🤖 {ag.active}/{ag.total} agents
          </span>
          <span className={styles.ctxChip}>
            📋 {tk.pending} pending
          </span>
          <span className={styles.ctxChip}>
            ✅ {sv.healthy}{sv.total > 0 ? `/${sv.total}` : ''} servers
          </span>
        </span>
        <button className={styles.ctxToggle}>{expanded ? '▲ Hide' : '▼ Details'}</button>
      </div>

      {expanded && (
        <div className={styles.contextBarDetails}>
          <div className={styles.ctxDetailRow}>
            <span className={styles.ctxDetailLabel}>Incidents</span>
            <span>{inc.open} open — {inc.critical} critical, {inc.high} high</span>
          </div>
          <div className={styles.ctxDetailRow}>
            <span className={styles.ctxDetailLabel}>Agents</span>
            <span>{ag.active} active, {ag.idle} idle of {ag.total} total</span>
          </div>
          <div className={styles.ctxDetailRow}>
            <span className={styles.ctxDetailLabel}>Tasks</span>
            <span>{tk.pending} pending, {tk.active} active, {tk.completed_today} completed today</span>
          </div>
          <div className={styles.ctxDetailRow}>
            <span className={styles.ctxDetailLabel}>Alerts</span>
            <span>{al.active} active, {al.suppressed} suppressed</span>
          </div>
          {sv.total > 0 && (
            <div className={styles.ctxDetailRow}>
              <span className={styles.ctxDetailLabel}>Servers</span>
              <span>{sv.healthy}/{sv.total} healthy, {sv.degraded} degraded</span>
            </div>
          )}
          <div className={styles.ctxDetailRow}>
            <span className={styles.ctxDetailLabel}>Updated</span>
            <span>{ctx.generatedAt ? new Date(ctx.generatedAt).toLocaleTimeString() : '—'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default function AgentChatPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [messagesByAgent, setMessagesByAgent] = useState<Record<string, ChatMessage[]>>({})
  const [inputText, setInputText] = useState('')
  const [streamingChunk, setStreamingChunk] = useState<string | null>(null)
  const [totalMessages, setTotalMessages] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { connected, lastEvent, send } = useWebSocket()

  const fetchAgents = useCallback(() => {
    api.get<any>('/api/agents')
      .then(data => {
        let list: Agent[]
        if (Array.isArray(data)) {
          list = data
        } else if (Array.isArray(data?.agents)) {
          list = data.agents
        } else if (data?.director || data?.sysadmins || data?.specialists) {
          const raw = [
            data.director,
            ...(Array.isArray(data.sysadmins) ? data.sysadmins : []),
            ...(Array.isArray(data.specialists) ? data.specialists : []),
          ].filter(Boolean)
          list = raw.map((a: any) => ({
            id: a.id,
            name: a.name,
            type: a.role ?? a.type ?? 'agent',
            status: a.status ?? 'idle',
          }))
        } else {
          list = []
        }
        setAgents(list)
      })
      .catch(() => {/* silently ignore */})
  }, [])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  // Load chat history when selectedAgent changes
  useEffect(() => {
    if (!selectedAgent) return
    api.get<{ messages: Array<{ id: string; role: 'user' | 'assistant'; agentId: string; text: string; timestamp: string }> }>(
      `/api/chat/history/${selectedAgent.id}`
    ).then(data => {
      const msgs: ChatMessage[] = (data.messages ?? []).map(m => ({
        id: m.id,
        role: m.role === 'assistant' ? 'agent' : 'user',
        agentId: m.agentId,
        content: m.text,
        timestamp: m.timestamp,
      }))
      setMessagesByAgent(prev => ({ ...prev, [selectedAgent.id]: msgs }))
    }).catch(() => {/* silently ignore */})
  }, [selectedAgent])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messagesByAgent, streamingChunk])

  useEffect(() => {
    if (!lastEvent) return
    const { type, data } = lastEvent as { type: string; data?: Record<string, unknown> }

    if (type === 'message_complete' && data) {
      const agentId = data.agentId as string
      const content = data.content as string
      const timestamp = (data.timestamp as string) ?? new Date().toISOString()
      setStreamingChunk(null)
      const msg: ChatMessage = {
        id: `${agentId}-${timestamp}-${Math.random()}`,
        role: 'agent',
        agentId,
        content,
        timestamp,
      }
      setMessagesByAgent(prev => ({
        ...prev,
        [agentId]: [...(prev[agentId] ?? []), msg],
      }))
      setTotalMessages(n => n + 1)
      // Persist assistant reply to history
      api.post(`/api/chat/history/${agentId}`, { role: 'assistant', text: content }).catch(() => {})
    } else if (type === 'message_chunk' && data) {
      const agentId = data.agentId as string
      if (selectedAgent?.id === agentId) {
        setStreamingChunk(prev => (prev ?? '') + (data.content as string))
      }
    } else if (type === 'chat_reply' && data) {
      const agentId = data.agentId as string
      const text = (data.text ?? data.content) as string
      const timestamp = (data.timestamp as string) ?? new Date().toISOString()
      const msg: ChatMessage = {
        id: `${agentId}-${timestamp}-${Math.random()}`,
        role: 'agent',
        agentId,
        content: text,
        timestamp,
      }
      setMessagesByAgent(prev => ({
        ...prev,
        [agentId]: [...(prev[agentId] ?? []), msg],
      }))
      setTotalMessages(n => n + 1)
    } else if (type === 'agent_bus_message' && data) {
      const busData = data as { agentId?: string; fromAgentId?: string; content?: string }
      const agentId = busData.agentId ?? busData.fromAgentId
      if (agentId && busData.content) {
        const timestamp = new Date().toISOString()
        const msg: ChatMessage = {
          id: `${agentId}-${timestamp}-${Math.random()}`,
          role: 'agent',
          agentId,
          content: busData.content,
          timestamp,
        }
        setMessagesByAgent(prev => ({
          ...prev,
          [agentId]: [...(prev[agentId] ?? []), msg],
        }))
        setTotalMessages(n => n + 1)
      }
    }
  }, [lastEvent, selectedAgent])

  const handleSend = () => {
    const text = inputText.trim()
    if (!text || !selectedAgent) return

    const timestamp = new Date().toISOString()
    const userMsg: ChatMessage = {
      id: `user-${timestamp}-${Math.random()}`,
      role: 'user',
      agentId: selectedAgent.id,
      content: text,
      timestamp,
    }
    setMessagesByAgent(prev => ({
      ...prev,
      [selectedAgent.id]: [...(prev[selectedAgent.id] ?? []), userMsg],
    }))
    setTotalMessages(n => n + 1)
    setStreamingChunk(null)
    setInputText('')
    send({ type: 'chat', agentId: selectedAgent.id, text })
    // Persist user message to history (server also saves via WS handler, this is belt-and-suspenders)
    api.post(`/api/chat/history/${selectedAgent.id}`, { role: 'user', text }).catch(() => {})
  }

  const handleClearHistory = () => {
    if (!selectedAgent) return
    api.delete(`/api/chat/history/${selectedAgent.id}`)
      .then(() => setMessagesByAgent(prev => ({ ...prev, [selectedAgent.id]: [] })))
      .catch(() => {})
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const connectedCount = agents.filter(a => a.status === 'idle' || a.status === 'busy').length
  const currentMessages = selectedAgent ? (messagesByAgent[selectedAgent.id] ?? []) : []

  return (
    <Layout title="Agent Chat" subtitle="Chat directly with AI agents">
      <SystemContextBar />
      <div className={styles.statsRow}>
        <StatCard label="Connected Agents" value={connectedCount} color={connected ? 'success' : 'neutral'} />
        <StatCard label="Messages Today" value={totalMessages} color="default" />
      </div>

      <Card>
        <CardBody>
          <div className={styles.chatLayout}>
            {/* Agent list panel */}
            <div className={styles.agentList}>
              {agents.map(agent => (
                <div
                  key={agent.id}
                  className={`${styles.agentItem} ${selectedAgent?.id === agent.id ? styles.agentItemActive : ''}`}
                  onClick={() => { setSelectedAgent(agent); setStreamingChunk(null) }}
                >
                  <span className={agent.status === 'offline' || agent.status === 'error' ? styles.offlineDot : styles.onlineDot} />
                  <div className={styles.agentInfo}>
                    <div className={styles.agentName}>{agent.name}</div>
                    <div className={styles.agentRole}>{agent.type}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Chat area */}
            <div className={styles.chatArea}>
              {!selectedAgent ? (
                <div className={styles.emptyChat}>Select an agent to start chatting</div>
              ) : (
                <>
                  <div className={styles.chatHeader}>
                    <span className={styles.chatHeaderTitle}>{selectedAgent.name}</span>
                    <button
                      className={styles.clearHistoryBtn}
                      onClick={handleClearHistory}
                      title="Clear chat history"
                    >
                      🗑 Clear History
                    </button>
                  </div>
                  <div className={styles.messages}>
                    {currentMessages.map(msg => (
                      <div key={msg.id} className={msg.role === 'user' ? styles.msgUser : styles.msgAgent}>
                        <div>{msg.content}</div>
                        <div className={styles.msgTime}>
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    ))}
                    {streamingChunk && (
                      <div className={styles.chunkIndicator}>{streamingChunk}▍</div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  <div className={styles.inputRow}>
                    <textarea
                      className={styles.chatInput}
                      rows={2}
                      placeholder={`Message ${selectedAgent.name}…`}
                      value={inputText}
                      onChange={e => setInputText(e.target.value)}
                      onKeyDown={handleKeyDown}
                    />
                    <button
                      className={styles.sendBtn}
                      onClick={handleSend}
                      disabled={!inputText.trim()}
                    >
                      Send
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </CardBody>
      </Card>
    </Layout>
  )
}

