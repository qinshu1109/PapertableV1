/**
 * Pure scheduled-prompt logic: config validation, tick identity, next-fire
 * computation, run-record serialization, and dedupe replay. No Cordis imports,
 * so the module unit-tests without a harness install; `index.js` owns the
 * plugin wiring, timers, and agent driving.
 *
 * @module dsh-scheduled-prompt/scheduler
 */

import { Cron } from 'croner'

/** Fail-loud config error prefix shared by every validation throw. */
const BAD = 'dsh-scheduled-prompt: invalid config —'

/** Job ids appear in tick keys, session ids, and run records; keep them path- and log-safe. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Node caps one setTimeout delay at 2^31-1 ms; longer waits re-arm without firing. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** The run-record statuses a tick can end with. */
export const RUN_STATUSES = ['ok', 'failed', 'budget-exceeded', 'skipped-duplicate']

/**
 * Throw unless `value` is a plain object (not null, not an array).
 * @param {unknown} value - candidate value.
 * @param {string} label - config path used in the error message.
 * @returns {Record<string, unknown>} the value, narrowed.
 */
function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${BAD} ${label} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Throw when `record` carries keys outside `allowed` (typo protection: a
 * misspelled key must not silently fall back to a default).
 * @param {Record<string, unknown>} record - object to check.
 * @param {string[]} allowed - accepted key names.
 * @param {string} label - config path used in the error message.
 */
function rejectUnknownKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${BAD} ${label} has unknown key "${key}" (allowed: ${allowed.join(', ')})`)
    }
  }
}

/**
 * Validate one job's `schedule` into its normalized form. A string is a cron
 * pattern parsed by croner (5/6-field and named patterns, evaluated in the
 * process-local timezone); an object selects fixed-period bucket scheduling.
 * @param {unknown} value - raw `schedule` value.
 * @param {string} label - config path used in error messages.
 * @returns {{kind: 'cron', pattern: string} | {kind: 'every', periodMs: number}} normalized schedule.
 */
function validateSchedule(value, label) {
  if (typeof value === 'string') {
    if (value.trim() === '') throw new Error(`${BAD} ${label} cron pattern must be a non-empty string`)
    try {
      // Construct-only: croner validates the pattern without scheduling anything.
      new Cron(value)
    } catch (error) {
      throw new Error(`${BAD} ${label} is not a valid cron pattern: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { kind: 'cron', pattern: value }
  }
  const record = requireObject(value, label)
  rejectUnknownKeys(record, ['everySeconds'], label)
  const seconds = record.everySeconds
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`${BAD} ${label}.everySeconds must be a positive integer`)
  }
  return { kind: 'every', periodMs: seconds * 1000 }
}

/**
 * Validate raw cordis config into a normalized shape, throwing on any
 * misconfiguration (fail loud at plugin load, never a silent fallback).
 *
 * An explicitly empty `jobs` list is valid and leaves the plugin idle — the
 * same shipped-default convention as the harness base bundle's
 * `agent-loop.agents: []` row — so installing the bundle never breaks a
 * profile before the user declares jobs.
 *
 * @param {unknown} raw - the row's `config` value as the Loader passed it.
 * @returns {{storePath: string,
 *            jobs: {id: string,
 *                   schedule: {kind: 'cron', pattern: string} | {kind: 'every', periodMs: number},
 *                   prompt: string,
 *                   target: 'self' | 'new-session',
 *                   maxSteps: number | undefined}[]}} normalized config.
 */
