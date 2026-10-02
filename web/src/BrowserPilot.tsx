import { useEffect, useState } from 'react'
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  Clock3,
  Command,
  Globe2,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  Waypoints,
} from 'lucide-react'
import './pilot.css'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
type BrowserSnapshot = { url: string; title: string; image: string; capturedAt: number }

const examples = [
  'Find a quiet hotel in Copenhagen',
  'Compare these two product pages',
  'Pick up where I left off',
]

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [command, setCommand] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [statusMessage, setStatusMessage] = useState('')
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer = 0
    let disposed = false
    let attempts = 0

    const connect = () => {
      if (disposed) return
      setStatus('connecting')
      socket = new WebSocket(import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001')
      socket.onopen = () => {
        attempts = 0
        setStatus('connected')
        setStatusMessage('')
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as Record<string, unknown>
          if (message.type === 'status') {
            if (message.status === 'error') {
              setStatus('error')
              setStatusMessage(String(message.error ?? 'Chrome could not be started.'))
            } else if (message.status === 'connected') {
              setStatus('connected')
              setStatusMessage('')
            }
          }
          if (message.type === 'snapshot' && typeof message.image === 'string') {
            setSnapshot({
              url: String(message.url ?? ''),
              title: String(message.title ?? ''),
              image: message.image,
              capturedAt: Number(message.capturedAt ?? Date.now()),
            })
            setStatus('connected')
          }
          if (message.type === 'error') setStatusMessage(String(message.message ?? 'The request failed.'))
        } catch {
          setStatusMessage('Received an unreadable update from the browser.')
        }
      }
      socket.onclose = () => {
        if (disposed) return
        setStatus('disconnected')
        attempts += 1
        reconnectTimer = window.setTimeout(connect, Math.min(800 * 2 ** (attempts - 1), 8_000))
      }
      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [])

  const connectionLabel = {
    connecting: 'Starting up',
    connected: 'Connected',
    disconnected: 'Reconnecting',
    error: 'Needs attention',
  }[status]

  return (
    <div className="app-shell min-h-screen" data-theme={theme}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Waypoints size={21} strokeWidth={2.1} /></div>
          <div className="brand-name">browser<span>pilot</span></div>
        </div>

        <button className="new-task-button" onClick={() => setCommand('')}>
          <Plus size={17} />
          <span>New task</span>
          <kbd>⌘ K</kbd>
        </button>

        <div className="history-heading">
          <span>Recent</span>
          <span className="history-count">0</span>
        </div>
        <div className="empty-history">
          <div className="history-icon"><Clock3 size={16} /></div>
          <p>Your tasks will appear here</p>
        </div>

        <div className="sidebar-bottom">
          {settingsOpen && (
            <div className="settings-popover">
              <span>Appearance</span>
              <button className="theme-switch" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
                <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
                <span className="switch-track"><span /></span>
              </button>
            </div>
          )}
          <button className={`settings-button ${settingsOpen ? 'is-open' : ''}`} onClick={() => setSettingsOpen(!settingsOpen)}>
            <Settings2 size={17} />
            <span>Settings</span>
            <span className="settings-shortcut">⌘ ,</span>
          </button>
          <div className="profile-row">
            <div className="profile-avatar">BP</div>
            <div className="profile-copy"><span>Browser Pilot</span><small>Personal workspace</small></div>
            <ArrowUpRight size={14} />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="command-header">
          <div className="command-bar">
            <Sparkles className="command-sparkle" size={17} />
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Tell Browser Pilot what to do..."
              aria-label="Describe a browser task"
            />
            <div className="command-hint"><Command size={12} /><span>Enter</span></div>
            <button className="send-button" aria-label="Send task" title="Send task">
              <ArrowUp size={17} />
            </button>
          </div>
          <div className={`connection-pill status-${status}`}>
            <span className="status-dot" />
            <span>{connectionLabel}</span>
          </div>
        </header>

        <div className="workspace-content">
          <section className="welcome-row">
            <div className="welcome-copy">
              <div className="eyebrow"><span className="eyebrow-line" /> YOUR BROWSER, WITH A COPILOT</div>
              <h1>Where should we <span>go?</span></h1>
              <p>Your browser is ready when you are.</p>
            </div>
            <div className="example-tasks" aria-label="Example tasks">
              {examples.map((example, index) => (
                <button key={example} className="example-chip" onClick={() => setCommand(example)}>
                  <span className="example-number">0{index + 1}</span>
                  <span>{example}</span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </section>

          {statusMessage && <div className={`connection-message ${status === 'error' ? 'is-error' : ''}`}>{statusMessage}</div>}

          <section className="browser-panel" aria-label="Live browser view">
            <div className="browser-toolbar">
              <div className="browser-controls" aria-hidden="true"><span /><span /><span /></div>
              <div className="browser-tab"><Globe2 size={13} /><span>{snapshot?.title || 'Live browser'}</span></div>
              <div className="address-display" title={snapshot?.url ?? ''}>
                <span className="secure-indicator"><Check size={11} /></span>
                <span>{snapshot?.url || 'Waiting for your browser...'}</span>
                <ArrowUpRight size={13} />
              </div>
            </div>
            <div className="browser-viewport">
              {snapshot ? (
                <img className="browser-screenshot" src={`data:image/jpeg;base64,${snapshot.image}`} alt={`Live browser page: ${snapshot.title || snapshot.url}`} />
              ) : (
                <div className="browser-placeholder">
                  <div className="placeholder-rings"><div><Bot size={25} /></div></div>
                  <span className="loader-line" />
                  <p>{status === 'error' ? 'Chrome needs a little attention' : status === 'disconnected' ? 'Reconnecting to your browser...' : 'Opening your browser...'}</p>
                  <small>{status === 'error' ? 'Check the server terminal for setup details.' : 'Your live view will appear here in a moment.'}</small>
                </div>
              )}
              <div className="live-badge"><span className="live-dot" /> LIVE</div>
              <span className="capture-time">{snapshot ? new Date(snapshot.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'WAITING'}</span>
            </div>
          </section>

          <section className="activity-panel" aria-label="Activity timeline">
            <div className="activity-heading">
              <div className="activity-title"><span className="activity-icon"><Bot size={15} /></span><span>Activity</span></div>
              <span className="activity-state">READY FOR A TASK</span>
            </div>
            <div className="timeline-empty">
              <span className="timeline-stem" />
              <div className="timeline-node"><span /></div>
              <div className="timeline-copy"><span>Waiting for your first task</span><small>Actions and progress will show up here.</small></div>
              <span className="timeline-ready"><span /> STANDING BY</span>
            </div>
            <div className="activity-footer"><span><span className="footer-dot" /> Browser session is private</span><span>Chrome profile stays on this device</span></div>
          </section>
          <div className="workspace-footnote"><span>BUILT FOR THE OPEN WEB</span><span>PHASE 01 <span className="footnote-divider">/</span> CONNECT</span></div>
        </div>
      </main>
    </div>
  )
}

export default App