import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { openStore } from '../store.js'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-store-'))
}

function fields(overrides = {}) {
  return {
    lane: 'default',
    target_kind: 'document',
    target_key: 'doc:alpha',
    requested_action: 'update',
    base_version: 0,
    payload: { text: 'new text' },
    evidence: { for: ['observed X'], against: [], unknowns: [] },
    checks: ['diff reviewed'],
    risk: 'low',
    ...overrides,
  }
}

test('create persists, reloads, and audits', () => {
  const dir = scratch()
  const store = openStore(dir)
  const proposal = store.create(fields(), { sessionId: 's-1' })
  assert.match(proposal.id, /^p-[0-9a-f]{8}$/)
  assert.equal(proposal.status, 'submitted')
  assert.equal(proposal.revision, 1)

  const reloaded = openStore(dir)
  assert.deepEqual(reloaded.get(proposal.id), proposal)

  const ledger = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].to, 'submitted')
  assert.equal(ledger[0].actor, 'ai')
  assert.equal(ledger[0].via, 'tool')
})

test('transition mutates status, appends history, and audits with actor', () => {
  const dir = scratch()
  const store = openStore(dir)
  const proposal = store.create(fields(), {})
  store.transition(proposal, 'accepted', { actor: 'human', via: 'command', note: 'lgtm' })
  assert.equal(store.get(proposal.id).status, 'accepted')
  assert.equal(proposal.history.length, 2)
  assert.equal(proposal.history[1].note, 'lgtm')
  const ledger = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(ledger[1].actor, 'human')
  assert.equal(ledger[1].from, 'submitted')
  assert.equal(ledger[1].to, 'accepted')
})

test('target versions start at 0 and bump on demand; stale applies are audited without status change', () => {
  const dir = scratch()
  const store = openStore(dir)
  assert.equal(store.targetVersion('doc:alpha'), 0)
  const proposal = store.create(fields(), {})
  assert.equal(store.bumpTarget('doc:alpha'), 1)
  assert.equal(openStore(dir).targetVersion('doc:alpha'), 1)

  store.auditStaleApply(proposal, 1)
  assert.equal(store.get(proposal.id).status, 'submitted')
  const ledger = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const stale = ledger.at(-1)
  assert.equal(stale.kind, 'apply-stale')
  assert.equal(stale.baseVersion, 0)
  assert.equal(stale.currentVersion, 1)
})

test('list filters by status/lane/target and orders newest first', () => {
  const store = openStore(scratch())
  const a = store.create(fields({ target_key: 'doc:a' }), {})
  const b = store.create(fields({ target_key: 'doc:b', lane: 'default' }), {})
  store.transition(b, 'accepted', { actor: 'human', via: 'command' })
  assert.equal(store.list().length, 2)
  assert.deepEqual(store.list({ status: 'accepted' }).map(p => p.id), [b.id])
  assert.deepEqual(store.list({ targetKey: 'doc:a' }).map(p => p.id), [a.id])
  assert.equal(store.list({ limit: 1 }).length, 1)
})

test('sweepExpired expires only stale pre-decision proposals with the system actor', () => {
  const dir = scratch()
  const store = openStore(dir)
  const old = store.create(fields({ target_key: 'doc:old' }), {})
  const fresh = store.create(fields({ target_key: 'doc:fresh' }), {})
  const applied = store.create(fields({ target_key: 'doc:done' }), {})
  store.transition(applied, 'accepted', { actor: 'human', via: 'command' })
  store.transition(applied, 'applied', { actor: 'human', via: 'command' })
  old.updatedAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString()

  const expired = store.sweepExpired(30)
  assert.deepEqual(expired, [old.id])
  assert.equal(store.get(old.id).status, 'expired')
  assert.equal(store.get(fresh.id).status, 'submitted')
  assert.equal(store.get(applied.id).status, 'applied')
  const ledger = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(ledger.at(-1).actor, 'system')
})

test('openStore fails loud on a corrupt state file', () => {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, 'state.json'), '{nope')
  assert.throws(() => openStore(dir), /corrupt state file/)
  fs.writeFileSync(path.join(dir, 'state.json'), '{"proposals": {}}')
  assert.throws(() => openStore(dir), /lacks \{proposals, targets\}/)
})