export function validateConfig(raw) {
  const config = requireObject(raw, 'config')
  rejectUnknownKeys(config, ['storePath', 'jobs'], 'config')
  const storePath = config.storePath
  if (typeof storePath !== 'string' || storePath === '') {
    throw new Error(`${BAD} \`storePath\` must be a non-empty string (directory for runs.jsonl)`)
  }
  if (!isAbsolutePath(storePath)) {
    throw new Error(`${BAD} \`storePath\` must be an absolute path, got "${storePath}" (a relative path would depend on the launch directory)`)
  }
  if (!Array.isArray(config.jobs)) {
    throw new Error(`${BAD} \`jobs\` must be an array of job objects (an empty array is a valid idle state)`)
  }
  const ids = new Set()
  const jobs = config.jobs.map((entry, index) => {
    const label = `jobs[${index}]`
    const job = requireObject(entry, label)
    rejectUnknownKeys(job, ['id', 'schedule', 'prompt', 'target', 'budget'], label)
    const id = job.id
    if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) {
      throw new Error(`${BAD} ${label}.id must match ${JOB_ID_PATTERN} (it names tick keys, session ids, and run records)`)
    }
    if (ids.has(id)) throw new Error(`${BAD} duplicate job id "${id}"`)
    ids.add(id)
    if (job.schedule === undefined) throw new Error(`${BAD} ${label}.schedule is required (cron string or {everySeconds})`)
    const schedule = validateSchedule(job.schedule, `${label}.schedule`)
    const prompt = job.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new Error(`${BAD} ${label}.prompt must be a non-empty string`)
    }
    const target = job.target
    if (target !== 'self' && target !== 'new-session') {
      throw new Error(`${BAD} ${label}.target must be "self" or "new-session"`)
    }
    let maxSteps
    if (job.budget !== undefined) {
      const budget = requireObject(job.budget, `${label}.budget`)
      rejectUnknownKeys(budget, ['maxSteps'], `${label}.budget`)
      const steps = budget.maxSteps
      if (typeof steps !== 'number' || !Number.isInteger(steps) || steps <= 0) {
        throw new Error(`${BAD} ${label}.budget.maxSteps must be a positive integer`)
      }
      maxSteps = steps
    }
    return { id, schedule, prompt, target, maxSteps }
  })
  return { storePath, jobs }
}

/**
 * Platform-neutral absolute-path test (POSIX root or Windows drive/UNC), kept
 * dependency-free so validation stays pure.
 * @param {string} value - candidate path.
 * @returns {boolean} whether the path is absolute.
 */
function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * The idempotency key of one tick: the job id plus the schedule-aligned fire
 * instant in UTC. Restart-and-refire inside the same bucket reproduces the
 * same key, which is what the dedupe replay checks against.
 * @param {string} jobId - validated job id.
 * @param {number} dueMs - the tick's scheduled fire time (epoch ms).
 * @returns {string} the tick key, e.g. `hello@2026-08-14T02:05:00.000Z`.
 */
export function tickKeyFor(jobId, dueMs) {
  return `${jobId}@${new Date(dueMs).toISOString()}`
}

/**
 * Compute the next scheduled fire time.
 *
 * `every` schedules fire at fixed period-aligned buckets
 * (`floor(t/period)*period`). The first call (lastDueMs === null) returns the
 * CURRENT bucket, which is normally in the past: the tick fires immediately on
 * startup and the dedupe set decides whether that bucket already ran. After a
 * process outage only the most recent bucket fires — missed buckets are
 * skipped, never backfilled.
 *
 * `cron` delegates to croner in the process-local timezone and never fires
 * catch-up runs: the next fire is strictly after `max(lastDueMs, nowMs)`.
 *
 * @param {{kind: 'cron', pattern: string} | {kind: 'every', periodMs: number}} schedule - normalized schedule.
 * @param {number | null} lastDueMs - the previous tick's scheduled time, or null before the first tick.
 * @param {number} nowMs - the current time (epoch ms).
 * @returns {number | undefined} the next fire time (epoch ms; may be <= nowMs
 *   only for the `every` kind), or undefined when the schedule never fires again.
 */
