import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  nextDueMs,
  replayRunRecords,
  runRecordLine,
  statusForTurnEnd,
  tickKeyFor,
  validateConfig,
} from '../scheduler.js'

const BASE_JOB = {
  id: 'hello',
  schedule: { everySeconds: 5 },
  prompt: 'say hello world',
  target: 'new-session',
}

const BASE_CONFIG = {
  storePath: '/tmp/scheduled-prompt-test',
  jobs: [BASE_JOB],
}

// ── validateConfig ────────────────────────────────────────────────────────────

test('validateConfig accepts both schedule forms and normalizes them', () => {
  const config = validateConfig({
    storePath: '/tmp/x',
    jobs: [
      BASE_JOB,
      { id: 'cronny', schedule: '*/5 * * * *', prompt: 'p', target: 'self', budget: { maxSteps: 4 } },
    ],
  })
  assert.deepEqual(config.jobs[0].schedule, { kind: 'every', periodMs: 5000 })
  assert.deepEqual(config.jobs[1].schedule, { kind: 'cron', pattern: '*/5 * * * *' })
  assert.equal(config.jobs[0].maxSteps, undefined)
  assert.equal(config.jobs[1].maxSteps, 4)
})

test('validateConfig accepts an explicitly empty jobs list (installed-but-idle)', () => {
  assert.deepEqual(validateConfig({ storePath: '/tmp/x', jobs: [] }).jobs, [])
})

test('validateConfig fails loud on a malformed root', () => {
  assert.throws(() => validateConfig(undefined), /config must be an object/)
  assert.throws(() => validateConfig({ jobs: [] }), /`storePath` must be a non-empty string/)
  assert.throws(() => validateConfig({ storePath: 'relative/dir', jobs: [] }), /absolute path/)
  assert.throws(() => validateConfig({ storePath: '/tmp/x' }), /`jobs` must be an array/)
  assert.throws(() => validateConfig({ storePath: '/tmp/x', jobs: [], extra: 1 }), /unknown key "extra"/)
})

test('validateConfig fails loud on malformed jobs', () => {
  const withJob = job => ({ storePath: '/tmp/x', jobs: [job] })
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, id: 'has space' })), /jobs\[0\]\.id/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, id: undefined })), /jobs\[0\]\.id/)
  assert.throws(
    () => validateConfig({ storePath: '/tmp/x', jobs: [BASE_JOB, { ...BASE_JOB }] }),
    /duplicate job id "hello"/,
  )
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, schedule: undefined })), /schedule is required/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, schedule: 'not a cron' })), /not a valid cron pattern/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, schedule: { everySeconds: 0 } })), /positive integer/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, schedule: { everySeconds: 1.5 } })), /positive integer/)
  assert.throws(
    () => validateConfig(withJob({ ...BASE_JOB, schedule: { everySeconds: 5, extra: 1 } })),
    /unknown key "extra"/,
  )
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, prompt: '  ' })), /prompt must be a non-empty string/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, target: 'other' })), /"self" or "new-session"/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, budget: { maxSteps: 0 } })), /maxSteps must be a positive integer/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, budget: { maxSteps: '2' } })), /maxSteps must be a positive integer/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, budget: { maxstep: 2 } })), /unknown key "maxstep"/)
  assert.throws(() => validateConfig(withJob({ ...BASE_JOB, typo: true })), /unknown key "typo"/)
})

// ── tickKeyFor ────────────────────────────────────────────────────────────────

test('tickKeyFor is the job id plus the schedule-aligned UTC instant', () => {
  assert.equal(tickKeyFor('hello', Date.UTC(2026, 7, 14, 2, 5, 0)), 'hello@2026-08-14T02:05:00.000Z')
})

// ── nextDueMs: fixed-period buckets ───────────────────────────────────────────

test('every: the first arm returns the current bucket (startup catch-up)', () => {
  const schedule = { kind: 'every', periodMs: 5000 }
  const now = Date.UTC(2026, 7, 14, 2, 0, 7) // bucket starts at :05
  assert.equal(nextDueMs(schedule, null, now), Date.UTC(2026, 7, 14, 2, 0, 5))
})

test('every: subsequent arms advance exactly one period', () => {
  const schedule = { kind: 'every', periodMs: 5000 }
  const last = Date.UTC(2026, 7, 14, 2, 0, 5)
  assert.equal(nextDueMs(schedule, last, last + 20), last + 5000)
})

test('every: a long stall skips missed buckets to the current one, never backfilling', () => {
  const schedule = { kind: 'every', periodMs: 5000 }
  const last = Date.UTC(2026, 7, 14, 2, 0, 5)
  const now = last + 23_000 // 4 buckets later, mid-bucket
  assert.equal(nextDueMs(schedule, last, now), Date.UTC(2026, 7, 14, 2, 0, 25))
})

