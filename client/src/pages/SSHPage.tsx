import { useState, useRef, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './SSHPage.module.css'

interface TermLine {
  id: number
  type: 'prompt' | 'stdout' | 'stderr' | 'info'
  text: string
  ts: string
}

const QUICK_COMMANDS = [
  { label: 'Disk space',       cmd: 'df -h' },
  { label: 'Memory usage',     cmd: 'free -m' },
  { label: 'Running processes',cmd: 'ps aux | head -20' },
  { label: 'Network interfaces', cmd: 'ip addr' },
  { label: 'Last 50 system logs', cmd: 'journalctl -n 50 --no-pager' },
]

let lineId = 0
function mkLine(type: TermLine['type'], text: string): TermLine {
  return { id: ++lineId, type, text, ts: new Date().toLocaleTimeString() }
}

type AuthMethod = 'password' | 'key'
type ConnStatus = 'untested' | 'connected' | 'failed'

export default function SSHPage() {
  const { show } = useToast()

  // Connection form
  const [host, setHost]         = useState('')
  const [port, setPort]         = useState('22')
  const [username, setUsername] = useState('root')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password')
  const [password, setPassword] = useState('')
  const [sshKey, setSshKey]     = useState('')
  const [testing, setTesting]   = useState(false)
  const [connStatus, setConnStatus] = useState<ConnStatus>('untested')

  // Command panel
  const [command, setCommand]   = useState('')
  const [running, setRunning]   = useState(false)
  const [lines, setLines]       = useState<TermLine[]>([
    mkLine('info', 'SSH Terminal ready. Configure a connection and click "Test Connection".'),
  ])

  const termRef = useRef<HTMLDivElement>(null)
  const cmdRef  = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll terminal on new output
  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [lines])

  function addLines(...newLines: TermLine[]) {
    setLines(prev => [...prev, ...newLines])
  }

  async function testConnection() {
    if (!host.trim()) { show('Host is required', 'error'); return }
    setTesting(true)
    setConnStatus('untested')
    try {
      const res = await api.post<{ result: string }>('/api/skills/execute', {
        command: 'ssh.connect',
        params: { host: host.trim(), user: username.trim() || 'root', port: Number(port) || 22 },
      })
      const ok = res.result.startsWith('OK:')
      setConnStatus(ok ? 'connected' : 'failed')
      addLines(mkLine(ok ? 'stdout' : 'stderr', res.result))
      if (!ok) show('Connection failed', 'error')
    } catch (err) {
      setConnStatus('failed')
      addLines(mkLine('stderr', (err as Error).message))
      show('Connection error', 'error')
    } finally {
      setTesting(false)
    }
  }

  const runCommand = useCallback(async () => {
    if (!command.trim()) return
    if (!host.trim()) { show('Configure a host first', 'error'); return }
    setRunning(true)
    const cmd = command.trim()
    addLines(mkLine('prompt', `${username}@${host} $ ${cmd}`))
    try {
      const params: Record<string, unknown> = {
        host: host.trim(),
        user: username.trim() || 'root',
        command: cmd,
        port: Number(port) || 22,
      }
      if (authMethod === 'key' && sshKey.trim()) {
        params.key = sshKey.trim()
      }
      const res = await api.post<{ result: string }>('/api/skills/execute', {
        command: 'ssh.exec',
        params,
      })
      const output = res.result ?? ''
      const isError = output.startsWith('Error:')
      addLines(mkLine(isError ? 'stderr' : 'stdout', output))
      if (isError) setConnStatus('failed')
    } catch (err) {
      addLines(mkLine('stderr', (err as Error).message))
    } finally {
      setRunning(false)
    }
  }, [command, host, port, username, authMethod, sshKey, show])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      runCommand()
    }
  }

  function clearTerminal() {
    setLines([mkLine('info', 'Terminal cleared.')])
  }

  const statusLabel: Record<ConnStatus, string> = {
    untested: 'Untested',
    connected: 'Connected',
    failed: 'Failed',
  }

  return (
    <Layout title="SSH Remote Execution" subtitle="Run commands on remote hosts via SSH">
      <div className={styles.container}>
        {/* ── LEFT: Connection Panel ── */}
        <div className={styles.leftCol}>
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span>Connection</span>
              <span className={`${styles.statusBadge} ${styles[connStatus]}`}>
                {connStatus === 'connected' ? '●' : connStatus === 'failed' ? '●' : '○'}&nbsp;
                {statusLabel[connStatus]}
              </span>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.field}>
                <label className={styles.label}>Host</label>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="192.168.1.100 or hostname"
                  value={host}
                  onChange={e => { setHost(e.target.value); setConnStatus('untested') }}
                />
              </div>
              <div className={styles.row2}>
                <div className={styles.field}>
                  <label className={styles.label}>Port</label>
                  <input
                    className={styles.input}
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={e => setPort(e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Username</label>
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="root"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Auth Method</label>
                <div className={styles.radioGroup}>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      value="password"
                      checked={authMethod === 'password'}
                      onChange={() => setAuthMethod('password')}
                    />
                    Password
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      value="key"
                      checked={authMethod === 'key'}
                      onChange={() => setAuthMethod('key')}
                    />
                    SSH Key
                  </label>
                </div>
              </div>

              {authMethod === 'password' && (
                <div className={styles.field}>
                  <label className={styles.label}>Password</label>
                  <input
                    className={styles.input}
                    type="password"
                    placeholder="SSH password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                </div>
              )}

              {authMethod === 'key' && (
                <div className={styles.field}>
                  <label className={styles.label}>Private Key Path (server-side)</label>
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="~/.ssh/id_rsa"
                    value={sshKey}
                    onChange={e => setSshKey(e.target.value)}
                  />
                  <span className={styles.hint}>Path to private key on the agent server</span>
                </div>
              )}

              <button
                className={styles.btnPrimary}
                onClick={testConnection}
                disabled={testing || !host.trim()}
              >
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
            </div>
          </div>

          {/* Quick Commands */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>Quick Commands</div>
            <div className={styles.cardBody}>
              <div className={styles.quickList}>
                {QUICK_COMMANDS.map(({ label, cmd }) => (
                  <button
                    key={cmd}
                    className={styles.quickBtn}
                    onClick={() => { setCommand(cmd); cmdRef.current?.focus() }}
                    title={cmd}
                  >
                    <span className={styles.quickLabel}>{label}</span>
                    <span className={styles.quickCmd}>{cmd}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Command + Terminal ── */}
        <div className={styles.rightCol}>
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span>
                Command Execution
                {connStatus === 'connected' && (
                  <span className={styles.activeHost}> — {username}@{host}:{port}</span>
                )}
              </span>
              <button className={styles.btnGhost} onClick={clearTerminal}>
                Clear
              </button>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.cmdRow}>
                <textarea
                  ref={cmdRef}
                  className={styles.cmdInput}
                  placeholder="Enter command… (Ctrl+Enter to run)"
                  rows={3}
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={running}
                />
                <button
                  className={styles.btnRun}
                  onClick={runCommand}
                  disabled={running || !command.trim() || !host.trim()}
                  title="Run (Ctrl+Enter)"
                >
                  {running ? '⏳' : '▶ Run'}
                </button>
              </div>

              {/* Terminal output */}
              <div className={styles.terminal} ref={termRef}>
                {lines.map(line => (
                  <div key={line.id} className={styles.termLine}>
                    <span className={styles.termTimestamp}>[{line.ts}]&nbsp;</span>
                    {line.type === 'prompt' && (
                      <span className={styles.termPrompt}>{line.text}</span>
                    )}
                    {line.type === 'stdout' && (
                      <span className={styles.termOutput}>{line.text}</span>
                    )}
                    {line.type === 'stderr' && (
                      <span className={styles.termError}>{line.text}</span>
                    )}
                    {line.type === 'info' && (
                      <span className={styles.termInfo}>{line.text}</span>
                    )}
                  </div>
                ))}
                {running && (
                  <div className={styles.termLine}>
                    <span className={styles.termInfo}>Running…</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  )
}
