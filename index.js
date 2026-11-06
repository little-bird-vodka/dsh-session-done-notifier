/**
 * Session completion notifier — Host half.
 *
 * Watches the Host's session status feed and shows a bottom-right desktop
 * popup when:
 *  - a root session stops running (its turn closed and the Agent waits for
 *    input), or
 *  - a root session calls `ask_user_question` (a structured question or a
 *    plan review waits for the user's answer).
 *
 * The popup is a small WPF window created by a bundled PowerShell helper.
 * It does not use the Windows notification platform, so minimizing the DSH
 * window or hiding it in the tray cannot suppress the reminder.
 *
 * The same plugin carries the settings route used by its Client half: two
 * composer toggles (popup on/off, sound on/off) persist to one JSON file
 * under the Harness home and are read here before every popup.
 */
import { spawn } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const POPUP_SCRIPT = fileURLToPath(new URL('./lib/popup.ps1', import.meta.url))
const SETTINGS_ROUTE = '/session-done-notifier/settings'
const ACTIVATE_ROUTE = '/session-done-notifier/activate'
const PENDING_ROUTE = '/session-done-notifier/pending'
const SETTINGS_HEADER = 'x-session-done-notifier'
const SETTINGS_FILE = 'session-done-notifier.json'
const POPUP_SECONDS = 8
const POPUP_STACK_OFFSET = 116
/** Same-session completions closer than this are folded into one popup. */
const MIN_NOTIFY_INTERVAL_MS = 1500
/** Replays of the same pending request inside this window stay silent. */
const PENDING_DEDUPE_MS = 10 * 60 * 1000
/** A popup click's target Session stays readable for this long. */
const ACTIVATION_TTL_MS = 60 * 1000
/** A turn outcome older than this is stale and must not label a new popup. */
const OUTCOME_TTL_MS = 60 * 1000
const TITLE_LIMIT = 42
const BODY_LIMIT = 120
const PREVIEW_CACHE_LIMIT = 256
const MAX_REQUEST_BYTES = 4096
const QUESTION_TOOL_NAME = 'ask_user_question'

const DEFAULTS = Object.freeze({ enabled: true, sound: true })

const dshHome = (process.env.DSH_HOME ?? '').trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const settingsPath = join(dshHome, SETTINGS_FILE)
/** The popup helper writes the clicked Session here; the focused Client reads it. */
const activationPath = join(tmpdir(), 'dsh-session-done-notifier-activate.json')

/**
 * `sessions` resolves a finishing Agent back to its Session header.
 * `webServer` serves the settings route the Client toggles use.
 * `sessionTitle` and `agents` improve the copy and start-up seeding and are
 * optional, so the plugin still activates without them.
 */
export const inject = ['sessions', 'webServer']

export const COPY = {
  zh: {
    id: 'zh',
    title: (name) => `回复完成 · ${name}`,
    waiting: '回复已完成，等待你的输入。',
    session: 'DSH 会话',
    questionTitle: (name) => `需要你的回答 · ${name}`,
    questionBody: 'DSH 正在等待你回答问题。',
    planTitle: (name) => `计划待确认 · ${name}`,
    planBody: 'DSH 正在等待你确认计划。',
    approvalTitle: (name) => `需要你的确认 · ${name}`,
    approvalBody: (tool) => (tool ? `等待你确认工具调用：${tool}` : 'DSH 正在等待你确认下一步操作。'),
    errorTitle: (name) => `会话出错 · ${name}`,
    errorBody: '本轮模型调用失败，等待你的处理。',
    abortedTitle: (name) => `已中止 · ${name}`,
    abortedBody: '本轮已中止，等待你的输入。',
    abortedByUser: '你已停止本轮。',
    abortedByDispose: '会话已结束。',
    limitTitle: (name) => `输出达到上限 · ${name}`,
    limitBody: '本轮因输出上限结束。',
    blockedTitle: (name) => `本轮被阻止 · ${name}`,
    blockedBody: '本轮未完成，等待你的处理。',
  },
  en: {
    id: 'en',
    title: (name) => `Reply ready · ${name}`,
    waiting: 'The reply is ready; waiting for your input.',
    session: 'DSH session',
    questionTitle: (name) => `Answer needed · ${name}`,
    questionBody: 'DSH is waiting for your answer.',
    planTitle: (name) => `Plan review · ${name}`,
    planBody: 'DSH is waiting for you to approve the plan.',
    approvalTitle: (name) => `Approval needed · ${name}`,
    approvalBody: (tool) => (tool ? `Waiting for your approval of: ${tool}` : 'DSH is waiting for your approval.'),
    errorTitle: (name) => `Session error · ${name}`,
    errorBody: 'The model call failed; the turn needs your attention.',
    abortedTitle: (name) => `Stopped · ${name}`,
    abortedBody: 'The turn was stopped; DSH is waiting for your input.',
    abortedByUser: 'You stopped this turn.',
    abortedByDispose: 'The session ended.',
    limitTitle: (name) => `Output limit · ${name}`,
    limitBody: 'The turn ended at the output limit.',
    blockedTitle: (name) => `Turn blocked · ${name}`,
    blockedBody: 'The turn did not complete and needs your attention.',
  },
}

