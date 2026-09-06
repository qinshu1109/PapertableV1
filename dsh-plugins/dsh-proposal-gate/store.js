/**
 * Durable proposal store: `state.json` (all proposals + per-target versions,
 * rewritten atomically via tmp+rename) and `events.jsonl` (append-only audit
 * ledger). Cross-session by construction — the files live under the
 * configured `storePath`, not in any session log. Single-writer: one harness
 * process per store directory (concurrent writers would race the state file;
 * documented in the README).
 *
 * @module dsh-proposal-gate/store
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** State-file name under `storePath`. */
const STATE_FILE = 'state.json'
/** Audit-ledger name under `storePath`. */
const EVENTS_FILE = 'events.jsonl'

/**
 * Load-or-init a proposal store rooted at `dir`. A corrupt state file throws
 * (fail loud — silently starting empty would orphan the audit ledger).
 *
 * @param {string} dir - store directory; created if absent.
 * @returns {ProposalStore} the loaded store.
 */
export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, STATE_FILE)
  let state = { proposals: {}, targets: {} }
  if (fs.existsSync(statePath)) {
    const text = fs.readFileSync(statePath, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`dsh-proposal-gate: corrupt state file ${statePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object'
      || typeof parsed.proposals !== 'object' || parsed.proposals === null
      || typeof parsed.targets !== 'object' || parsed.targets === null) {
      throw new Error(`dsh-proposal-gate: state file ${statePath} lacks {proposals, targets}`)
    }
    state = parsed
  }
  return new ProposalStore(dir, state)
}

/** Durable proposal collection with an append-only audit ledger. */
export class ProposalStore {
  /**
   * @param {string} dir - store directory.
   * @param {{proposals: Record<string, object>, targets: Record<string, number>}} state - loaded state.
   */
  constructor(dir, state) {
    this.dir = dir
    this.state = state
  }

  /** Atomically rewrite `state.json` (tmp + rename). */
  #save() {
    const tmp = path.join(this.dir, `${STATE_FILE}.tmp-${process.pid}`)
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`)
    fs.renameSync(tmp, path.join(this.dir, STATE_FILE))
  }

  /**
   * Append one audit entry to `events.jsonl`. Every state mutation goes
   * through here; a failed append fails the mutation loud.
   *
   * @param {Record<string, unknown>} entry - audit fields (time is stamped here).
   */
  #audit(entry) {
    fs.appendFileSync(path.join(this.dir, EVENTS_FILE), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
  }

  /**
   * Current committed version of one target key (0 before any applied
   * proposal).
   *
   * @param {string} targetKey - the target identity chosen by the deployment.
   * @returns {number} the version counter.
   */
  targetVersion(targetKey) {
    return this.state.targets[targetKey] ?? 0
  }

  /** All target versions, for the model-facing list view.
   * @returns {Record<string, number>} target key → version. */
  targets() {
    return { ...this.state.targets }
  }

  /**
   * Fetch one proposal by id.
   *
   * @param {string} id - proposal id.
   * @returns {object | undefined} the proposal record.
   */
  get(id) {
    return this.state.proposals[id]
  }

  /**
   * List proposals, newest first.
   *
   * @param {{status?: string, lane?: string, targetKey?: string, limit?: number}} [filter] - optional filters.
   * @returns {object[]} matching proposals.
   */
  list(filter = {}) {
    let all = Object.values(this.state.proposals)
    if (filter.status !== undefined) all = all.filter(p => p.status === filter.status)
    if (filter.lane !== undefined) all = all.filter(p => p.lane === filter.lane)
    if (filter.targetKey !== undefined) all = all.filter(p => p.target_key === filter.targetKey)
    all.sort((a, b) => b.createdAt < a.createdAt ? -1 : 1)
    return all.slice(0, filter.limit ?? 50)
  }

  /**
   * Create a new proposal in `submitted` status.
   *
   * @param {object} fields - validated submission fields (lane, target_kind,
   *   target_key, requested_action, base_version, payload, evidence, checks, risk).
   * @param {{sessionId?: string}} origin - submitting session identity, when known.
   * @returns {object} the stored proposal.
   */
  create(fields, origin) {
    let id
    do {
      id = `p-${randomUUID().slice(0, 8)}`
    } while (this.state.proposals[id] !== undefined)
    const now = new Date().toISOString()
    const proposal = {
      id,
      ...fields,
      status: 'submitted',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: { actor: 'ai', ...origin },
      history: [{ time: now, from: null, to: 'submitted', actor: 'ai', via: 'tool' }],
    }
    this.state.proposals[id] = proposal
    this.#save()
    this.#audit({ proposalId: id, from: null, to: 'submitted', actor: 'ai', via: 'tool', targetKey: fields.target_key, baseVersion: fields.base_version })
    return proposal
  }

  /**
   * Record one admitted transition (the caller has already checked the
   * machine) and optionally merge extra record updates (resubmission payload,
   * apply outcome).
   *
   * @param {object} proposal - the stored proposal (mutated in place).
   * @param {string} to - new status.
   * @param {{actor: string, via: string, note?: string, updates?: Record<string, unknown>}} how - transition metadata.
   * @returns {object} the updated proposal.
   */
  transition(proposal, to, how) {
    const now = new Date().toISOString()
    const from = proposal.status
    proposal.status = to
    proposal.updatedAt = now
    if (how.updates) Object.assign(proposal, how.updates)
    const entry = { time: now, from, to, actor: how.actor, via: how.via, ...how.note ? { note: how.note } : {} }
    proposal.history.push(entry)
    this.#save()
    this.#audit({ proposalId: proposal.id, from, to, actor: how.actor, via: how.via, ...how.note ? { note: how.note } : {} })
    return proposal
  }

  /**
   * Record a refused apply (stale base_version) in the audit ledger without a
   * status change — the human sees the refusal text; the ledger keeps the
   * fact.
   *
   * @param {object} proposal - the accepted proposal that failed the version check.
   * @param {number} currentVersion - the target's committed version at refusal time.
   */
  auditStaleApply(proposal, currentVersion) {
    this.#audit({
      proposalId: proposal.id,
      kind: 'apply-stale',
      actor: 'human',
      via: 'command',
      targetKey: proposal.target_key,
      baseVersion: proposal.base_version,
      currentVersion,
    })
  }

  /**
   * Bump one target's committed version (called on apply).
   *
   * @param {string} targetKey - the applied proposal's target.
   * @returns {number} the new version.
   */
  bumpTarget(targetKey) {
    const next = this.targetVersion(targetKey) + 1
    this.state.targets[targetKey] = next
    this.#save()
    return next
  }

  /**
   * Expire every proposal sitting in a pre-decision status longer than
   * `expireAfterDays`. Called lazily from tool/command entry points.
   *
   * @param {number} days - configured expiry horizon.
   * @returns {string[]} ids expired by this sweep.
   */
  sweepExpired(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const expired = []
    for (const proposal of Object.values(this.state.proposals)) {
      if (!['submitted', 'in_review', 'changes_requested'].includes(proposal.status)) continue
      if (Date.parse(proposal.updatedAt) >= cutoff) continue
      this.transition(proposal, 'expired', { actor: 'system', via: 'system', note: `idle > ${days}d` })
      expired.push(proposal.id)
    }
    return expired
  }
}
