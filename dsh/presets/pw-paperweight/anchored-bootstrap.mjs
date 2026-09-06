/**
 * Anchored tool bootstrap for router-flash (deepseek-v4-flash, opencode-go).
 *
 * Mechanism borrowed from xiaobright/dsh-anchored-standard (tool-bootstrap.mjs
 * + compaction-epoch.mjs, issues #6/#11 evidence), adapted for Flash: keep the
 * FIRST model request on the official Minimal preset's REAL tool schema
 * (persistent `bash` + `str_replace_editor`), free of auto-injected
 * workspace/skill context, then narrow the catalog to a minimal RESIDENT set
 * once the session has produced its first durable promotion signal.
 *
 * Why this replaces the old router-bootstrap.mjs "weak" routing: the previous
 * logic forced every Flash model into the WEAK_FLASH persona and a
 * `read/write/edit` first-request tool schema. A standard-family first-request
 * schema is exactly the condition that produces the standard-like
 * "The user…/Let me…" trajectory; only the Minimal pair anchored the deep
 * "We need…" trajectory in the reproduction work (5/5 vs 11/11), and injected
 * reminders (skill catalog, AGENTS.md digest) suppressed it entirely (0/9).
 * No weak persona is injected anymore: the persona row in agent.cordis.yml is
 * byte-identical to the official Minimal preset.
 *
 * The phase is derived from durable session events, so resume and reload
 * preserve it. By default (`promoteOn: 'either'`) a session promotes after the
 * first `tool/call` OR the first `assistant/message`, whichever comes first:
 * request #1 always sees the bootstrap catalog and request #2 always sees the
 * resident catalog.
 *
 * First-request levers established by the reproduction work (issues #6/#11):
 *
 *  1. Tool schema (decisive at the adapter-default maxTokens): the Minimal
 *     pair anchored 5/5 with zero `let me` first-lines; every standard-family
 *     schema fell standard-like 11/11.
 *  2. Output budget: a 1024 first-request cap also anchors, but the Minimal
 *     schema anchors WITHOUT any cap — `bootstrapMaxTokens` stays opt-in so
 *     the first reasoning block keeps its full depth.
 *  3. Injected reminders: the AGENTS.md digest (`agent-instructions`) and the
 *     available-skills reminder (`skill-catalog`) are stripped during
 *     bootstrap and allowed again from request #2 on.
 *
 * POST-PROMOTION RESIDENT SET: the promoted phase does NOT dump the whole
 * Standard catalog at once — that dump pulls the trajectory back to
 * standard-like behavior. The catalog narrows to the bootstrap pair plus the
 * discovery tool (`dev_tool_search`) plus whatever the model explicitly
 * unlocked. Unlocked names derive from durable `tool/call` events, so resume
 * and reload keep them.
 *
 * COMPACTION: promotion is epoch-aware — after `compaction/end` the session
 * falls back to the controlled phase (bootstrap pair plus `compactionTools`)
 * until a NEW durable promotion signal exists past that boundary.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process.
 *  - Subagents (delegationDepth > 0) are always promoted (resident catalog).
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of throwing.
 *  - The pre-step context filter degrades to "keep everything" on failure.
 *  - Invalid config fails at apply time (preset mount), where it is visible.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Applying without an inject — combined with this row being FIRST in
 * agent.cordis.yml — registers the plugin before dsh-agent-instructions and
 * dsh-tool-skill, and waterfall after-next transforms apply in reverse
 * registration order, so the first-request strip below is the LAST transform.
 * The pre-step listener additionally registers with `prepend: true` so the
 * strip stays the outermost transform even against host-plane listeners.
 */
export const inject = []

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'suppressedContextSources', 'compactionTools', 'promotedCatalog'])

