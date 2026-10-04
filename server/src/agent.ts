export type ModelSettings = {
  provider: 'openrouter' | 'groq' | 'local'
  baseUrl: string
  model: string
  apiKey?: string
}

export type BrowserAction = {
  action: 'go_to_url' | 'click' | 'type_text' | 'press_key' | 'scroll' | 'wait' | 'extract_text' | 'ask_user' | 'finish'
  safety: { level: 'safe' | 'critical'; reason: string }
  url?: string
  element?: number
  text?: string
  pressEnter?: boolean
  key?: string
  direction?: 'up' | 'down'
  amount?: number
  seconds?: number
  summary?: string
}

export type AgentEvent = {
  type: 'step' | 'summary'
  description: string
  status: 'thinking' | 'running' | 'waiting' | 'done' | 'denied' | 'failed'
  interaction?: 'approval' | 'login' | 'question'
  timestamp: number
  step?: number
}

export type AgentStep = {
  number: number
  action: BrowserAction | null
  result: string
  timestamp: number
}

type AgentOptions = {
  task: string
  settings: ModelSettings
  signal: AbortSignal
  observe: () => Promise<string>
  execute: (action: BrowserAction) => Promise<string>
  assess: (action: BrowserAction, observation: string) => Promise<{ critical: boolean; reason: string; target: string; requiresLogin: boolean; loggedIn: boolean }>
  requestApproval: (action: BrowserAction, reason: string, target: string) => Promise<boolean>
  emit: (event: AgentEvent) => void
  saveStep: (step: AgentStep) => void
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abortHandler: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(new Error('Task stopped by user.'))
    if (signal.aborted) abortHandler()
    else signal.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

const actionSchema = {
  type: 'function',
  function: {
    name: 'browser_action',
    description: 'Perform exactly one browser action for the current step.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['go_to_url', 'click', 'type_text', 'press_key', 'scroll', 'wait', 'extract_text', 'ask_user', 'finish'] },
        safety: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['safe', 'critical'] },
            reason: { type: 'string', description: 'Why this action is safe or critical.' },
          },
          required: ['level', 'reason'],
          additionalProperties: false,
        },
        url: { type: 'string', description: 'HTTP or HTTPS URL to open.' },
        element: { type: 'integer', description: 'Number of a visible element in the observation.' },
        text: { type: 'string', description: 'Text to type, extraction instruction, or question for the user.' },
        pressEnter: { type: 'boolean' },
        key: { type: 'string', description: 'Keyboard key, for example Enter, Escape, or Tab.' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer', description: 'Scroll distance in pixels.' },
        seconds: { type: 'number', description: 'Wait duration, at most 10 seconds.' },
        summary: { type: 'string', description: 'Short final result for the user.' },
      },
      required: ['action', 'safety'],
      additionalProperties: false,
    },
  },
}

function completionUrl(settings: ModelSettings) {
  return `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`
}

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Task stopped by user.'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Task stopped by user.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function rateLimitRetryDelay(response: Response, detail: string) {
  const retryAfter = response.headers.get('retry-after')
  const retryAfterDate = retryAfter ? Date.parse(retryAfter) : Number.NaN
  const headerSeconds = retryAfter && Number.isFinite(Number(retryAfter))
    ? Number(retryAfter)
    : Number.isFinite(retryAfterDate)
      ? Math.max(0, (retryAfterDate - Date.now()) / 1000)
      : 0
  const messageSeconds = detail.match(/try again in\s+([\d.]+)\s*(?:s|sec|seconds?)\b/i)
  const seconds = Math.max(headerSeconds, messageSeconds ? Number(messageSeconds[1]) : 0)
  return Math.max(22_000, Math.ceil(seconds * 1000))
}

async function requestCompletion(settings: ModelSettings, messages: Array<Record<string, unknown>>, signal: AbortSignal) {
  const promptCharacters = messages.reduce((total, message) => total + (typeof message.content === 'string' ? message.content.length : 0), 0)
  console.info(`[browser-pilot] Sending model request (${messages.length} messages, ${promptCharacters} prompt characters).`)
  const sendRequest = () => fetch(completionUrl(settings), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      ...(settings.provider === 'openrouter' ? { 'http-referer': 'http://localhost:5173', 'x-title': 'Browser Pilot' } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools: [actionSchema],
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 1200,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
  })
  let response = await sendRequest()
  if (response.status === 429) {
    const limitedBody = await response.json().catch(() => null) as { error?: { message?: string } | string } | null
    const detail = typeof limitedBody?.error === 'string' ? limitedBody.error : limitedBody?.error?.message
    const delay = rateLimitRetryDelay(response, detail ?? '')
    console.warn(`[browser-pilot] Model rate limited; retrying once in ${Math.ceil(delay / 1000)}s.`)
    await waitForRetry(delay, signal)
    response = await sendRequest()
  }
  const body = await response.json().catch(() => null) as { error?: { message?: string } | string; choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> } }> } | null
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : body?.error?.message
    throw new Error(detail || `Model request failed with HTTP ${response.status}.`)
  }
  return body?.choices?.[0]?.message
}