/**
 * Resolve the operating-system UI language once, without a Host locale
 * dependency: the popup belongs to the desktop, not to the Web UI.
 * @returns {'zh' | 'en'} the message set to use.
 */
function detectLanguage() {
  try {
    return /^zh/iu.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * Collapse whitespace and cut one line to a display budget.
 * @param {unknown} value - candidate text.
 * @param {number} limit - maximum characters.
 * @returns {string} compact text, never longer than `limit`.
 */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}

/**
 * Turn one recorded turn outcome into popup copy. A completed turn keeps the
 * assistant preview; a failed or stopped turn names the outcome instead.
 * @param {any} messages - active locale copy set.
 * @param {string} name - Session display name.
 * @param {{ kind?: string, message?: string } | undefined} outcome - fresh outcome.
 * @returns {{ title: string, body?: string }} popup copy.
 */
export function describeCompletion(messages, name, outcome) {
  switch (outcome?.kind) {
    case 'error':
      return { title: messages.errorTitle(name), body: outcome.message || messages.errorBody, kind: 'error' }
    case 'aborted':
    case 'interrupted':
      return { title: messages.abortedTitle(name), body: outcome.message || messages.abortedBody, kind: 'aborted' }
    case 'max-tokens':
      return { title: messages.limitTitle(name), body: messages.limitBody, kind: 'limit' }
    case 'blocked':
      return { title: messages.blockedTitle(name), body: messages.blockedBody, kind: 'blocked' }
    default:
      return { title: messages.title(name), kind: 'completed' }
  }
}

/**
 * Extract the visible text of one committed assistant message.
 * @param {unknown} message - `assistant/message` payload.
 * @returns {string} joined text blocks, or an empty string for tool-only replies.
 */
function assistantText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return clip(text, BODY_LIMIT)
}

/**
 * Coerce one stored or supplied settings record into the accepted shape.
 * @param {unknown} value - candidate settings.
 * @returns {{ enabled: boolean, sound: boolean }} normalized settings.
 */
function normalizeSettings(value) {
  const record = value !== null && typeof value === 'object' ? value : {}
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULTS.enabled,
    sound: typeof record.sound === 'boolean' ? record.sound : DEFAULTS.sound,
  }
}

/**
 * Read the persisted settings, falling back to the defaults for a missing or
 * malformed file. A broken file must never disable the reminder silently.
 * @returns {{ enabled: boolean, sound: boolean }} current settings.
 */
function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Write one JSON response for the settings route.
 * @param {import('node:http').ServerResponse} response - route response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON body.
 */