export function nextDueMs(schedule, lastDueMs, nowMs) {
  if (schedule.kind === 'every') {
    const period = schedule.periodMs
    const currentBucket = Math.floor(nowMs / period) * period
    if (lastDueMs === null) return currentBucket
    return Math.max(lastDueMs + period, currentBucket)
  }
  // +1ms puts the base strictly past the last fire, so an inclusive-or-exclusive
  // croner nextRun can neither repeat the fired instant nor skip a boundary
  // (cron granularity is whole seconds).
  const fromMs = lastDueMs === null ? nowMs : Math.max(lastDueMs + 1, nowMs)
  const next = new Cron(schedule.pattern).nextRun(new Date(fromMs))
  return next === null ? undefined : next.getTime()
}

/**
 * Replay a runs.jsonl body into the set of tick keys that already have a
 * record. Blank lines are skipped; a line that does not parse as a JSON object
 * with a string `tickKey` is reported by 1-based line number so the caller can
 * log it loudly (a torn tail line from a crash mid-append must not brick the
 * scheduler, and must not be silently ignored either).
 * @param {string} text - full runs.jsonl content.
 * @returns {{seen: Set<string>, malformed: number[]}} replayed keys plus malformed line numbers.
 */
export function replayRunRecords(text) {
  const seen = new Set()
  const malformed = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // Malformed JSON is reported through the returned line numbers; there is
      // nothing else to salvage from the line.
      malformed.push(index + 1)
      continue
    }
    if (record === null || typeof record !== 'object' || typeof (/** @type {Record<string, unknown>} */ (record).tickKey) !== 'string') {
      malformed.push(index + 1)
      continue
    }
    seen.add(/** @type {{tickKey: string}} */ (record).tickKey)
  }
  return { seen, malformed }
}

/**
 * Serialize one run record as a JSONL line with a fixed key order. Optional
 * fields (`delivery`, `sessionId`, `error`) are omitted when absent rather
 * than written as null.
 * @param {{jobId: string, tickKey: string, mode: 'self' | 'new-session',
 *          delivery?: 'followup' | 'inject', startedAt: string, endedAt: string,
 *          status: string, steps: number, sessionId?: string, error?: string}} record - complete run record.
 * @returns {string} one JSON line terminated by a newline.
 */
export function runRecordLine(record) {
  return JSON.stringify({
    jobId: record.jobId,
    tickKey: record.tickKey,
    mode: record.mode,
    ...record.delivery === undefined ? {} : { delivery: record.delivery },
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: record.status,
    steps: record.steps,
    ...record.sessionId === undefined ? {} : { sessionId: record.sessionId },
    ...record.error === undefined ? {} : { error: record.error },
  }) + '\n'
}

/**
 * Map a durable `turn/end` reason (plus the run's own budget flag) onto the
 * run-record status. The budget flag wins because the scheduler itself
 * rejected the over-budget step, which surfaces in the log as an ordinary
 * `blocked` turn end. `TurnEndReason` is merge-extensible, so unknown kinds
 * fall through to `failed` with the kind named.
 * @param {{kind: string, reason?: {kind: string, reason?: string}, error?: {code: string, message: string}}} reason - the `turn/end` reason payload.
 * @param {boolean} budgetExceeded - whether this scheduler rejected a step of the turn over budget.
 * @returns {{status: 'ok' | 'failed' | 'budget-exceeded', error?: string}} record status and optional error text.
 */
export function statusForTurnEnd(reason, budgetExceeded) {
  if (budgetExceeded) return { status: 'budget-exceeded' }
  switch (reason.kind) {
    case 'completed':
      return { status: 'ok' }
    case 'aborted': {
      const cause = reason.reason
      const detail = cause?.kind === 'hook' && typeof cause.reason === 'string' ? `: ${cause.reason}` : ''
      return { status: 'failed', error: `turn aborted (cause: ${cause?.kind ?? 'unknown'}${detail})` }
    }
    case 'error':
      return { status: 'failed', error: `turn errored: ${reason.error?.code ?? 'UNKNOWN'}: ${reason.error?.message ?? ''}` }
    default:
      // blocked / max-tokens / interrupted / future merge-extended kinds.
      return { status: 'failed', error: `turn ended: ${reason.kind}` }
  }
}