// ── nextDueMs: cron via croner ────────────────────────────────────────────────

test('cron: five-field pattern aligns to the next minute boundary, exclusive of now', () => {
  const schedule = { kind: 'cron', pattern: '*/1 * * * *' }
  const now = new Date(2026, 7, 14, 2, 0, 30).getTime() // local time; croner evaluates locally
  assert.equal(nextDueMs(schedule, null, now), new Date(2026, 7, 14, 2, 1, 0).getTime())
})

test('cron: six-field pattern fires on aligned seconds and never repeats the fired instant', () => {
  const schedule = { kind: 'cron', pattern: '*/5 * * * * *' }
  const fired = new Date(2026, 7, 14, 2, 0, 5).getTime()
  // Re-arming from the fired instant must yield the NEXT boundary.
  assert.equal(nextDueMs(schedule, fired, fired), fired + 5000)
  // A boundary reached exactly at "now" without a previous fire also moves forward.
  const next = nextDueMs(schedule, null, fired)
  assert.ok(next !== undefined && next > fired && next % 5000 === 0)
})

test('cron: a pattern with no future fire reports undefined', () => {
  // 2026-02-30 does not exist; croner returns null for the impossible date.
  const schedule = { kind: 'cron', pattern: '0 0 30 2 *' }
  assert.equal(nextDueMs(schedule, null, Date.UTC(2026, 7, 14)), undefined)
})

// ── replayRunRecords ──────────────────────────────────────────────────────────

test('replayRunRecords collects tick keys and reports malformed lines by number', () => {
  const text = [
    runRecordLine({
      jobId: 'hello', tickKey: 'hello@A', mode: 'new-session', delivery: 'followup',
      startedAt: 's', endedAt: 'e', status: 'ok', steps: 1, sessionId: 'x',
    }).trimEnd(),
    '',
    'not json {',
    JSON.stringify({ noTickKey: true }),
    runRecordLine({
      jobId: 'hello', tickKey: 'hello@B', mode: 'self',
      startedAt: 's', endedAt: 'e', status: 'skipped-duplicate', steps: 0,
    }).trimEnd(),
    '', // trailing newline residue
  ].join('\n')
  const { seen, malformed } = replayRunRecords(text)
  assert.deepEqual([...seen].sort(), ['hello@A', 'hello@B'])
  assert.deepEqual(malformed, [3, 4])
})

// ── runRecordLine ─────────────────────────────────────────────────────────────

test('runRecordLine omits absent optional fields and keeps a stable key order', () => {
  const line = runRecordLine({
    jobId: 'j', tickKey: 'j@T', mode: 'self',
    startedAt: 's', endedAt: 'e', status: 'failed', steps: 0, error: 'boom',
  })
  assert.equal(
    line,
    '{"jobId":"j","tickKey":"j@T","mode":"self","startedAt":"s","endedAt":"e","status":"failed","steps":0,"error":"boom"}\n',
  )
  const parsed = JSON.parse(line)
  assert.equal('delivery' in parsed, false)
  assert.equal('sessionId' in parsed, false)
})

// ── statusForTurnEnd ──────────────────────────────────────────────────────────

test('statusForTurnEnd maps turn outcomes onto run statuses', () => {
  assert.deepEqual(statusForTurnEnd({ kind: 'completed' }, false), { status: 'ok' })
  assert.deepEqual(statusForTurnEnd({ kind: 'completed' }, true), { status: 'budget-exceeded' })
  // The scheduler's own budget rejection surfaces as a blocked turn.
  assert.deepEqual(statusForTurnEnd({ kind: 'blocked' }, true), { status: 'budget-exceeded' })
  assert.deepEqual(
    statusForTurnEnd({ kind: 'blocked' }, false),
    { status: 'failed', error: 'turn ended: blocked' },
  )
  assert.deepEqual(
    statusForTurnEnd({ kind: 'aborted', reason: { kind: 'hook', reason: 'why' } }, false),
    { status: 'failed', error: 'turn aborted (cause: hook: why)' },
  )
  assert.deepEqual(
    statusForTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }, false),
    { status: 'failed', error: 'turn aborted (cause: user)' },
  )
  assert.deepEqual(
    statusForTurnEnd({ kind: 'error', error: { code: 'HTTP_500', message: 'boom' } }, false),
    { status: 'failed', error: 'turn errored: HTTP_500: boom' },
  )
  assert.deepEqual(
    statusForTurnEnd({ kind: 'max-tokens' }, false),
    { status: 'failed', error: 'turn ended: max-tokens' },
  )
})
