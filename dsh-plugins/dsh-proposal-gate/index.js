/**
 * dsh-proposal-gate — a human review channel for model-proposed changes.
 *
 * Models get three tools: `submit_proposal` / `withdraw_proposal` /
 * `list_proposals`. Review and apply exist ONLY as the `/proposal` human
 * command — the model has no tool that can accept, apply, or verify a
 * proposal, so authority separation is channel separation, not prompt
 * discipline. Proposals persist across sessions in a plugin-owned store
 * (`state.json` + append-only `events.jsonl` audit ledger under
 * `storePath`); every status change lands in the ledger with its actor class
 * (`ai` via tools, `human` via the command, `system` via the expiry sweep).
 *
 * Apply is version-checked: a proposal records the `base_version` of its
 * target at submission, and `/proposal apply` refuses when the target's
 * committed version has moved (the stale refusal is audited, the status stays
 * `accepted`). A fresh apply dispatches the `proposal-gate/apply` waterfall so
 * a deployment may mount an executor plugin that performs the payload's
 * action (and may gate each step through `ctx.approval` in its own turn
 * context); with no executor mounted the apply is recorded as `record-only`
 * and verification stays a human step. Vocabulary (lanes, target kinds,
 * requested actions, risk levels) is entirely config-owned.
 *
 * @module dsh-proposal-gate
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  checkTransition,
  HELP_TEXT,
  parseProposalCommand,
  validateConfig,
  validateSubmission,
} from './machine.js'
import { openStore } from './store.js'

export const name = 'proposal-gate'
export const inject = ['tools', 'commands']

/** Summary fields exposed by `list_proposals` (payload stays out of the list view). */
function summarize(proposal) {
  return {
    id: proposal.id,
    lane: proposal.lane,
    target_kind: proposal.target_kind,
    target_key: proposal.target_key,
    requested_action: proposal.requested_action,
    base_version: proposal.base_version,
    risk: proposal.risk,
    status: proposal.status,
    revision: proposal.revision,
    updatedAt: proposal.updatedAt,
  }
}

/** Submission fields copied verbatim into the stored record. */
function submissionFields(args) {
  return {
    lane: args.lane,
    target_kind: args.target_kind,
    target_key: args.target_key,
    requested_action: args.requested_action,
    base_version: args.base_version,
    payload: args.payload,
    evidence: args.evidence,
    checks: args.checks,
    risk: args.risk,
  }
}

/** One-line human rendering of a proposal for command output. */
function line(proposal) {
  return `${proposal.id} [${proposal.status}] ${proposal.lane}/${proposal.target_kind} ${proposal.target_key}`
    + ` action=${proposal.requested_action} risk=${proposal.risk} base=${proposal.base_version} rev=${proposal.revision}`
}

/**
 * Install the proposal tools, the `/proposal` human command, and the apply
 * extension point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - raw row config; validated fail-loud here.
 */