export async function testModelConnection(settings: ModelSettings) {
  const controller = new AbortController()
  const response = await fetch(completionUrl(settings), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      ...(settings.provider === 'openrouter' ? { 'http-referer': 'http://localhost:5173', 'x-title': 'Browser Pilot' } : {}),
    },
    body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 12 }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
  })
  const body = await response.json().catch(() => null) as { error?: { message?: string } | string; choices?: Array<{ message?: { content?: string } }> } | null
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : body?.error?.message
    throw new Error(detail || `Model request failed with HTTP ${response.status}.`)
  }
  return body?.choices?.[0]?.message?.content?.trim() || 'Connected; the model returned an empty response.'
}

function validateAction(value: unknown): BrowserAction | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const action = source.parameters && typeof source.parameters === 'object'
    ? { ...source.parameters as Record<string, unknown>, action: source.action ?? source.name }
    : source
  const names: BrowserAction['action'][] = ['go_to_url', 'click', 'type_text', 'press_key', 'scroll', 'wait', 'extract_text', 'ask_user', 'finish']
  if (!names.includes(action.action as BrowserAction['action'])) return null
  if (!action.safety || typeof action.safety !== 'object') return null
  const safety = action.safety as Record<string, unknown>
  if (!['safe', 'critical'].includes(String(safety.level)) || typeof safety.reason !== 'string' || !safety.reason.trim()) return null
  if (typeof action.element === 'string' && /^\d+$/.test(action.element)) action.element = Number(action.element)
  if (action.action === 'go_to_url' && typeof action.url !== 'string') return null
  if (['click', 'type_text'].includes(String(action.action)) && !Number.isInteger(action.element)) return null
  if (action.action === 'type_text' && typeof action.text !== 'string') return null
  if (action.action === 'press_key' && typeof action.key !== 'string') return null
  if (action.action === 'ask_user' && typeof action.text !== 'string') return null
  if (action.action === 'finish' && typeof action.summary !== 'string') return null
  return action as unknown as BrowserAction
}

async function nextAction(settings: ModelSettings, messages: Array<Record<string, unknown>>, signal: AbortSignal) {
  let reminder = ''
  let finalText: string | null | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const message = await requestCompletion(settings, reminder ? [...messages, { role: 'user', content: reminder }] : messages, signal)
    finalText = message?.content
    const argumentsText = message?.tool_calls?.[0]?.function?.arguments
    if (argumentsText) {
      try {
        const action = validateAction(JSON.parse(argumentsText))
        if (action) return action
      } catch {
        // Retry malformed tool arguments once before falling back to text.
      }
    }
    if (attempt === 0) reminder = 'Your previous response did not contain one valid browser_action tool call. Retry now with exactly one valid tool call and the required fields.'
  }
  const excerpt = finalText?.trim().slice(0, 240)
  throw new Error(`The model did not return a valid browser action with a safety assessment after one retry.${excerpt ? ` Response: ${excerpt}` : ' The response was empty; check that the model supports tool calling.'}`)
}