/**
 * Context sources stripped from the first request by default. Both are
 * automatic `agent/pre-step` injections: the available-skills reminder
 * (`skill-catalog`) and the AGENTS.md/CLAUDE.md workspace digest
 * (`agent-instructions`). True Minimal mounts neither on request #1.
 */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/**
 * The default first-request catalog: the OFFICIAL Minimal preset's exact tool
 * pair — the persistent `bash` shell and `str_replace_editor`.
 */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search']

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the suppressed context sources. An explicitly empty array is
 * meaningful: it disables the context filter while keeping the tool bootstrap.
 */
function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/**
 * Epoch-aware promotion tracker (mechanism from dsh-anchored-standard's
 * compaction-epoch.mjs): only a durable promotion signal recorded AFTER the
 * last `compaction/end` boundary counts as promoted. State is memoized per
 * session id; a cold session scans its durable log once (resume-safe).
 */
function createEpochPromotion(promoteEvents) {
  const promote = new Set(promoteEvents)
  const state = new Map()

  const scan = (session) => {
    let boundary = -1
    let promoted = false
    for (const event of session.events) {
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        boundary = seq
        promoted = false
        continue
      }
      if (promote.has(event.type) && seq > boundary) promoted = true
    }
    const entry = { boundary, promoted }
    state.set(session.id, entry)
    return entry
  }

  return {
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = agent.session
      if (session === undefined) return { boundary: -1, promoted: true }
      // Subagents keep the resident catalog from their very first request.
      if ((session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      return state.get(session.id) ?? scan(session)
    },
    observe(session, event) {
      const entry = state.get(session.id)
      if (entry === undefined) return
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        state.set(session.id, { boundary: seq, promoted: false })
        return
      }
      if (promote.has(event.type) && seq > entry.boundary && !entry.promoted) {
        state.set(session.id, { ...entry, promoted: true })
      }
    },
  }
}

/**
 * Validate the promoted-phase catalog mode:
 *  - 'resident' — bootstrap pair + discovery tools + unlocked names (the
 *    anchored-standard default; keeps later turns on the anchored trajectory).
 *  - 'full'     — the complete assembled catalog from request #2 on (the
 *    original router-flash "放开全目录" behavior). The first-request anchor is
 *    unaffected; only later-turn style persistence differs.
 */
function parsePromotedCatalog(value) {
  if (value === undefined || value === 'resident') return 'resident'
  if (value === 'full') return 'full'
  throw new TypeError(`${name}: promotedCatalog must be "resident" or "full"; got ${JSON.stringify(value)}`)
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }
  const bootstrapTools = stringList(source.bootstrapTools, 'bootstrapTools')
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(source.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')
  const promotedCatalog = parsePromotedCatalog(source.promotedCatalog)

  const promotion = createEpochPromotion(promoteEvents)
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of session.events) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
    }
    return unlocked
  }

  /** Narrow the assembled catalog to a keep-set; validate required names. */
  const keepTools = (assembled, keep, missingAllowsFullCatalog) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...keep].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // FULL mode: the complete assembled catalog from request #2 on — the
        // original router-flash "放开全目录" behavior; the first-request anchor
        // is untouched because request #1 already left the bootstrap phase.
        if (promotedCatalog === 'full') return assembled
        // RESIDENT mode (anchored-standard default): keep the minimal resident
        // set — the bootstrap pair + the discovery tool + whatever the model
        // explicitly unlocked — instead of dumping the whole Standard catalog
        // at once.
        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session)])
        return keepTools(assembled, keep, false)
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      return keepTools(assembled, keep, true)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset means the adapter default flows — the Minimal tool schema anchors at
  // the adapter default without a cap, and Flash keeps its full first-reasoning
  // depth, which is the point of the godmode goal.
  if (bootstrapMaxTokens !== undefined) {
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }

  // Strip first-step injected reminders (skill catalog, AGENTS.md) during
  // bootstrap. `prepend` keeps this strip the outermost transform so it
  // actually removes what later listeners inject.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotion.status(agent).promoted || suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