function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger('session-done-notifier')

  if (process.platform !== 'win32') {
    logger.info('desktop popups are only implemented for Windows; the notifier stays idle')
    return
  }

  const powershell = `${process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const copy = COPY[detectLanguage()]
  const titles = ctx.get('sessionTitle')
  let settings = loadSettings()

  /** Sessions observed running that still owe one completion popup. */
  const running = new Set()
  /** Latest assistant text per Session, captured incrementally from the log feed. */
  const previews = new Map()
  /** Last popup time per Session, used to fold duplicate status flaps. */
  const lastNotified = new Map()
  /** Pending questions already announced, keyed by Session and Tool call. */
  const pendingSeen = new Map()
  /** Latest completed Turn outcome per Session, consumed by its completion popup. */
  const outcomes = new Map()
  /** Live popup helpers, so plugin unload does not leave orphans. */
  const helpers = new Set()
  /** Stack index for popups that arrive together. */
  let popupSlot = 0
  let lastPopupAt = 0
  let disposed = false

  // A plugin reload during a running turn must still notify when that turn
  // ends, so seed the observation set from the live Agent roster.
  const agents = ctx.get('agents')
  if (agents !== undefined) {
    for (const agent of agents.list()) {
      if (agent?.status === 'running') running.add(agent.id)
    }
  }

  /**
   * Persist the settings record next to the Harness home.
   * @param {{ enabled: boolean, sound: boolean }} next - settings to store.
   */
  async function persistSettings(next) {
    await fs.mkdir(dirname(settingsPath), { recursive: true })
    const temporary = `${settingsPath}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, settingsPath)
  }

  /**
   * Read one bounded JSON request body.
   * @param {import('node:http').IncomingMessage} request - route request.
   * @returns {Promise<unknown>} parsed JSON.
   */
  async function readJsonBody(request) {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > MAX_REQUEST_BYTES) throw new Error('payload too large')
    }
    return JSON.parse(body)
  }

  /**
   * Apply the Host's browser-trust checks to one plugin route. A composition
   * without Connection cannot authenticate the caller, so it refuses instead
   * of falling back to a header or loopback check.
   * @param {import('node:http').IncomingMessage} request - route request.
   * @param {import('node:http').ServerResponse} response - route response.
   * @returns {boolean} whether the request was rejected.
   */
  function rejectUntrusted(request, response) {
    const connection = ctx.get('connection')
    if (connection === undefined) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('connection service unavailable')
      return true
    }
    const rejection = connection.requestRejection({ headers: request.headers })
    if (rejection !== undefined) {
      response.writeHead(rejection)
      response.end()
      return true
    }
    return false
  }

  /**
   * Read and consume the Session a popup click asked the Client to reopen.
   * The popup helper writes this file; no unauthenticated route accepts it.
   * @param {import('node:http').IncomingMessage} request - route request.
   * @param {import('node:http').ServerResponse} response - route response.
   */
  async function handleActivateRequest(request, response) {
    if (rejectUntrusted(request, response)) return
    if (request.headers[SETTINGS_HEADER] !== '1') {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    try {
      const raw = await fs.readFile(activationPath, 'utf8')
      await fs.rm(activationPath, { force: true })
      const value = JSON.parse(raw)
      const at = Number(value?.at)
      if (typeof value?.sessionId !== 'string' || value.sessionId === '' || !Number.isFinite(at) || Date.now() - at > ACTIVATION_TTL_MS) {
        sendJson(response, 200, {})
        return
      }
      sendJson(response, 200, { sessionId: value.sessionId })
    } catch {
      sendJson(response, 200, {})
    }
  }

  /**
   * Client-reported pending approval. Questions use the Session log instead;
   * the approval waterfall is claimed by the Client answerer before any Host
   * listener can observe it.
   * @param {import('node:http').IncomingMessage} request - route request.
   * @param {import('node:http').ServerResponse} response - route response.
   */
  async function handlePendingRequest(request, response) {
    if (rejectUntrusted(request, response)) return
    if (request.headers[SETTINGS_HEADER] !== '1') {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch {
      sendJson(response, 400, { error: 'invalid JSON' })
      return
    }
    if (body?.kind !== 'approval' || !settings.enabled) {
      sendJson(response, 200, { shown: false })
      return
    }
    const session = rootSession(body.sessionId)
    if (session === undefined) {
      sendJson(response, 200, { shown: false })
      return
    }
    const identity = typeof body.callId === 'string' && body.callId !== ''
      ? body.callId
      : `${String(body.toolName ?? '')}|${String(body.reason ?? '')}`
    if (!firstPending(`approval|${session.id}|${identity}`)) {
      sendJson(response, 200, { shown: false, duplicate: true })
      return
    }

    const display = body.displayReason
    const reason = display !== null && typeof display === 'object'
      ? (display[copy.id] ?? display['zh-CN'] ?? display.en)
      : body.reason
    const name = sessionName(session)
    const text = typeof reason === 'string' && reason !== ''
      ? clip(reason, BODY_LIMIT)
      : copy.approvalBody(typeof body.toolName === 'string' ? body.toolName : '')
    showPopup(copy.approvalTitle(name), text, settings.sound, session.id, 'approval')
    sendJson(response, 200, { shown: true })
  }

  /**
   * Serve the Client half's settings reads and writes. The custom header
   * keeps cross-site form posts from flipping a local preference; the route
   * itself is loopback-only because the Host binds loopback.
   * @param {import('node:http').IncomingMessage} request - route request.
   * @param {import('node:http').ServerResponse} response - route response.
   */
  async function handleSettingsRequest(request, response) {
    if (rejectUntrusted(request, response)) return
    if (request.headers[SETTINGS_HEADER] !== '1') {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    if (request.method === 'GET') {
      sendJson(response, 200, settings)
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' })
      response.end()
      return
    }

    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > MAX_REQUEST_BYTES) {
        sendJson(response, 413, { error: 'payload too large' })
        return
      }
    }

    let patch
    try {
      patch = JSON.parse(body)
    } catch {
      sendJson(response, 400, { error: 'invalid JSON' })
      return
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      sendJson(response, 400, { error: 'settings must be an object' })
      return
    }

    const next = normalizeSettings({ ...settings, ...patch })
    try {
      await persistSettings(next)
    } catch (error) {
      logger.warn(`could not save settings: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(response, 500, { error: 'could not save settings' })
      return
    }
    settings = next
    sendJson(response, 200, settings)
  }

  /**
   * Next vertical offset for a popup that arrives while another one is fresh.
   * @returns {number} offset in device-independent pixels.
   */
  function nextPopupOffset() {
    const now = Date.now()
    popupSlot = now - lastPopupAt > POPUP_SECONDS * 1000 ? 0 : (popupSlot + 1) % 3
    lastPopupAt = now
    return popupSlot * POPUP_STACK_OFFSET
  }

  /**
   * Show one popup through the bundled helper.
   * @param {string} title - first line.
   * @param {string} body - second line.
   * @param {boolean} sound - whether the helper plays the notification sound.
   * @param {string | undefined} sessionId - Session to reopen when clicked.
   * @param {string} kind - icon kind shown in the popup.
   */
  function showPopup(title, body, sound, sessionId, kind = 'completed') {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      POPUP_SCRIPT,
      '-Title',
      title,
      '-Body',
      body,
      '-Seconds',
      String(POPUP_SECONDS),
      '-Offset',
      String(nextPopupOffset()),
      '-Kind',
      kind,
    ]
    if (typeof sessionId === 'string' && sessionId !== '') {
      args.push('-SessionId', sessionId, '-ActivationFile', activationPath)
    }
    if (sound) args.push('-Sound')

    let helper
    try {
      helper = spawn(powershell, args, { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      logger.warn(`could not start the popup helper: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    helpers.add(helper)
    helper.on('error', (error) => {
      helpers.delete(helper)
      logger.warn(`popup helper failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    helper.on('exit', (code) => {
      helpers.delete(helper)
      if (code !== null && code !== 0) logger.warn(`popup helper exited with code ${code}`)
    })
  }

  /**
   * Resolve the live root Session for a status update; subagents and Sessions
   * that left the store stay silent.
   * @param {unknown} sessionId - candidate Session identity.
   * @returns {import('@deepseek-ai/dsh-session').Session | undefined} root Session.
   */
  function rootSession(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return undefined
    const header = session.header
    if (header?.parentSession !== undefined || header?.origin === 'subagent') return undefined
    return session
  }

  /**
   * @param {import('@deepseek-ai/dsh-session').Session} session - root Session.
   * @returns {string} display name for a popup title.
   */
  function sessionName(session) {
    return clip(titles?.get(session)?.title || copy.session, TITLE_LIMIT)
  }

  /**
   * One announcement per pending request. A replay of the same Tool call stays
   * silent.
   * @param {string} key - kind, Session, and request identity.
   * @returns {boolean} whether this request is new.
   */
  function firstPending(key) {
    const now = Date.now()
    if (now - (pendingSeen.get(key) ?? 0) < PENDING_DEDUPE_MS) return false
    pendingSeen.set(key, now)
    if (pendingSeen.size > 64) {
      for (const [item, time] of pendingSeen) {
        if (now - time > PENDING_DEDUPE_MS) pendingSeen.delete(item)
      }
    }
    return true
  }

  /**
   * Record how the just-closed Turn ended. The completion popup reads this to
   * distinguish a finished reply from a failed or stopped turn.
   * @param {string} sessionId - Session whose turn closed.
   * @param {unknown} reason - `turn/end` reason payload.
   */
  function recordOutcome(sessionId, reason) {
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
    let message
    if (kind === 'error') {
      message = reason?.error?.message || reason?.error?.code
    } else if (kind === 'aborted' || kind === 'interrupted') {
      const cause = reason?.reason?.kind
      if (cause === 'user') message = copy.abortedByUser
      else if (cause === 'disposed') message = copy.abortedByDispose
    }
    outcomes.set(sessionId, {
      kind,
      message: typeof message === 'string' && message !== '' ? message : undefined,
      at: Date.now(),
    })
    if (outcomes.size > 64) {
      for (const [item, value] of outcomes) {
        if (Date.now() - value.at > OUTCOME_TTL_MS) outcomes.delete(item)
      }
    }
  }

  /**
   * Turn one finishing root Session into a popup.
   * @param {string} sessionId - Session that just stopped running.
   */
  function notifyCompletion(sessionId) {
    if (!settings.enabled) return
    const session = rootSession(sessionId)
    if (session === undefined) return

    const now = Date.now()
    if (now - (lastNotified.get(sessionId) ?? 0) < MIN_NOTIFY_INTERVAL_MS) return
    lastNotified.set(sessionId, now)

    const recorded = outcomes.get(sessionId)
    outcomes.delete(sessionId)
    const outcome = recorded !== undefined && now - recorded.at <= OUTCOME_TTL_MS ? recorded : undefined
    const described = describeCompletion(copy, sessionName(session), outcome)
    const preview = previews.get(sessionId)
    previews.delete(sessionId)
    showPopup(described.title, clip(described.body ?? preview ?? copy.waiting, BODY_LIMIT), settings.sound, session.id, described.kind)
  }

  /**
   * Announce an `ask_user_question` call before it starts waiting. The Tool
   * call is committed to the Session log before execution, so this does not
   * depend on the question waterfall's answerer order.
   * @param {import('@deepseek-ai/dsh-session').Session} session - calling Session.
   * @param {{ data?: { callId?: string, arguments?: string } }} event - `tool/call` event.
   */
  function notifyQuestionCall(session, event) {
    if (!settings.enabled) return
    const root = rootSession(session?.id)
    if (root === undefined) return

    const callId = event?.data?.callId ?? ''
    if (!firstPending(`question|${root.id}|${callId}`)) return

    let questions = []
    const raw = event?.data?.arguments
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed?.questions)) questions = parsed.questions
      } catch {
        // Malformed arguments keep the generic copy.
      }
    }

    const plan = questions.some((item) => item?.intent?.kind === 'plan-review')
    const first = questions[0]
    const preview = first?.question || first?.header
    const name = sessionName(root)
    const title = plan ? copy.planTitle(name) : copy.questionTitle(name)
    const body = preview ? clip(preview, BODY_LIMIT) : (plan ? copy.planBody : copy.questionBody)
    showPopup(title, body, settings.sound, root.id, plan ? 'plan' : 'question')
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: handleSettingsRequest }),
    'session-done-notifier: settings route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ACTIVATE_ROUTE, handler: handleActivateRequest }),
    'session-done-notifier: activation route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PENDING_ROUTE, handler: handlePendingRequest }),
    'session-done-notifier: pending approval route',
  )

  ctx.effect(() => {
    const offStatus = ctx.on('api-session/status', (sessionId, isRunning) => {
      if (typeof sessionId !== 'string') return
      if (isRunning) {
        running.add(sessionId)
        return
      }
      if (!running.delete(sessionId) || disposed) return
      notifyCompletion(sessionId)
    })

    const offSessionEvent = ctx.on('session/event', (session, event) => {
      if (event?.type === 'turn/end') {
        recordOutcome(session.id, event.data?.reason)
        return
      }
      if (event?.type === 'tool/call') {
        if (event.data?.name === QUESTION_TOOL_NAME) {
          try {
            notifyQuestionCall(session, event)
          } catch (error) {
            logger.warn(`question notification failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return
      }
      if (event?.type !== 'assistant/message') return
      const text = assistantText(event.data?.message)
      if (text === '') return
      previews.set(session.id, text)
      if (previews.size > PREVIEW_CACHE_LIMIT) {
        const oldest = previews.keys().next().value
        if (oldest !== undefined) previews.delete(oldest)
      }
    })

    return () => {
      disposed = true
      offStatus()
      offSessionEvent()
      running.clear()
      previews.clear()
      lastNotified.clear()
      pendingSeen.clear()
      outcomes.clear()
      for (const helper of helpers) {
        try {
          helper.kill()
        } catch {
          // The helper already exited between iteration and kill.
        }
      }
      helpers.clear()
    }
  }, 'session-done-notifier: completion and question popups')
}
