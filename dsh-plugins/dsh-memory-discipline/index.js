/**
 * dsh-memory-discipline — memory-usage discipline as an installable DeepSeek
 * Harness plugin, generic over any memory tool family (MemOS, mem0, zep, a
 * custom MCP server, or a plain registered tool):
 *
 * 1. A stable system-prompt section (`ctx.systemPrompt.section()`) states the
 *    memory-routing discipline. The text is a pure function of the validated
 *    config, so it is byte-identical on every request (KV-cache friendly).
 * 2. When `autoFetch` is on, an `agent/session-start` listener claims the
 *    agent's idle maintenance phase (`agent.runMaintenance()`), waits a
 *    bounded budget for the configured hot-context tool to register
 *    (MCP discovery is asynchronous), executes it once through
 *    `ctx.tools.execute()`, and injects the result via `agent.inject()` as a
 *    plugin-sourced `notice` UserMessage. Injection rides the inbox, so it is
 *    durably logged (`agent/inbox/spliced`) and claimed by the first step —
 *    the maintenance phase latches the wake of any prompt that arrives while
 *    fetching, which makes first-step delivery deterministic.
 * 3. Any failure (tool never registers, tool errors, timeout) degrades to a
 *    short English "memory unavailable" notice; the session never fails.
 *
 * Config is validated fail-loud at plugin load in `discipline.js`.
 *
 * Runtime bare imports (`@deepseek-ai/dsh-llm`) resolve through the harness
 * profile fallback; they are deliberately NOT npm dependencies.
 *
 * @module dsh-memory-discipline
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  buildHotContextNotice,
  buildMemoryUnavailableNotice,
  extractResultText,
  renderPolicyText,
  validateConfig,
} from './discipline.js'

export const name = 'memory-discipline'

export const inject = ['tools', 'systemPrompt']

/** System-prompt section name registered by this plugin (unique per scope layer). */
const SECTION_NAME = 'memory-discipline'

/**
 * Render one thrown value as a short English diagnostic.
 *
 * @param {unknown} error - thrown value.
 * @returns {string} the message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Log one non-fatal plugin warning; silent in hosts without a logger.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} text - warning text.
 */
function warn(ctx, text) {
  try {
    ctx.logger.warn(`memory-discipline: ${text}`)
  } catch {
    // Swallows only a missing/misbehaving logger service in minimal hosts;
    // every model-visible outcome was already delivered through the notice.
  }
}

/**
 * Wait a bounded budget for a tool to appear in the registry: `attempts`
 * checks with `delayMs` between them (MCP tool discovery is asynchronous and
 * may finish after `agent/session-start`).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying `ctx.tools`.
 * @param {string} toolName - registered tool name to wait for.
 * @param {number} attempts - total registry checks (>= 1).
 * @param {number} delayMs - delay between checks.
 * @param {AbortSignal} signal - cancels the wait.
 * @returns {Promise<boolean>} whether the tool is registered.
 */
async function waitForTool(ctx, toolName, attempts, delayMs, signal) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (ctx.tools.get(toolName) !== undefined) return true
    if (attempt === attempts || signal.aborted) return false
    try {
      await sleep(delayMs, undefined, { signal })
    } catch {
      // Swallows only the AbortError of the cancelled wait; the caller
      // reports unavailability through the notice path.
      return false
    }
  }
  return false
}

/**
 * Fetch hot context once, applying the bounded call retry, and build the
 * notice for the outcome. Never throws: every failure becomes the
 * memory-unavailable notice.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof validateConfig>} config - validated config.
 * @param {AbortSignal} signal - aborts on plugin disposal or maintenance cancellation.
 * @returns {Promise<{ ok: boolean, notice: { text: string, summary: string } }>}
 *   `ok` marks a genuinely loaded hot-context notice (false = unavailable).
 */
async function fetchHotContext(ctx, config, signal) {
  const tool = config.hotContextTool
  // Retry the call: an MCP-bridged memory server that restarted keeps its
  // HTTP transport open while rejecting calls with a stale-session error,
  // and the bridge needs one failed call to notice and reconnect. A short
  // bounded retry turns that reconnect window into a successful load
  // instead of a spurious "memory unavailable" notice.
  let lastFailure = null
  for (let attempt = 0; attempt <= config.toolRetryAttempts; attempt++) {
    if (attempt > 0) {
      try {
        await sleep(config.toolRetryDelayMs, undefined, { signal })
      } catch {
        // Swallows only the AbortError of a cancelled wait; the notice
        // below reports unavailability for the current session.
        break
      }
    }
    let result
    try {
      result = await ctx.tools.execute({
        callId: crypto.randomUUID(),
        name: tool,
        arguments: {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.callTimeoutMs)]),
      })
    } catch (error) {
      lastFailure = error
      continue
    }
    if (result.isError) {
      lastFailure = new Error(result.error.message)
      continue
    }
    const body = extractResultText(result.content)
    return {
      ok: true,
      notice: buildHotContextNotice(tool, body === '' ? '(the memory service returned no hot context)' : body),
    }
  }
  return {
    ok: false,
    notice: buildMemoryUnavailableNotice(
      tool,
      `tool "${tool}" failed: ${messageOf(lastFailure ?? new Error('unknown failure'))}`,
    ),
  }
}

/**
 * Inject one notice into the agent's inbox as a plugin-sourced message.
 *
 * @param {{ inject(message: unknown): void }} agent - target agent.
 * @param {{ text: string, summary: string }} notice - notice to inject.
 */
function injectNotice(agent, notice) {
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: notice.text }],
    source: { kind: 'plugin', plugin: 'memory-discipline', form: 'notice', summary: notice.summary },
  }))
}

