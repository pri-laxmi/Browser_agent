import express from 'express'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { WebSocket, WebSocketServer } from 'ws'
import { runAgent, testModelConnection, type AgentEvent, type AgentStep, type BrowserAction, type ModelSettings } from './agent.js'

const port = Number(process.env.PORT ?? 3001)
const profilePath = resolve(process.cwd(), '.browser-profile')
const settingsPath = resolve(process.cwd(), '.browser-pilot-settings.json')
const historyPath = resolve(process.cwd(), '.browser-pilot-history.json')
const app = express()
const server = createServer(app)
const webSocketServer = new WebSocketServer({ server })
app.use(express.json({ limit: '32kb' }))

let browserContext: BrowserContext | null = null
let activePage: Page | null = null
let browserError: string | null = null
let captureInProgress = false

type TaskRecord = { id: string; task: string; status: 'running' | 'completed' | 'failed' | 'stopped'; summary?: string; events: AgentEvent[]; steps: AgentStep[]; createdAt: number; updatedAt: number }
let taskHistory: TaskRecord[] = []
let activeTask: {
  id: string
  controller: AbortController
  answerQuestion?: (answer: string) => void
  answerApproval?: (approved: boolean) => void
} | null = null

const safetyKeywords = ['pay', 'payment', 'buy now', 'place order', 'checkout', 'purchase', 'subscribe', 'confirm payment', 'delete', 'remove account', 'text', 'post', 'change password', 'card number']

function matchingSafetyKeyword(value: string) {
  const normalized = value.replace(/\s+/g, ' ').toLowerCase()
  return safetyKeywords.find((keyword) => {
    const expression = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')}\\b`, 'i')
    return expression.test(normalized)
  })
}

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function persistHistory() {
  await writeFile(historyPath, JSON.stringify(taskHistory.slice(0, 50), null, 2), 'utf8')
}

taskHistory = await loadJson<TaskRecord[]>(historyPath, [])
for (const task of taskHistory) {
  if (task.status === 'running') {
    task.status = 'failed'
    task.summary = 'Server restarted before this task finished.'
    task.events.push({ type: 'step', description: task.summary, status: 'failed', timestamp: Date.now() })
  }
}

function emitTaskEvent(task: TaskRecord, event: AgentEvent) {
  task.events.push(event)
  task.updatedAt = Date.now()
  sendToClients({ type: 'agent-event', taskId: task.id, event })
  void persistHistory()
}

function validSettings(value: unknown): ModelSettings | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (!['openrouter', 'local'].includes(String(candidate.provider))) return null
  if (typeof candidate.baseUrl !== 'string' || typeof candidate.model !== 'string' || !candidate.baseUrl.trim() || !candidate.model.trim()) return null
  try {
    const url = new URL(candidate.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) return null
  } catch {
    return null
  }
  if (candidate.provider === 'openrouter' && (typeof candidate.apiKey !== 'string' || !candidate.apiKey.trim())) return null
  return {
    provider: candidate.provider as ModelSettings['provider'],
    baseUrl: candidate.baseUrl.trim().replace(/\/+$/, ''),
    model: candidate.model.trim(),
    ...(typeof candidate.apiKey === 'string' && candidate.apiKey ? { apiKey: candidate.apiKey } : {}),
  }
}

app.get('/api/settings', async (_request, response) => {
  const settings = await loadJson<ModelSettings | null>(settingsPath, null)
  response.json(settings ? { ...settings, apiKey: settings.apiKey ? '********' : '' } : null)
})

function settingsWithSavedKey(value: unknown, saved: ModelSettings | null) {
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>
    if (candidate.provider === 'openrouter' && !candidate.apiKey && saved?.provider === 'openrouter' && saved.apiKey) {
      return validSettings({ ...candidate, apiKey: saved.apiKey })
    }
  }
  return validSettings(value)
}

