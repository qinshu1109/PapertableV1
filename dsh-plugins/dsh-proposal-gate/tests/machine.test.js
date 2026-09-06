import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkTransition,
  parseProposalCommand,
  STATUSES,
  validateConfig,
  validateSubmission,
} from '../machine.js'

const CONFIG = validateConfig({
  storePath: '/tmp/x',
  lanes: ['default', 'ops'],
  targetKinds: ['document', 'config'],
  requestedActions: ['create', 'update'],
  riskLevels: ['low', 'high'],
})

function submission(overrides = {}) {
  return {
    lane: 'default',
    target_kind: 'document',
    target_key: 'doc:alpha',
    requested_action: 'update',
    base_version: 0,
    risk: 'low',
    evidence: { for: ['observed X'], against: [], unknowns: [] },
    checks: ['diff reviewed'],
    ...overrides,
  }
}

test('validateConfig fails loud on missing or malformed fields', () => {
  assert.throws(() => validateConfig(undefined), /must be an object/)
  assert.throws(() => validateConfig({ lanes: ['a'] }), /storePath/)
  assert.throws(
    () => validateConfig({ storePath: '/x', lanes: [], targetKinds: ['t'], requestedActions: ['a'], riskLevels: ['l'] }),
    /`lanes`/,
  )
  assert.throws(
    () => validateConfig({ storePath: '/x', lanes: ['a', 'a'], targetKinds: ['t'], requestedActions: ['a'], riskLevels: ['l'] }),
    /duplicates/,
  )
  assert.throws(
    () => validateConfig({ storePath: '/x', lanes: ['a'], targetKinds: ['t'], requestedActions: ['a'], riskLevels: ['l'], expireAfterDays: 0 }),
    /expireAfterDays/,
  )
})

test('the full ported lifecycle is admitted edge by edge', () => {
  assert.ok(checkTransition('submitted', 'in_review', 'human').ok)
  assert.ok(checkTransition('in_review', 'changes_requested', 'human').ok)
  assert.ok(checkTransition('changes_requested', 'submitted', 'ai').ok)
  assert.ok(checkTransition('submitted', 'accepted', 'human').ok)
  assert.ok(checkTransition('accepted', 'applied', 'human').ok)
  assert.ok(checkTransition('applied', 'verified', 'human').ok)
  assert.ok(checkTransition('applied', 'rolled_back', 'human').ok)
})

test('acceptance recall: a stale accepted proposal can be sent back or rejected by the human', () => {
  assert.ok(checkTransition('accepted', 'changes_requested', 'human').ok)
  assert.ok(checkTransition('accepted', 'rejected', 'human').ok)
  assert.equal(checkTransition('accepted', 'changes_requested', 'ai').ok, false)
  assert.equal(checkTransition('accepted', 'submitted', 'human').ok, false)
})

test('illegal transitions and terminal statuses are refused with reasons', () => {
  const skip = checkTransition('submitted', 'applied', 'human')
  assert.equal(skip.ok, false)
  assert.match(skip.reason, /illegal transition/)
  const terminal = checkTransition('rejected', 'submitted', 'human')
  assert.equal(terminal.ok, false)
  assert.match(terminal.reason, /terminal/)
  const unknown = checkTransition('nonsense', 'submitted', 'human')
  assert.equal(unknown.ok, false)
  assert.match(unknown.reason, /unknown status/)
})

test('actor classes are enforced per edge (channel separation)', () => {
  assert.equal(checkTransition('submitted', 'accepted', 'ai').ok, false)
  assert.equal(checkTransition('accepted', 'applied', 'ai').ok, false)
  assert.equal(checkTransition('submitted', 'withdrawn', 'human').ok, false)
  assert.ok(checkTransition('submitted', 'expired', 'system').ok)
  assert.equal(checkTransition('accepted', 'applied', 'system').ok, false)
})

test('every status is covered by the transition table', () => {
  for (const status of STATUSES) {
    const probe = checkTransition(status, 'submitted', 'human')
    assert.ok(probe.ok || !/unknown status/.test(probe.reason), `status "${status}" missing from table`)
  }
})

test('validateSubmission enforces config vocabulary and evidence discipline', () => {
  assert.equal(validateSubmission(submission(), CONFIG), undefined)
  assert.match(validateSubmission(submission({ lane: 'nope' }), CONFIG), /unknown lane/)
  assert.match(validateSubmission(submission({ target_kind: 'nope' }), CONFIG), /unknown target_kind/)
  assert.match(validateSubmission(submission({ requested_action: 'nope' }), CONFIG), /unknown requested_action/)
  assert.match(validateSubmission(submission({ risk: 'nope' }), CONFIG), /unknown risk/)
  assert.match(validateSubmission(submission({ target_key: '  ' }), CONFIG), /target_key/)
  assert.match(validateSubmission(submission({ base_version: -1 }), CONFIG), /base_version/)
  assert.match(
    validateSubmission(submission({ evidence: { for: [], against: [], unknowns: [] } }), CONFIG),
    /evidence\.for/,
  )
  const lax = validateConfig({
    storePath: '/x', lanes: ['default'], targetKinds: ['document'],
    requestedActions: ['update'], riskLevels: ['low'], requireEvidence: false,
  })
  assert.equal(
    validateSubmission(submission({ evidence: { for: [], against: [], unknowns: [] } }), lax),
    undefined,
  )
})

test('parseProposalCommand covers the grammar and rejects bad syntax', () => {
  assert.deepEqual(parseProposalCommand(''), { kind: 'help' })
  assert.deepEqual(parseProposalCommand(' list '), { kind: 'list' })
  assert.deepEqual(parseProposalCommand('list accepted'), { kind: 'list', status: 'accepted' })
  assert.deepEqual(parseProposalCommand('show p-1'), { kind: 'show', id: 'p-1' })
  assert.deepEqual(
    parseProposalCommand('review p-1 accept looks good'),
    { kind: 'review', id: 'p-1', to: 'accepted', note: 'looks good' },
  )
  assert.deepEqual(
    parseProposalCommand('review p-1 changes tighten the checks'),
    { kind: 'review', id: 'p-1', to: 'changes_requested', note: 'tighten the checks' },
  )
  assert.deepEqual(parseProposalCommand('apply p-1'), { kind: 'apply', id: 'p-1', note: '' })
  assert.deepEqual(
    parseProposalCommand('verify p-1 rolled-back broke prod'),
    { kind: 'verify', id: 'p-1', to: 'rolled_back', note: 'broke prod' },
  )
  assert.deepEqual(parseProposalCommand('expire p-1'), { kind: 'expire', id: 'p-1', note: '' })
  assert.equal(parseProposalCommand('review p-1 frobnicate').kind, 'error')
  assert.equal(parseProposalCommand('bogus').kind, 'error')
})