/**
 * B1 late-registration backfill: after the startup wait budget expired without
 * the hot-context tool, keep watching the tool registry (via `tools/change`
 * plus a re-check at arm time, covering the emit-vs-arm race) and, the moment
 * the tool appears, fetch and inject ONE backfill notice for the same session.
 *
 * Guards:
 * - fires at most once per session (`fired` latch + the listener disposes on fire);
 * - dies with the plugin disposal signal or the configurable budget, whichever
 *   comes first, so no orphan watcher outlives either boundary;
 * - an agent already disposed mid-wait fails the inject and is only logged.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof validateConfig>} config - validated config.
 * @param {{ inject(message: unknown): void }} agent - the agent whose session started.
 * @param {AbortSignal} disposalSignal - plugin-lifetime signal (NOT the
 *   maintenance signal, which ends when the seeding task returns).
 */
function armLateRegistration(ctx, config, agent, disposalSignal) {
  const tool = config.hotContextTool
  const budget = AbortSignal.any([
    disposalSignal,
    AbortSignal.timeout(config.lateRegistrationMaxWaitMs),
  ])
  let fired = false
  let disposeListener = () => {}

  const backfill = async () => {
    try {
      const fetched = await fetchHotContext(ctx, config, budget)
      try {
        injectNotice(agent, fetched.notice)
      } catch (error) {
        // The agent was disposed before the tool appeared; the session is gone,
        // nothing to backfill into. Log only.
        warn(ctx, `late hot-context injection failed: ${messageOf(error)}`)
      }
    } catch (error) {
      warn(ctx, `late hot-context backfill failed: ${messageOf(error)}`)
    }
  }

  const check = () => {
    if (fired || budget.aborted) return
    if (ctx.tools.get(tool) === undefined) return
    fired = true
    disposeListener()
    void backfill()
  }

  // Race cover: the tool may register between the last waitForTool check and
  // this listener (its `tools/change` emit already passed); re-check now.
  check()
  if (fired) return

  disposeListener = ctx.on('tools/change', check)
  budget.addEventListener('abort', () => {
    if (!fired) disposeListener()
  }, { once: true })
}

/**
 * Seed hot context at session start: wait a bounded budget for the tool, fetch
 * once and inject the outcome as a plugin-sourced notice. When the budget
 * expires unregistered, inject the unavailable notice AND arm the
 * late-registration backfill (B1) so a tool that registers a moment later is
 * still pulled once into this session. Never throws: every failure becomes the
 * memory-unavailable notice.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof validateConfig>} config - validated config.
 * @param {{ inject(message: unknown): void }} agent - the agent whose session just started.
 * @param {AbortSignal} signal - aborts on plugin disposal or maintenance cancellation.
 * @param {AbortSignal} disposalSignal - plugin-lifetime signal, forwarded to the backfill.
 * @returns {Promise<void>} settles when the notice was injected (or logged as lost).
 */
async function seedHotContext(ctx, config, agent, signal, disposalSignal) {
  const tool = config.hotContextTool
  let notice
  let ok = false
  try {
    const registered = await waitForTool(ctx, tool, config.toolWaitAttempts, config.toolWaitDelayMs, signal)
    if (registered) {
      const fetched = await fetchHotContext(ctx, config, signal)
      ok = fetched.ok
      notice = fetched.notice
    } else {
      notice = buildMemoryUnavailableNotice(
        tool,
        `tool "${tool}" was not registered within the startup wait budget`,
      )
    }
  } catch (error) {
    notice = buildMemoryUnavailableNotice(tool, messageOf(error))
  }
  try {
    injectNotice(agent, notice)
  } catch (error) {
    warn(ctx, `hot-context injection failed: ${messageOf(error)}`)
  }
  // B1: the startup budget expired without the tool (or the fetch failed) —
  // keep listening for a late registration and backfill once for this session.
  if (!ok) armLateRegistration(ctx, config, agent, disposalSignal)
}

/**
 * Install the policy section and, when `autoFetch` is on, the session-start
 * hot-context seeding.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context; all registrations dispose with it.
 * @param {unknown} config - raw row config; validated fail-loud here.
 */
export function apply(ctx, config) {
  const resolved = validateConfig(config)
  // autoFetch=false is the explicit opt-out for hosts that must keep the
  // model-visible prompt free of memory policy/context injection.
  if (!resolved.autoFetch) return
  const policyText = renderPolicyText(resolved)
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolved.sectionOrder,
    text: policyText,
  })

  const disposal = new AbortController()
  ctx.effect(() => () => disposal.abort(new Error('memory-discipline disposed')), 'memory-discipline.disposal')

  ctx.on('agent/session-start', ({ agent }) => {
    const task = (/** @type {AbortSignal} */ signal) =>
      seedHotContext(ctx, resolved, agent, AbortSignal.any([disposal.signal, signal]), disposal.signal)
    let settled
    try {
      // `agent/session-start` is emitted synchronously before any prompt can
      // start the driver, so the idle-phase claim normally succeeds; a prompt
      // arriving during the fetch is latched and wakes the driver after
      // release, so the first step claims the injected notice together with
      // the prompt.
      settled = agent.runMaintenance(task)
    } catch {
      // Swallows only the synchronous "already has active work" claim
      // rejection (another lifecycle owner beat us to the agent); seeding
      // continues best-effort — a later step boundary picks the injection up.
      settled = task(disposal.signal)
    }
    settled.catch(error => warn(ctx, `session-start hot-context seeding failed: ${messageOf(error)}`))
  })
}
