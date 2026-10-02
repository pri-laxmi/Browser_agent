import express from 'express'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { WebSocket, WebSocketServer } from 'ws'

const port = Number(process.env.PORT ?? 3001)
const profilePath = resolve(process.cwd(), '.browser-profile')
const app = express()
const server = createServer(app)
const webSocketServer = new WebSocketServer({ server })

let browserContext: BrowserContext | null = null
let activePage: Page | null = null
let browserError: string | null = null
let captureInProgress = false

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