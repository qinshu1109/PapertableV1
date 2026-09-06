/**
 * dsh-scheduled-prompt — config-declared scheduled prompts for DeepSeek
 * Harness. Each job names a schedule (cron string via croner, or fixed
 * `{everySeconds}` buckets), a prompt, and a target:
 *
 * - `target: self` delivers into the current resident agent — `followup()`
 *   when it is idle, `inject()` (next-step context, no wake) when it is busy,
 *   the pattern the harness extension cookbook prescribes for cron plugins.
 * - `target: new-session` creates a fresh one-shot agent through
 *   `ctx.agents.create()` (the same registry path the headless runner uses),
 *   drives the prompt to quiescence, flushes the session, and disposes it.
 *
 * Every tick computes an idempotency key (`jobId@` + schedule-aligned UTC
 * instant). Keys already present in the durable run log are skipped with a
 * `skipped-duplicate` record, so a restart inside an already-run bucket cannot
 * re-fire it. Each dispatched run appends exactly one JSONL record
 * (`<storePath>/runs.jsonl`) with status ok / failed / budget-exceeded.
 *
 * A job's `budget.maxSteps` is enforced on the `agent/pre-step` waterfall: a
 * proposed step beyond the budget is rejected, which the loop turns into a
 * clean `blocked` turn end — the run is recorded as `budget-exceeded`.
 *
 * Config is validated fail-loud at plugin load (see `scheduler.js`). The
 * model-visible text of a run is exactly the configured `prompt`, delivered
 * with source `{kind: 'plugin', plugin: 'scheduled-prompt'}`; this plugin
 * invents no model-visible wording of its own.
 *
 * @module dsh-scheduled-prompt
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MAX_TIMER_DELAY_MS,
  nextDueMs,
  replayRunRecords,
  runRecordLine,
  statusForTurnEnd,
  tickKeyFor,
  validateConfig,
} from './scheduler.js'

export const name = 'scheduled-prompt'

/** Services this plugin drives: agent registry, session store (flush), and the default model selection. */
export const inject = ['agents', 'sessions', 'agentDefaultModel']

/** One in-flight scheduled run, from tick dispatch to its appended record. */
class Run {
  /**
   * @param {{id: string, prompt: string, target: 'self' | 'new-session', maxSteps: number | undefined}} job - the owning normalized job.
   * @param {string} tickKey - this tick's idempotency key.
   */
  constructor(job, tickKey) {
    this.job = job
    this.tickKey = tickKey
    this.startedAt = new Date().toISOString()
    /** @type {'followup' | 'inject' | undefined} */
    this.delivery = undefined
    /** @type {string | undefined} */
    this.sessionId = undefined
    /** @type {string | undefined} message id awaiting its inbox claim */
    this.messageId = undefined
    /** @type {number | undefined} turn number once a claim correlated it */
    this.turn = undefined
    this.steps = 0
    this.budgetExceeded = false
    this.finalized = false
  }
}

/**
 * Install the scheduler: validate config, open the run log, register the
 * run-tracking listeners once, and arm one timer chain per job. Every
 * registration goes through `ctx.effect()`/`ctx.on()` so disposal (HMR,
 * profile reload, shutdown) unwinds timers and listeners; in-flight runs are
 * finalized as failed at unload so the log never dangles.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - raw row config; validated fail-loud here.
 */