export async function runAgent(options: AgentOptions) {
  const { task, settings, signal, observe, execute, assess, requestApproval, emit, saveStep } = options
  const history: Array<{ role: string; content: string }> = []
  emit({ type: 'step', description: 'Understanding the task and inspecting the page', status: 'thinking', timestamp: Date.now(), step: 0 })

  for (let number = 1; number <= 40; number += 1) {
    if (signal.aborted) throw new Error('Task stopped by user.')
    const observation = await raceAbort(observe(), signal)
    emit({ type: 'step', description: `Choosing step ${number}`, status: 'thinking', timestamp: Date.now(), step: number })
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'system',
        content: 'You are Browser Pilot, an autonomous web browser agent. The user asks you to accomplish a task in the current browser. At each turn you receive a fresh text observation with the current URL, title, visible page text, and numbered visible elements. Choose exactly one browser_action tool call per step. Every action MUST include safety.level ("safe" or "critical") and a non-empty safety.reason based on what the action will do; assess conservatively. Runtime rules independently classify actions too. If approval is denied, do not repeat that action or attempt an equivalent workaround; choose another safe approach or explain the limitation. Before assuming login is needed, inspect the page for signs of an existing session such as account/profile menus, versus sign-in/log-in buttons or credential fields. Never ask for or enter passwords, passcodes, one-time codes, or other credentials. If a task requires sign-in, call ask_user with a clear request for the user to sign in in the browser window; wait for the user to continue, then inspect the page again. Use ask_user for necessary non-sensitive questions such as demographic preferences. Use element numbers from the latest observation for click and type_text. If a click fails because another element blocks it, inspect the new observation and handle the visible blocker or choose another appropriate target; do not click hidden elements or repeat the same blocked click. Navigate only to HTTP/HTTPS URLs. Never repeat a successful action; after successful navigation inspect the current observation and continue. Handle errors by adapting. Use extract_text to gather details, and finish with a concise factual summary once the task is done. Never claim an action succeeded unless its result says so. You have at most 40 steps.',
      },
      ...history.slice(-6).map((entry) => ({
        ...entry,
        content: entry.content.length > 1800 ? `${entry.content.slice(0, 1800)}\n[Earlier result truncated]` : entry.content,
      })),
      { role: 'user', content: `Task: ${task}\n\nCurrent observation:\n${observation}` },
    ]
    let action: BrowserAction
    try {
      action = await raceAbort(nextAction(settings, messages, signal), signal)
    } catch (error) {
      if (signal.aborted) throw new Error('Task stopped by user.')
      emit({ type: 'step', description: error instanceof Error ? error.message : 'Could not get a valid action from the model.', status: 'failed', timestamp: Date.now(), step: number })
      throw error
    }
    if (signal.aborted) throw new Error('Task stopped by user.')
    let assessment = await raceAbort(assess(action, observation), signal)
    if (action.action === 'ask_user' && /\b(sign in|log in)\b/i.test(action.text ?? '') && assessment.loggedIn) {
      const result = 'The page already shows an active account menu. Do not ask the user to sign in; continue with the task.'
      const timestamp = Date.now()
      emit({ type: 'step', description: 'The page already appears signed in, so the sign-in request was skipped.', status: 'done', timestamp, step: number })
      saveStep({ number, action, result, timestamp })
      history.push({ role: 'assistant', content: JSON.stringify(action) }, { role: 'user', content: `Action result: ${result}` })
      continue
    }
    if (['click', 'type_text', 'press_key'].includes(action.action) && assessment.requiresLogin) {
      action = {
        action: 'ask_user',
        text: 'Please sign in to the website in the browser window, then click Continue here.',
        safety: { level: 'safe', reason: 'The user will complete sign-in directly in the browser; Browser Pilot will not handle credentials.' },
      }
      assessment = await raceAbort(assess(action, observation), signal)
    } else if (action.action === 'ask_user' && /\b(password|passcode|one[- ]time code|verification code|login code|credentials?|security code|pin)\b/i.test(action.text ?? '')) {
      action = {
        action: 'ask_user',
        text: 'Please sign in to the website in the browser window, then click Continue here.',
        safety: { level: 'safe', reason: 'The user will complete sign-in directly in the browser; Browser Pilot will not handle credentials.' },
      }
      assessment = await raceAbort(assess(action, observation), signal)
    }
    if (action.action !== 'finish' && assessment.critical) {
      const reasons = [assessment.reason, action.safety.level === 'critical' ? action.safety.reason : ''].filter(Boolean)
      const approved = await raceAbort(requestApproval(action, reasons.join(' Model assessment: '), assessment.target), signal)
      if (!approved) {
        const timestamp = Date.now()
        const result = 'Approval denied. The action was skipped; choose a different approach without repeating it.'
        saveStep({ number, action, result, timestamp })
        history.push({ role: 'assistant', content: JSON.stringify(action) }, { role: 'user', content: `Action result: ${result}` })
        continue
      }
    }
    if (action.action === 'finish') {
      const summary = action.summary || 'Task finished.'
      emit({ type: 'summary', description: summary, status: 'done', timestamp: Date.now(), step: number })
      saveStep({ number, action, result: summary, timestamp: Date.now() })
      return summary
    }
    const label = action.action.replaceAll('_', ' ')
    emit({ type: 'step', description: `Step ${number}: ${label}`, status: 'running', timestamp: Date.now(), step: number })
    let result: string
    try {
      result = await raceAbort(execute(action), signal)
    } catch (error) {
      if (signal.aborted) throw new Error('Task stopped by user.')
      result = `Action failed: ${error instanceof Error ? error.message : String(error)}`
    }
    const timestamp = Date.now()
    saveStep({ number, action, result, timestamp })
    emit({ type: 'step', description: `Step ${number}: ${result}`, status: result.startsWith('Action failed:') ? 'failed' : 'done', timestamp, step: number })
    history.push({ role: 'assistant', content: JSON.stringify(action) }, { role: 'user', content: `Action result: ${result}` })
  }

  const summary = 'Stopped after reaching the 40-step limit.'
  emit({ type: 'summary', description: summary, status: 'failed', timestamp: Date.now(), step: 40 })
  return summary
}