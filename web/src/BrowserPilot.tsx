import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  Command,
  Globe2,
  LoaderCircle,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  Waypoints,
  X,
} from 'lucide-react'
import './pilot.css'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
type BrowserSnapshot = { url: string; title: string; image: string; capturedAt: number }
type AgentEvent = { type: 'step' | 'summary'; description: string; status: 'thinking' | 'running' | 'done' | 'failed'; timestamp: number; step?: number }
type HistoryEntry = { id: string; task: string; status: 'running' | 'completed' | 'failed' | 'stopped'; summary?: string; createdAt: number; updatedAt: number }
type ModelSettings = { provider: 'openrouter' | 'local'; baseUrl: string; model: string; apiKey: string }

const apiBase = `${import.meta.env.VITE_API_URL ?? ''}/api`
const examples = ['Find the top story on Hacker News and summarize it', 'Compare these two product pages', 'Find a quiet hotel in Copenhagen']
const emptySettings: ModelSettings = { provider: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b', apiKey: '' }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`)
  return body
}

function eventIcon(event: AgentEvent) {
  if (event.status === 'thinking') return <LoaderCircle className="event-spin" size={15} />
  if (event.status === 'running') return <Bot size={15} />
  if (event.status === 'failed') return <CircleAlert size={15} />
  return <CircleCheck size={15} />
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [command, setCommand] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [statusMessage, setStatusMessage] = useState('')
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)
  const [modelConfigured, setModelConfigured] = useState(false)
  const [settings, setSettings] = useState<ModelSettings>(emptySettings)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [taskStatus, setTaskStatus] = useState<'ready' | 'thinking' | 'running' | 'completed' | 'failed' | 'stopped'>('ready')
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState('')
  const [userResponse, setUserResponse] = useState('')
  const timelineRef = useRef<HTMLDivElement>(null)
  const activeTaskRef = useRef<string | null>(null)
  const selectedTaskRef = useRef<string | null>(null)
  activeTaskRef.current = activeTaskId
  selectedTaskRef.current = selectedTask

  useEffect(() => {
    void Promise.all([
      api<ModelSettings | null>('/settings').then((value) => {
        if (value) {
          setModelConfigured(true)
          setSettings({ ...value, apiKey: '' })
        }
      }).catch(() => undefined),
      api<HistoryEntry[]>('/tasks').then(setHistory).catch(() => undefined),
    ])
  }, [])

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer = 0
    let disposed = false
    let attempts = 0
    const connect = () => {
      if (disposed) return
      setStatus('connecting')
      socket = new WebSocket(import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001')
      socket.onopen = () => { attempts = 0; setStatus('connected'); setStatusMessage('') }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as Record<string, unknown>
          if (message.type === 'status') {
            if (message.status === 'error') { setStatus('error'); setStatusMessage(String(message.error ?? 'Chrome could not be started.')) }
            else if (message.status === 'connected') { setStatus('connected'); setStatusMessage('') }
          }
          if (message.type === 'snapshot' && typeof message.image === 'string') {
            setSnapshot({ url: String(message.url ?? ''), title: String(message.title ?? ''), image: message.image, capturedAt: Number(message.capturedAt ?? Date.now()) })
            setStatus('connected')
          }
          if (message.type === 'error') setStatusMessage(String(message.message ?? 'The request failed.'))
          if (message.type === 'agent-event' && message.event && typeof message.event === 'object') {
            const taskId = String(message.taskId)
            const nextEvent = message.event as AgentEvent
            if (taskId === activeTaskRef.current || taskId === selectedTaskRef.current) {
              setSelectedTask(taskId)
              setEvents((current) => [...current, nextEvent])
            }
            if (taskId === activeTaskRef.current) {
              setTaskStatus(nextEvent.type === 'summary' && nextEvent.status === 'done' ? 'completed' : nextEvent.status === 'done' ? 'running' : nextEvent.status)
              if (nextEvent.description.startsWith('Question for user:')) setPendingQuestion(nextEvent.description.slice('Question for user:'.length).trim())
            }
          }
          if (message.type === 'task-finished') {
            const taskId = String(message.taskId)
            const finalStatus = String(message.status) as HistoryEntry['status']
            if (taskId === activeTaskRef.current) {
              setTaskStatus(finalStatus)
              setActiveTaskId(null)
            }
            void api<HistoryEntry[]>('/tasks').then(setHistory).catch(() => undefined)
          }
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
    return () => { disposed = true; window.clearTimeout(reconnectTimer); socket?.close() }
  }, [])

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: 'smooth' })
  }, [events])

  const loadTask = async (id: string) => {
    try {
      const record = await api<{ events: AgentEvent[]; status: HistoryEntry['status'] }>(`/tasks/${id}`)
      setSelectedTask(id)
      setEvents(record.events)
      setTaskStatus(record.status)
      setActiveTaskId(record.status === 'running' ? id : null)
      setPendingQuestion(record.events.findLast((item) => item.description.startsWith('Question for user:'))?.description.slice('Question for user:'.length).trim() ?? '')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not load task history.')
    }
  }

  const submitTask = async (event: FormEvent) => {
    event.preventDefault()
    if (activeTaskId) {
      return
    }
    if (!command.trim()) return
    try {
      const result = await api<{ id: string }>('/tasks', { method: 'POST', body: JSON.stringify({ task: command.trim() }) })
      setEvents([])
      setPendingQuestion('')
      setSelectedTask(result.id)
      setActiveTaskId(result.id)
      setTaskStatus('thinking')
      setCommand('')
      setHistory((current) => [{ id: result.id, task: command.trim(), status: 'running', createdAt: Date.now(), updatedAt: Date.now() }, ...current])
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not start task.')
      if (/no model is configured/i.test(error instanceof Error ? error.message : '')) setSettingsOpen(true)
    }
  }

  const stopTask = async () => {
    if (!activeTaskId) return
    try { await api(`/tasks/${activeTaskId}/stop`, { method: 'POST' }) } catch (error) { setStatusMessage(error instanceof Error ? error.message : 'Could not stop task.') }
  }

  const answerQuestion = async (event: FormEvent) => {
    event.preventDefault()
    if (!activeTaskId || !userResponse.trim()) return
    try {
      await api(`/tasks/${activeTaskId}/respond`, { method: 'POST', body: JSON.stringify({ answer: userResponse }) })
      setPendingQuestion('')
      setUserResponse('')
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : 'Could not send your response.') }
  }

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault()
    setSettingsBusy(true)
    setSettingsMessage('')
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(settings) })
      setModelConfigured(true)
      setSettings({ ...settings, apiKey: '' })
      setSettingsMessage('Settings saved on this device.')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'Could not save settings.')
    } finally { setSettingsBusy(false) }
  }

  const testSettings = async () => {
    setSettingsBusy(true)
    setSettingsMessage('Testing connection...')
    try {
      const result = await api<{ message: string }>('/settings/test', { method: 'POST', body: JSON.stringify(settings) })
      setSettingsMessage(result.message)
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'Connection test failed.')
    } finally { setSettingsBusy(false) }
  }

  const statusLabel = { connecting: 'Starting up', connected: 'Connected', disconnected: 'Reconnecting', error: 'Needs attention' }[status]
  const taskLabel = { ready: 'READY FOR A TASK', thinking: 'THINKING', running: 'RUNNING', completed: 'COMPLETED', failed: 'FAILED', stopped: 'STOPPED' }[taskStatus]
  const selectedHistory = history.find((item) => item.id === selectedTask)

  return (
    <div className="app-shell min-h-screen" data-theme={theme}>
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark"><Waypoints size={21} strokeWidth={2.1} /></div><div className="brand-name">browser<span>pilot</span></div></div>
        <button className="new-task-button" onClick={() => { setCommand(''); setSelectedTask(null); setEvents([]); setTaskStatus('ready') }}><Plus size={17} /><span>New task</span><kbd>⌘ K</kbd></button>
        <div className="history-heading"><span>Recent</span><span className="history-count">{history.length}</span></div>
        <div className="history-list">
          {history.length ? history.slice(0, 20).map((item) => (
            <button key={item.id} className={`history-item ${selectedTask === item.id ? 'is-selected' : ''}`} onClick={() => void loadTask(item.id)}>
              {item.status === 'running' ? <LoaderCircle className="event-spin" size={14} /> : item.status === 'completed' ? <Check size={14} /> : <CircleAlert size={14} />}
              <span>{item.task}</span>
            </button>
          )) : <div className="empty-history"><div className="history-icon"><Clock3 size={16} /></div><p>Your tasks will appear here</p></div>}
        </div>
        <div className="sidebar-bottom">
          {settingsOpen && <div className="settings-popover"><span>Appearance</span><button className="theme-switch" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}<span>{theme === 'dark' ? 'Dark' : 'Light'}</span><span className="switch-track"><span /></span></button></div>}
          <button className={`settings-button ${settingsOpen ? 'is-open' : ''}`} onClick={() => { setSettingsOpen(true); setSettingsMessage('') }}><Settings2 size={17} /><span>Settings</span><span className="settings-shortcut">⌘ ,</span></button>
          <div className="profile-row"><div className="profile-avatar">BP</div><div className="profile-copy"><span>Browser Pilot</span><small>Personal workspace</small></div><ArrowUpRight size={14} /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="command-header">
          <form className="command-bar" onSubmit={(event) => void submitTask(event)}>
            <Sparkles className="command-sparkle" size={17} />
            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Tell Browser Pilot what to do..." aria-label="Describe a browser task" disabled={Boolean(activeTaskId)} />
            <div className="command-hint"><Command size={12} /><span>Enter</span></div>
            <button className={`send-button ${activeTaskId ? 'is-stop' : ''}`} aria-label={activeTaskId ? 'Stop task' : 'Send task'} title={activeTaskId ? 'Stop task' : 'Send task'} type={activeTaskId ? 'button' : 'submit'} onClick={activeTaskId ? () => void stopTask() : undefined}>
              {activeTaskId ? <span className="stop-square" /> : <ArrowUp size={17} />}
            </button>
          </form>
          <div className={`connection-pill status-${status}`}><span className="status-dot" /><span>{statusLabel}</span></div>
        </header>

        <div className="workspace-content">
          <section className="welcome-row">
            <div className="welcome-copy"><div className="eyebrow"><span className="eyebrow-line" /> YOUR BROWSER, WITH A COPILOT</div><h1>Where should we <span>go?</span></h1><p>{modelConfigured ? 'Your browser and model are ready when you are.' : 'Connect a model to start your first autonomous task.'}</p></div>
            <div className="example-tasks" aria-label="Example tasks">{examples.map((example, index) => <button key={example} className="example-chip" onClick={() => setCommand(example)}><span className="example-number">0{index + 1}</span><span>{example}</span><ArrowUpRight size={14} /></button>)}</div>
          </section>

          {!modelConfigured && <button className="model-hint" onClick={() => setSettingsOpen(true)}><Sparkles size={15} /><span><strong>No model configured.</strong> Choose OpenRouter or a local Ollama/LM Studio model to begin.</span><ArrowUpRight size={14} /></button>}
          {statusMessage && <div className={`connection-message ${status === 'error' ? 'is-error' : ''}`}>{statusMessage}<button aria-label="Dismiss message" onClick={() => setStatusMessage('')}><X size={14} /></button></div>}

          <div className="workspace-grid">
            <section className="browser-panel" aria-label="Live browser view">
              <div className="browser-toolbar"><div className="browser-controls" aria-hidden="true"><span /><span /><span /></div><div className="browser-tab"><Globe2 size={13} /><span>{snapshot?.title || 'Live browser'}</span></div><div className="address-display" title={snapshot?.url ?? ''}><span className="secure-indicator"><Check size={11} /></span><span>{snapshot?.url || 'Waiting for your browser...'}</span><ArrowUpRight size={13} /></div></div>
              <div className="browser-viewport">
                {snapshot ? <img className="browser-screenshot" src={`data:image/jpeg;base64,${snapshot.image}`} alt={`Live browser page: ${snapshot.title || snapshot.url}`} /> : <div className="browser-placeholder"><div className="placeholder-rings"><div><Bot size={25} /></div></div><span className="loader-line" /><p>{status === 'error' ? 'Chrome needs a little attention' : status === 'disconnected' ? 'Reconnecting to your browser...' : 'Opening your browser...'}</p><small>{status === 'error' ? 'Check the server terminal for setup details.' : 'Your live view will appear here in a moment.'}</small></div>}
                <div className="live-badge"><span className="live-dot" /> LIVE</div><span className="capture-time">{snapshot ? new Date(snapshot.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'WAITING'}</span>
              </div>
            </section>

            <section className="activity-panel" aria-label="Activity timeline">
              <div className="activity-heading"><div className="activity-title"><span className="activity-icon"><Bot size={15} /></span><span>{selectedHistory?.task ?? 'Activity'}</span></div><span className={`activity-state state-${taskStatus}`}>{taskLabel}</span></div>
              <div className="timeline-list" ref={timelineRef}>
                {events.length ? events.map((item, index) => <div key={`${item.timestamp}-${index}`} className={`timeline-event event-${item.status} ${item.type === 'summary' ? 'event-summary' : ''}`}><div className="event-icon">{eventIcon(item)}</div><div className="timeline-copy"><span>{item.description}</span><small>{item.step ? `STEP ${item.step} · ` : ''}{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div></div>) : <div className="timeline-empty"><span className="timeline-stem" /><div className="timeline-node"><span /></div><div className="timeline-copy"><span>{selectedTask ? 'No activity recorded' : 'Waiting for your first task'}</span><small>Actions and progress will show up here.</small></div><span className="timeline-ready"><span /> STANDING BY</span></div>}
                {pendingQuestion && activeTaskId && <form className="answer-form" onSubmit={(event) => void answerQuestion(event)}><label htmlFor="agent-answer">{pendingQuestion}</label><input id="agent-answer" value={userResponse} onChange={(event) => setUserResponse(event.target.value)} placeholder="Your response..." autoComplete="off" /><button type="submit" disabled={!userResponse.trim()}>Reply</button></form>}
              </div>
              <div className="activity-footer"><span><span className="footer-dot" /> Browser session is private</span><span>{selectedHistory ? new Date(selectedHistory.createdAt).toLocaleDateString() : 'Chrome profile stays on this device'}</span></div>
            </section>
          </div>
          <div className="workspace-footnote"><span>BUILT FOR THE OPEN WEB</span><span>PHASE 02 <span className="footnote-divider">/</span> AUTONOMY</span></div>
        </div>
      </main>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="modal-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> MODEL CONNECTION</span><h2 id="settings-title">Settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div>
          <form onSubmit={(event) => void saveSettings(event)}>
            <label className="field-label">Provider</label>
            <div className="provider-toggle"><button type="button" className={settings.provider === 'openrouter' ? 'is-active' : ''} onClick={() => setSettings({ ...settings, provider: 'openrouter', baseUrl: settings.provider === 'openrouter' ? settings.baseUrl : 'https://openrouter.ai/api/v1', model: settings.provider === 'openrouter' ? settings.model : 'openai/gpt-4o-mini' })}>OpenRouter</button><button type="button" className={settings.provider === 'local' ? 'is-active' : ''} onClick={() => setSettings({ ...settings, provider: 'local', baseUrl: settings.provider === 'local' ? settings.baseUrl : 'http://localhost:11434/v1', model: settings.provider === 'local' ? settings.model : 'llama3.2:3b' })}>Local model</button></div>
            {settings.provider === 'openrouter' && <label className="form-field"><span>API key</span><input type="password" autoComplete="new-password" placeholder={modelConfigured ? 'Saved key retained when blank' : 'sk-or-...'} value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} /></label>}
            <label className="form-field"><span>Base URL</span><input required value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} placeholder="http://localhost:11434/v1" /></label>
            <label className="form-field"><span>Model name</span><input required value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder="llama3.2:3b" /></label>
            {settingsMessage && <div className={`settings-feedback ${settingsMessage.startsWith('Connection successful') || settingsMessage.startsWith('Settings saved') ? 'is-success' : ''}`} role="status">{settingsMessage.startsWith('Connection successful') || settingsMessage.startsWith('Settings saved') ? <Check size={15} /> : <CircleAlert size={15} />}{settingsMessage}</div>}
            <div className="modal-actions"><button type="button" className="secondary-button" disabled={settingsBusy} onClick={() => void testSettings()}>{settingsBusy ? <LoaderCircle className="event-spin" size={15} /> : <Globe2 size={15} />} Test connection</button><button type="submit" className="primary-button" disabled={settingsBusy}>{settingsBusy ? 'Working...' : 'Save settings'}</button></div>
          </form>
        </section>
      </div>}
    </div>
  )
}

export default App