export function apply(ctx, config) {
  const normalized = validateConfig(config)
  const runsPath = join(normalized.storePath, 'runs.jsonl')

  // Fail loud at load: an unwritable store directory must break composition,
  // not surface later as lost run records.
  mkdirSync(normalized.storePath, { recursive: true })
  appendFileSync(runsPath, '')

  /** @type {Set<string>} tick keys with a durable record (replayed + this process). */
  let seen
  {
    const replay = replayRunRecords(readFileSync(runsPath, 'utf8'))
    seen = replay.seen
    for (const line of replay.malformed) {
      ctx.logger.warn(`scheduled-prompt: ${runsPath}:${line} is not a valid run record and was ignored for dedupe replay`)
    }
  }

  // When appending a run record fails, the scheduler halts new ticks instead
  // of running jobs without an audit trail; the failure is logged as an error.
  let halted = false

  /** @type {Map<string, Run>} runs keyed by their prompt message id, awaiting an inbox claim. */
  const pendingByMessage = new Map()
  /** @type {Map<string, Run>} claimed runs keyed by `sessionId\u0000turn`. */
  const activeByTurn = new Map()
  /** @type {Set<Run>} every dispatched, not-yet-finalized run. */
  const activeRuns = new Set()
  /** @type {Set<string>} session ids this plugin created (excluded from resident-agent selection). */
  const createdSessions = new Set()

  /**
   * Append one durable run record; a write failure halts the scheduler.
   * @param {Parameters<typeof runRecordLine>[0]} record - complete record.
   */
  const appendRecord = (record) => {
    try {
      appendFileSync(runsPath, runRecordLine(record))
    } catch (error) {
      halted = true
      ctx.logger.error(
        `scheduled-prompt: FAILED to append run record to ${runsPath} (${error instanceof Error ? error.message : String(error)}); `
        + 'halting all further scheduled ticks — runs must not proceed without an audit trail',
      )
    }
  }

  /**
   * Finalize one run exactly once: detach its tracking keys and append its record.
   * @param {Run} run - the run to finalize.
   * @param {'ok' | 'failed' | 'budget-exceeded'} status - final status.
   * @param {string} [error] - failure detail for `failed` records.
   */
  const finalize = (run, status, error) => {
    if (run.finalized) return
    run.finalized = true
    if (run.messageId !== undefined) pendingByMessage.delete(run.messageId)
    if (run.sessionId !== undefined && run.turn !== undefined) {
      activeByTurn.delete(`${run.sessionId}\u0000${run.turn}`)
    }
    activeRuns.delete(run)
    appendRecord({
      jobId: run.job.id,
      tickKey: run.tickKey,
      mode: run.job.target,
      delivery: run.delivery,
      startedAt: run.startedAt,
      endedAt: new Date().toISOString(),
      status,
      steps: run.steps,
      sessionId: run.sessionId,
      error,
    })
  }

  /**
   * Build the run's prompt message: the configured text verbatim, attributed
   * to this plugin.
   * @param {Run} run - the run the message belongs to.
   * @returns {ReturnType<typeof createUserMessage>} the identified user message.
   */
  const buildPromptMessage = (run) => createUserMessage({
    content: [{ type: 'text', text: run.job.prompt }],
    source: { kind: 'plugin', plugin: 'scheduled-prompt' },
  })

  // ── run tracking listeners (registered once; ctx.on disposes with the fiber) ──

  // A followup delivered by this plugin is claimed into its own turn; the
  // claim correlates message id → (session, turn) before the first pre-step
  // waterfall dispatch of that turn.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const run = pendingByMessage.get(message.id)
    if (run === undefined) return
    pendingByMessage.delete(message.id)
    run.turn = turn
    activeByTurn.set(`${agent.id}\u0000${turn}`, run)
  })

  ctx.on('agent/inbox/discarded', ({ message }) => {
    const run = pendingByMessage.get(message.id)
    if (run === undefined) return
    finalize(run, 'failed', 'the prompt message was discarded before any turn claimed it')
  })

  // Budget enforcement: a proposed step beyond the job's maxSteps is rejected.
  // Returning the decision without next() deliberately short-circuits the
  // waterfall — the loop closes the turn as `blocked` and the run records
  // `budget-exceeded`. All other traffic delegates down the chain.
  ctx.on('agent/pre-step', (payload, next) => {
    const run = activeByTurn.get(`${payload.agent.id}\u0000${payload.turn}`)
    if (run === undefined || run.job.maxSteps === undefined || payload.step <= run.job.maxSteps) {
      return next()
    }
    run.budgetExceeded = true
    return Promise.resolve({ kind: 'reject' })
  })

  // Durable step/turn boundaries drive step counting and run finalization.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      const run = activeByTurn.get(`${session.id}\u0000${event.data.turn}`)
      if (run !== undefined) run.steps = Math.max(run.steps, event.data.step)
      return
    }
    if (event.type !== 'turn/end') return
    const run = activeByTurn.get(`${session.id}\u0000${event.data.turn}`)
    if (run === undefined) return
    const outcome = statusForTurnEnd(event.data.reason, run.budgetExceeded)
    finalize(run, outcome.status, outcome.error)
  })

  // An agent disposed mid-run can emit no further session events; close its runs.
  ctx.on('agent/disposed', ({ agent }) => {
    createdSessions.delete(agent.id)
    for (const run of [...activeRuns]) {
      if (run.sessionId === agent.id) {
        finalize(run, 'failed', 'the agent was disposed before the scheduled turn finished')
      }
    }
  })

  // ── run drivers ──────────────────────────────────────────────────────────────

  /**
   * Deliver one tick into the resident agent (the oldest live root agent this
   * plugin did not create). Idle → `followup()` (a turn of its own, tracked to
   * its turn/end). Busy → `inject()` (next-step context, no wake; recorded as
   * delivered because consumption belongs to the resident turn's own budget).
   * @param {Run} run - the dispatched run.
   */
  const runSelf = (run) => {
    const resident = ctx.agents.roots().find(agent => !createdSessions.has(agent.id))
    if (resident === undefined) {
      finalize(run, 'failed', 'no resident root agent is live to receive the prompt')
      return
    }
    run.sessionId = resident.id
    const message = buildPromptMessage(run)
    if (resident.status === 'running') {
      run.delivery = 'inject'
      resident.inject(message)
      finalize(run, 'ok')
      return
    }
    run.delivery = 'followup'
    run.messageId = message.id
    pendingByMessage.set(message.id, run)
    resident.followup(message)
  }

  /**
   * Drive one tick through a fresh one-shot agent: create → prompt → await
   * quiescence → flush → dispose. Mirrors the headless runner's registry use;
   * the turn/end listener above finalizes the record, and the fallback here
   * only covers a turn that never opened.
   * @param {Run} run - the dispatched run.
   */
  const runNewSession = async (run) => {
    run.delivery = 'followup'
    const selection = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({
      sessionId: SessionId(`scheduled-${run.job.id}-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
    })
    createdSessions.add(handle.agent.id)
    try {
      run.sessionId = handle.agent.id
      await handle.agent.whenIdle()
      const message = buildPromptMessage(run)
      run.messageId = message.id
      pendingByMessage.set(message.id, run)
      handle.agent.followup(message)
      await handle.agent.whenIdle()
      await ctx.sessions.flush(handle.agent.session)
      if (!run.finalized) {
        finalize(run, 'failed', 'the agent reached idle without opening a turn for the prompt')
      }
    } finally {
      await handle.dispose()
      createdSessions.delete(handle.agent.id)
    }
  }

  /**
   * Evaluate one due tick: dedupe against the durable set, then dispatch.
   * @param {ReturnType<typeof validateConfig>['jobs'][number]} job - the firing job.
   * @param {number} dueMs - the tick's scheduled instant.
   */
  const fire = (job, dueMs) => {
    if (halted) return
    const tickKey = tickKeyFor(job.id, dueMs)
    if (seen.has(tickKey)) {
      const at = new Date().toISOString()
      appendRecord({
        jobId: job.id,
        tickKey,
        mode: job.target,
        startedAt: at,
        endedAt: at,
        status: 'skipped-duplicate',
        steps: 0,
      })
      return
    }
    seen.add(tickKey)
    const run = new Run(job, tickKey)
    activeRuns.add(run)
    if (job.target === 'self') {
      runSelf(run)
      return
    }
    runNewSession(run).catch((error) => {
      finalize(run, 'failed', error instanceof Error ? error.message : String(error))
    })
  }

  // ── timers: one self-rescheduling chain per job, disposed with the fiber ─────

  /**
   * Arm one job's timer chain. Called only after the Loader settles: the
   * injected services exist before `apply`, but the agent FACTORY registers
   * when the separate agent-loop plugin mounts, and Loader siblings mount
   * concurrently — an immediate catch-up tick could otherwise fire into a
   * half-composed application (the headless runner awaits settlement for the
   * same reason).
   * @param {ReturnType<typeof validateConfig>['jobs'][number]} job - the job to arm.
   */
  const armJob = (job) => {
    ctx.effect(() => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      let disposed = false
      /** @type {number | null} */
      let lastDueMs = null
      /**
       * Wait until `dueMs`, re-arming without firing while the remaining delay
       * exceeds Node's timer cap.
       * @param {number} dueMs - the next scheduled instant.
       */
      const waitUntil = (dueMs) => {
        const delay = dueMs - Date.now()
        if (delay > MAX_TIMER_DELAY_MS) {
          timer = setTimeout(() => { waitUntil(dueMs) }, MAX_TIMER_DELAY_MS)
          return
        }
        timer = setTimeout(() => {
          if (disposed || halted) return
          fire(job, dueMs)
          armNext()
        }, Math.max(0, delay))
      }
      const armNext = () => {
        if (disposed || halted) return
        const dueMs = nextDueMs(job.schedule, lastDueMs, Date.now())
        if (dueMs === undefined) {
          ctx.logger.info(`scheduled-prompt: job "${job.id}" has no future fire time; its timer stops`)
          return
        }
        lastDueMs = dueMs
        waitUntil(dueMs)
      }
      armNext()
      return () => {
        disposed = true
        clearTimeout(timer)
      }
    }, `scheduled-prompt.job(${job.id})`)
  }

  void (async () => {
    await ctx.get('loader')?.await()
    for (const job of normalized.jobs) armJob(job)
  })().catch((error) => {
    // Reachable when the tree is disposed before settlement (ctx.effect then
    // rejects registration); jobs that never armed have nothing to clean up.
    ctx.logger.warn(`scheduled-prompt: timers were not armed: ${error instanceof Error ? error.message : String(error)}`)
  })

  // Unload with runs still in flight: close their records now — their agents
  // (owned by this fiber for new-session runs) are being torn down with us.
  ctx.effect(() => () => {
    for (const run of [...activeRuns]) {
      finalize(run, 'failed', 'the scheduler was disposed while the run was in flight')
    }
  }, 'scheduled-prompt.drainRecords()')
}