app.put('/api/settings', async (request, response) => {
  const saved = await loadJson<ModelSettings | null>(settingsPath, null)
  const settings = settingsWithSavedKey(request.body, saved)
  if (!settings) {
    response.status(400).json({ error: 'Choose a provider and enter a valid base URL and model. OpenRouter also requires an API key.' })
    return
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
  response.json({ provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, configured: true })
})

app.post('/api/settings/test', async (request, response) => {
  const saved = await loadJson<ModelSettings | null>(settingsPath, null)
  const settings = settingsWithSavedKey(request.body, saved)
  if (!settings) {
    response.status(400).json({ success: false, error: 'Enter a valid provider, base URL, model, and required API key.' })
    return
  }
  try {
    const reply = await testModelConnection(settings)
    response.json({ success: true, message: `Connection successful. Model replied: ${reply}` })
  } catch (error) {
    response.status(502).json({ success: false, error: error instanceof Error ? error.message : 'Could not reach the model.' })
  }
})

app.get('/api/tasks', (_request, response) => {
  response.json(taskHistory.map(({ id, task, status, summary, createdAt, updatedAt }) => ({ id, task, status, summary, createdAt, updatedAt })))
})

app.get('/api/tasks/:id', (request, response) => {
  const task = taskHistory.find((item) => item.id === request.params.id)
  if (!task) {
    response.status(404).json({ error: 'Task not found.' })
    return
  }
  response.json(task)
})

app.post('/api/tasks', async (request, response) => {
  const taskText = typeof request.body?.task === 'string' ? request.body.task.trim() : ''
  if (!taskText) {
    response.status(400).json({ error: 'Enter a task first.' })
    return
  }
  if (activeTask) {
    response.status(409).json({ error: 'Another task is already running.' })
    return
  }
  const settings = await loadJson<ModelSettings | null>(settingsPath, null)
  if (!settings) {
    response.status(400).json({ error: 'No model is configured. Open Settings to connect a model.' })
    return
  }
  if (!browserContext) {
    response.status(503).json({ error: browserError ?? 'The browser is not ready yet.' })
    return
  }
  if (!activePage || activePage.isClosed()) {
    try {
      activePage = await browserContext.newPage()
      followPage(activePage)
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : 'Could not open a browser page.' })
      return
    }
  }

  const record: TaskRecord = { id: crypto.randomUUID(), task: taskText, status: 'running', events: [], steps: [], createdAt: Date.now(), updatedAt: Date.now() }
  taskHistory.unshift(record)
  const controller = new AbortController()
  activeTask = { id: record.id, controller }
  await persistHistory()
  response.status(202).json({ id: record.id })

  void runAgent({
    task: taskText,
    settings,
    signal: controller.signal,
    observe: async () => {
      const page = activePage
      if (!page || page.isClosed()) throw new Error('The active browser page is unavailable.')
      return page.evaluate(String.raw`(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
        }
        const dismissButtons = [...document.querySelectorAll('button,[role="button"],a')].filter(visible)
        const dismiss = dismissButtons.find((element) => /^(accept all|accept cookies|agree|close|reject all|dismiss|got it|continue without accepting)$/i.test((element.textContent || '').trim()))
        if (dismiss) dismiss.click()
        const interactive = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="combobox"]')].filter(visible).slice(0, 60)
        const items = interactive.map((element, index) => {
          const id = String(index + 1)
          element.setAttribute('data-browser-pilot-id', id)
          const control = element
          const label = control.labels?.[0]?.innerText?.trim() || element.getAttribute('aria-label') || element.getAttribute('title') || (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100)
          const details = [control.type, control.name, control.autocomplete].filter(Boolean).join(' ')
          return id + '. <' + element.tagName.toLowerCase() + '> role=' + (element.getAttribute('role') || '') + ' label=' + JSON.stringify(label) + ' placeholder=' + JSON.stringify(control.placeholder || '') + ' details=' + JSON.stringify(details)
        })
        return 'URL: ' + location.href + '\nTitle: ' + document.title + '\nVisible text:\n' + (document.body.innerText || '').slice(0, 7000) + '\nVisible interactive elements:\n' + items.join('\n')
      })()`)
    },
    assess: async (action: BrowserAction, observation: string) => {
      const page = activePage
      if (!page || page.isClosed()) throw new Error('The active browser page is unavailable.')
      let target = action.action.replaceAll('_', ' ')
      let requiresLogin = false
      const loggedIn = Boolean(await page.evaluate(String.raw`(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
        }
        const controls = [...document.querySelectorAll('button,a,[role="button"],[aria-haspopup]')].filter(visible)
        const labels = controls.map((element) => [
          element.textContent,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
        const hasSignOut = labels.some((label) => /\b(sign out|log out)\b/i.test(label))
        const hasAccountMenu = labels.some((label) => /\b(account menu|profile menu|your account|my account|account & lists|hello,\s*\w+)\b/i.test(label))
        const hasSignIn = labels.some((label) => /\b(sign in|log in|sign up|create account)\b/i.test(label))
        return hasSignOut || (hasAccountMenu && !hasSignIn)
      })()`))
      if (action.action === 'click' || action.action === 'type_text') {
        const details = await page.evaluate((elementId) => {
          const element = document.querySelector(`[data-browser-pilot-id="${elementId}"]`)
          if (!element) return null
          const input = element as HTMLInputElement
          const form = element.closest('form')
          const credentialForm = Boolean(form?.querySelector('input[type="password"],input[autocomplete="current-password"]'))
          const label = input.labels?.[0]?.innerText?.trim()
          const fieldDetails = `${input.name} ${input.placeholder} ${input.id} ${input.autocomplete} ${label}`
          const usernameField = ['username', 'current-password'].includes(input.autocomplete) || /user(name)?|login/i.test(fieldDetails)
          const credentialField = input.matches('input') && (
            input.type === 'password' ||
            usernameField ||
            (credentialForm && input.autocomplete === 'email') ||
            /pass(word|code)?|one[-_ ]time|verification[-_ ]code|security[-_ ]code|\botp\b|\bpin\b/i.test(fieldDetails)
          )
          const loginForm = credentialForm || (usernameField && Boolean(document.querySelector('input[type="password"],input[autocomplete="current-password"]')))
          const context = element.closest('label,form,[role="group"],li')?.textContent?.trim()
          const descriptor = [
            element.tagName.toLowerCase(),
            element.getAttribute('type'),
            element.getAttribute('name'),
            element.getAttribute('autocomplete'),
            label,
            element.getAttribute('aria-label'),
            element.getAttribute('placeholder'),
            element.getAttribute('title'),
            element.textContent?.trim(),
            context,
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 500)
          return { descriptor, credentialField, loginForm }
        }, action.element)
        if (details) {
          target = details.descriptor
          requiresLogin = (action.action === 'type_text' && details.credentialField) ||
            (action.action === 'click' && (details.loginForm || (!loggedIn && /\b(sign in|log in)\b/i.test(details.descriptor))))
        }
      } else if (action.action === 'press_key') {
        requiresLogin = await page.evaluate(String.raw`(() => {
          const element = document.activeElement
          if (!element) return false
          const input = element
          const formHasPassword = Boolean(element.closest('form')?.querySelector('input[type="password"],input[autocomplete="current-password"]'))
          const fieldDetails = [
            input.name,
            input.placeholder,
            input.id,
            input.autocomplete,
            input.labels?.[0]?.innerText,
          ].filter(Boolean).join(' ')
          return formHasPassword || /password|passcode|one[-_ ]time|verification[-_ ]code|security[-_ ]code|\botp\b|\bpin\b/i.test(fieldDetails)
        })()`)
        if (requiresLogin) target = 'the focused login or verification field'
      } else if (action.action === 'go_to_url') {
        target = action.url ?? 'the requested website'
      }
      if (action.action === 'ask_user' || action.action === 'finish') {
        return { critical: false, reason: '', target, requiresLogin, loggedIn }
      }
      const pageContent = await page.locator('body').innerText({ timeout: 8_000 })
      const keywordInTarget = matchingSafetyKeyword(target)
      const keywordInPage = matchingSafetyKeyword(pageContent || observation)
      const sensitiveCardField = /(?:cc[-_]?number|card[\s_-]*number)/i.test(target)
      const matchedKeyword = keywordInTarget ?? keywordInPage
      const critical = Boolean(matchedKeyword || sensitiveCardField)
      const reason = sensitiveCardField
        ? 'The target is a payment-card number field.'
        : matchedKeyword
          ? `The runtime safety rule matched "${matchedKeyword}" in the ${keywordInTarget ? 'target element' : 'page content'}.`
          : ''
      return { critical, reason, target, requiresLogin, loggedIn }
    },
    requestApproval: async (action: BrowserAction, reason: string, target: string) => {
      const current = activeTask
      if (!current || current.id !== record.id) throw new Error('Task is no longer active.')
      const targetLabel = target ? `“${target.slice(0, 160)}”` : 'the page'
      let actionDescription: string
      if (action.action === 'click') actionDescription = `click ${targetLabel}`
      else if (action.action === 'type_text' && /cc[-_]?number|card[\s_-]*number/i.test(target)) actionDescription = `enter payment-card details in ${targetLabel}`
      else if (action.action === 'type_text') actionDescription = `enter “${(action.text ?? '').slice(0, 160)}” in ${targetLabel}`
      else if (action.action === 'go_to_url') actionDescription = `open ${action.url}`
      else if (action.action === 'press_key') actionDescription = `press ${action.key} on the page`
      else if (action.action === 'extract_text') actionDescription = 'read the visible text on the page'
      else actionDescription = `${action.action.replaceAll('_', ' ')} on ${targetLabel}`
      const interaction: AgentEvent['interaction'] = 'approval'
      emitTaskEvent(record, {
        type: 'step',
        description: `The agent is about to ${actionDescription}. ${reason}`,
        status: 'waiting',
        interaction,
        timestamp: Date.now(),
      })
      return new Promise<boolean>((resolve, reject) => {
        const onAbort = () => {
          current.answerApproval = undefined
          reject(new Error('Task stopped by user.'))
        }
        current.answerApproval = (approved) => {
          controller.signal.removeEventListener('abort', onAbort)
          current.answerApproval = undefined
          emitTaskEvent(record, {
            type: 'step',
            description: approved ? 'Approval granted.' : 'Approval denied; the action was skipped.',
            status: approved ? 'done' : 'denied',
            interaction,
            timestamp: Date.now(),
          })
          resolve(approved)
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    execute: async (action: BrowserAction) => {
      const page = activePage
      if (!page || page.isClosed()) throw new Error('The active browser page is unavailable.')
      if (action.action === 'go_to_url') {
        const target = new URL(action.url!)
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed.')
        await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
        return `Navigated to ${page.url()}`
      }
      if (action.action === 'click' || action.action === 'type_text') {
        const locator = page.locator(`[data-browser-pilot-id="${action.element}"]`).first()
        if (await locator.count() === 0) throw new Error(`Visible element ${action.element} is missing; inspect the current page again.`)
        if (action.action === 'click') {
          await locator.click({ timeout: 8_000 })
          return `Clicked element ${action.element}.`
        }
        await locator.fill(action.text!, { timeout: 8_000 })
        if (action.pressEnter) await locator.press('Enter', { timeout: 5_000 })
        return `Entered text in element ${action.element}${action.pressEnter ? ' and pressed Enter' : ''}.`
      }
      if (action.action === 'press_key') {
        await page.keyboard.press(action.key!)
        return `Pressed ${action.key}.`
      }
      if (action.action === 'scroll') {
        await page.evaluate(({ direction, amount }) => window.scrollBy({ top: (direction === 'up' ? -1 : 1) * amount, behavior: 'instant' }), { direction: action.direction ?? 'down', amount: Math.min(1600, Math.max(100, action.amount ?? 600)) })
        return `Scrolled ${action.direction ?? 'down'}.`
      }
      if (action.action === 'wait') {
        await page.waitForTimeout(Math.min(10_000, Math.max(100, (action.seconds ?? 1) * 1000)))
        return `Waited ${Math.min(10, Math.max(0.1, action.seconds ?? 1))} seconds.`
      }
      if (action.action === 'extract_text') {
        const extracted = await page.locator('body').innerText({ timeout: 8_000 })
        return `Extracted page text: ${extracted.slice(0, 12_000)}`
      }
      if (action.action === 'ask_user') {
        const isLogin = /\b(sign in|log in)\b/i.test(action.text ?? '')
        const interaction: AgentEvent['interaction'] = isLogin ? 'login' : 'question'
        emitTaskEvent(record, { type: 'step', description: action.text!, status: 'waiting', interaction, timestamp: Date.now() })
        return new Promise<string>((resolve, reject) => {
          const current = activeTask
          if (!current || current.id !== record.id) {
            reject(new Error('Task is no longer active.'))
            return
          }
          const onAbort = () => {
            current.answerQuestion = undefined
            reject(new Error('Task stopped by user.'))
          }
          current.answerQuestion = (answer) => {
            controller.signal.removeEventListener('abort', onAbort)
            current.answerQuestion = undefined
            emitTaskEvent(record, {
              type: 'step',
              description: isLogin ? 'The user continued after signing in. Inspecting the page again.' : 'The user replied to the question.',
              status: 'done',
              interaction,
              timestamp: Date.now(),
            })
            resolve(`User replied: ${answer}`)
          }
          controller.signal.addEventListener('abort', onAbort, { once: true })
        })
      }
      throw new Error(`Unsupported browser action: ${action.action}`)
    },
    emit: (event) => emitTaskEvent(record, event),
    saveStep: (step) => {
      record.steps.push(step)
      record.updatedAt = Date.now()
      void persistHistory()
    },
  }).then(async (summary) => {
    record.status = controller.signal.aborted ? 'stopped' : 'completed'
    record.summary = summary
  }).catch((error) => {
    record.status = controller.signal.aborted ? 'stopped' : 'failed'
    record.summary = error instanceof Error ? error.message : String(error)
    emitTaskEvent(record, { type: 'step', description: record.summary, status: record.status === 'stopped' ? 'done' : 'failed', timestamp: Date.now() })
  }).finally(async () => {
    record.updatedAt = Date.now()
    await persistHistory()
    if (activeTask?.id === record.id) activeTask = null
    sendToClients({ type: 'task-finished', taskId: record.id, status: record.status, summary: record.summary })
  })
})

app.post('/api/tasks/:id/stop', (request, response) => {
  if (activeTask?.id !== request.params.id) {
    response.status(404).json({ error: 'No running task found.' })
    return
  }
  activeTask.controller.abort()
  response.json({ stopped: true })
})

app.post('/api/tasks/:id/respond', (request, response) => {
  const answer = typeof request.body?.answer === 'string' ? request.body.answer.trim() : ''
  if (!answer) {
    response.status(400).json({ error: 'Enter a response first.' })
    return
  }
  if (activeTask?.id !== request.params.id || !activeTask.answerQuestion) {
    response.status(409).json({ error: 'This task is not waiting for a response.' })
    return
  }
  activeTask.answerQuestion(answer.slice(0, 2000))
  response.json({ accepted: true })
})

app.post('/api/tasks/:id/approve', (request, response) => {
  const approved = request.body?.approved
  if (typeof approved !== 'boolean') {
    response.status(400).json({ error: 'Choose approve or deny.' })
    return
  }
  if (activeTask?.id !== request.params.id || !activeTask.answerApproval) {
    response.status(409).json({ error: 'This task is not waiting for an approval.' })
    return
  }
  activeTask.answerApproval(approved)
  response.json({ accepted: true })
})

app.get('/health', (_request, response) => {
  response.json({ status: browserError ? 'error' : browserContext ? 'connected' : 'starting', error: browserError })
})

function sendToClients(payload: Record<string, unknown>) {
  const message = JSON.stringify(payload)
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message)
  }
}

function followPage(page: Page) {
  activePage = page
  page.on('close', () => {
    if (activePage !== page) return
    const remainingPages = browserContext?.pages() ?? []
    activePage = remainingPages.at(-1) ?? null
  })
}

webSocketServer.on('connection', (client) => {
  client.send(JSON.stringify({
    type: 'status',
    status: browserError ? 'error' : browserContext ? 'connected' : 'connecting',
    error: browserError,
  }))

  client.on('message', async (rawMessage) => {
    let message: { type?: string; url?: string }
    try {
      message = JSON.parse(rawMessage.toString()) as { type?: string; url?: string }
    } catch {
      client.send(JSON.stringify({ type: 'error', message: 'Message must be valid JSON.' }))
      return
    }

    if (message.type !== 'navigate' || typeof message.url !== 'string') return

    let target: URL
    try {
      target = new URL(message.url)
    } catch {
      client.send(JSON.stringify({ type: 'error', message: 'Enter a valid URL.' }))
      return
    }

    if (!['http:', 'https:'].includes(target.protocol)) {
      client.send(JSON.stringify({ type: 'error', message: 'Only HTTP and HTTPS URLs are supported.' }))
      return
    }

    try {
      if (!browserContext) throw new Error(browserError ?? 'Chrome is still starting.')
      if (!activePage || activePage.isClosed()) {
        activePage = await browserContext.newPage()
        followPage(activePage)
      }
      await activePage.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch (error) {
      client.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Navigation failed.' }))
    }
  })
})

async function launchBrowser() {
  try {
    browserContext = await chromium.launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1440, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'],
    })

    await browserContext.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    browserContext.on('page', followPage)
    const openPages = browserContext.pages()
    if (openPages.length > 0) {
      for (const page of openPages) followPage(page)
    } else {
      followPage(await browserContext.newPage())
    }

    if (activePage?.url() === 'about:blank') {
      await activePage.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined)
    }
    console.log(`Chrome is ready with profile ${profilePath}`)
    sendToClients({ type: 'status', status: 'connected' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    browserError = /executable|chrome|channel/i.test(detail)
      ? 'Google Chrome was not found. Install Google Chrome, then restart Browser Pilot.'
      : `Chrome could not be started: ${detail}`
    console.error(browserError)
    sendToClients({ type: 'status', status: 'error', error: browserError })
  }
}

async function broadcastSnapshot() {
  if (captureInProgress || webSocketServer.clients.size === 0 || !activePage || activePage.isClosed()) return
  captureInProgress = true
  try {
    const page = activePage
    const [title, image] = await Promise.all([
      page.title().catch(() => ''),
      page.screenshot({ type: 'jpeg', quality: 65, timeout: 2_000 }),
    ])
    sendToClients({
      type: 'snapshot',
      url: page.url(),
      title,
      image: image.toString('base64'),
      capturedAt: Date.now(),
    })
  } catch {
    // A page can close or navigate while its screenshot is being captured.
  } finally {
    captureInProgress = false
  }
}

setInterval(() => void broadcastSnapshot(), 400)

server.listen(port, () => {
  console.log(`Browser Pilot server listening on http://localhost:${port}`)
  void launchBrowser()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await browserContext?.close().catch(() => undefined)
      server.close(() => process.exit(0))
    })()
  })
}