export function apply(ctx, rawConfig) {
  const config = validateConfig(rawConfig)
  const store = openStore(config.storePath)

  /** Lazy expiry sweep on every entry point (no timer to leak). */
  function sweep() {
    if (config.expireAfterDays !== undefined) store.sweepExpired(config.expireAfterDays)
  }

  const evidenceSchema = {
    type: 'object',
    required: true,
    additionalProperties: false,
    description: 'Structured evidence for the reviewer. With requireEvidence on (default), `for` must be non-empty.',
    properties: {
      for: { type: 'array', required: true, items: { type: 'string' }, description: 'Facts supporting the change.' },
      against: { type: 'array', required: true, items: { type: 'string' }, description: 'Facts against it, if any.' },
      unknowns: { type: 'array', required: true, items: { type: 'string' }, description: 'Open questions the reviewer should know.' },
    },
  }

  ctx.tools.register(defineTool({
    name: 'submit_proposal',
    description:
      'Submit a structured change proposal for human review, or resubmit a revision when the reviewer requested changes (pass proposal_id). '
      + 'Proposals are applied only by a human command after review; submitting grants nothing. '
      + 'Take base_version for your target from list_proposals.',
    parameters: {
      lane: { type: 'string', required: true, enum: [...config.lanes], description: 'Review lane.' },
      target_kind: { type: 'string', required: true, enum: [...config.targetKinds], description: 'What kind of thing the proposal changes.' },
      target_key: { type: 'string', required: true, description: 'Stable identity of the thing being changed (deployment-defined).' },
      requested_action: { type: 'string', required: true, enum: [...config.requestedActions], description: 'The action the human would perform on apply.' },
      base_version: { type: 'integer', required: true, description: 'The target version this proposal was written against (from list_proposals targets; 0 for a new target).' },
      payload: { type: 'object', required: true, additionalProperties: true, description: 'The proposed change itself, in the deployment\'s own fields.' },
      evidence: evidenceSchema,
      checks: { type: 'array', required: true, items: { type: 'string' }, description: 'What the reviewer or CI should verify before/after apply.' },
      risk: { type: 'string', required: true, enum: [...config.riskLevels], description: 'Self-assessed risk level.' },
      proposal_id: { type: 'string', description: 'Resubmission only: the changes_requested proposal this revision replaces.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          current_target_version: { type: 'integer', required: true },
          stale_at_submit: { type: 'boolean', required: true, description: 'True when base_version already trails the target; apply will refuse until resubmitted against the current version.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Proposal ${value.id} ${value.status} (rev ${value.revision}); target version ${value.current_target_version}`
          + (value.stale_at_submit ? ' — WARNING: base_version is already stale.' : '.'),
      }],
    },
    execute(args, exec) {
      sweep()
      const reason = validateSubmission(args, config)
      if (reason !== undefined) throw new Error(`proposal rejected: ${reason}`)
      const origin = exec.agent ? { sessionId: exec.agent.session.id } : {}
      let proposal
      if (args.proposal_id !== undefined) {
        proposal = store.get(args.proposal_id)
        if (proposal === undefined) throw new Error(`proposal "${args.proposal_id}" not found`)
        const admitted = checkTransition(proposal.status, 'submitted', 'ai')
        if (!admitted.ok) throw new Error(`resubmission refused: ${admitted.reason}`)
        proposal = store.transition(proposal, 'submitted', {
          actor: 'ai',
          via: 'tool',
          note: 'resubmission',
          updates: { ...submissionFields(args), revision: proposal.revision + 1 },
        })
      } else {
        proposal = store.create(submissionFields(args), origin)
      }
      const currentVersion = store.targetVersion(args.target_key)
      return Promise.resolve({
        id: proposal.id,
        status: proposal.status,
        revision: proposal.revision,
        current_target_version: currentVersion,
        stale_at_submit: args.base_version !== currentVersion,
      })
    },
    presentCall: args => ({ card: 'generic', title: `Submit proposal: ${args.target_key}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'withdraw_proposal',
    description: 'Withdraw your own pending proposal (submitted, in_review, or changes_requested). Terminal.',
    parameters: {
      proposal_id: { type: 'string', required: true, description: 'The proposal to withdraw.' },
      reason: { type: 'string', description: 'Why it is withdrawn.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Proposal ${value.id} ${value.status}.` }],
    },
    execute(args) {
      sweep()
      const proposal = store.get(args.proposal_id)
      if (proposal === undefined) throw new Error(`proposal "${args.proposal_id}" not found`)
      const admitted = checkTransition(proposal.status, 'withdrawn', 'ai')
      if (!admitted.ok) throw new Error(`withdraw refused: ${admitted.reason}`)
      store.transition(proposal, 'withdrawn', { actor: 'ai', via: 'tool', ...args.reason ? { note: args.reason } : {} })
      return Promise.resolve({ id: proposal.id, status: proposal.status })
    },
    presentCall: args => ({ card: 'generic', title: `Withdraw proposal ${args.proposal_id}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'list_proposals',
    description: 'List proposals (newest first) and every known target version. Use the versions as base_version when submitting.',
    parameters: {
      status: { type: 'string', description: 'Filter by status.' },
      lane: { type: 'string', description: 'Filter by lane.' },
      target_key: { type: 'string', description: 'Filter by target.' },
      limit: { type: 'integer', description: 'Maximum entries (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposals: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                lane: { type: 'string', required: true },
                target_kind: { type: 'string', required: true },
                target_key: { type: 'string', required: true },
                requested_action: { type: 'string', required: true },
                base_version: { type: 'integer', required: true },
                risk: { type: 'string', required: true },
                status: { type: 'string', required: true },
                revision: { type: 'integer', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
          targets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                target_key: { type: 'string', required: true },
                version: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.proposals.length} proposal(s); ${value.targets.length} known target version(s).`,
      }],
    },
    execute(args) {
      sweep()
      const proposals = store.list({
        status: args.status,
        lane: args.lane,
        targetKey: args.target_key,
        limit: args.limit,
      }).map(summarize)
      const targets = Object.entries(store.targets())
        .map(([targetKey, version]) => ({ target_key: targetKey, version }))
      return Promise.resolve({ proposals, targets })
    },
    presentCall: () => ({ card: 'generic', title: 'List proposals', kind: 'read' }),
  }))

  ctx.commands.register({
    name: 'proposal',
    description: 'Review, apply, verify, or expire model-submitted proposals (human-only channel).',
    input: { hint: 'list | show <id> | review <id> accept|reject|changes|in-review [note] | apply <id> | verify <id> ok|rolled-back | expire <id>' },
    async handler(invocation) {
      sweep()
      const parsed = parseProposalCommand(invocation.rawInput)
      if (parsed.kind === 'error') return { kind: 'error', text: `${parsed.message}\n${HELP_TEXT}` }
      if (parsed.kind === 'help') return { kind: 'success', text: HELP_TEXT }
      if (parsed.kind === 'list') {
        const proposals = store.list(parsed.status === undefined ? {} : { status: parsed.status })
        if (proposals.length === 0) return { kind: 'success', text: 'no proposals' }
        return { kind: 'success', text: proposals.map(line).join('\n') }
      }
      const proposal = store.get(parsed.id)
      if (proposal === undefined) return { kind: 'error', text: `proposal "${parsed.id}" not found` }
      switch (parsed.kind) {
        case 'show':
          return { kind: 'success', text: JSON.stringify(proposal, null, 2) }
        case 'review':
        case 'verify':
        case 'expire': {
          const to = parsed.kind === 'expire' ? 'expired' : parsed.to
          const admitted = checkTransition(proposal.status, to, 'human')
          if (!admitted.ok) return { kind: 'error', text: admitted.reason }
          store.transition(proposal, to, { actor: 'human', via: 'command', ...parsed.note ? { note: parsed.note } : {} })
          return { kind: 'success', text: line(proposal) }
        }
        case 'apply': {
          const admitted = checkTransition(proposal.status, 'applied', 'human')
          if (!admitted.ok) return { kind: 'error', text: admitted.reason }
          const currentVersion = store.targetVersion(proposal.target_key)
          if (proposal.base_version !== currentVersion) {
            store.auditStaleApply(proposal, currentVersion)
            return {
              kind: 'error',
              text: `stale: proposal base_version ${proposal.base_version} != target "${proposal.target_key}" current version ${currentVersion}; `
                + 'ask for a resubmission against the current version (review … changes), or reject.',
            }
          }
          // Executor extension point: a deployment mounts a listener that
          // performs the payload's action and returns {kind:'executed',
          // detail?}. No listener → the innermost fallback records the apply
          // without side effects.
          const outcome = await ctx.waterfall(
            'proposal-gate/apply',
            { proposal: structuredClone(proposal), agent: invocation.agent, signal: invocation.signal },
            () => Promise.resolve({ kind: 'record-only' }),
          )
          if (outcome === null || typeof outcome !== 'object' || typeof outcome.kind !== 'string') {
            return { kind: 'error', text: 'apply executor returned a malformed outcome (expected {kind: string}); nothing was recorded' }
          }
          const note = [`apply:${outcome.kind}`, outcome.detail, parsed.note].filter(Boolean).join(' — ')
          store.transition(proposal, 'applied', { actor: 'human', via: 'command', note, updates: { applyOutcome: outcome.kind } })
          const newVersion = store.bumpTarget(proposal.target_key)
          return { kind: 'success', text: `${line(proposal)}\napply outcome: ${outcome.kind}; target version now ${newVersion}` }
        }
        default:
          return { kind: 'error', text: HELP_TEXT }
      }
    },
  })
}
