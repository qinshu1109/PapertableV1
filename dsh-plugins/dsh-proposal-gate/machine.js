/**
 * Pure proposal state machine and config/submission validation. No I/O and no
 * Cordis imports; `store.js` owns persistence and `index.js` owns wiring, so
 * every rule here unit-tests without a harness install.
 *
 * Statuses and edges (actor classes in brackets):
 *
 *   submitted          → in_review | accepted | rejected | changes_requested | expired [human/system]
 *                      → withdrawn [ai]
 *   in_review          → accepted | rejected | changes_requested | expired [human/system]
 *                      → withdrawn [ai]
 *   changes_requested  → submitted (resubmission) [ai]
 *                      → withdrawn [ai], expired [human/system]
 *   accepted           → applied [human]
 *                      → rejected | changes_requested [human] (acceptance recall —
 *                        the stale-apply recovery: refuse, then request a rebase)
 *   applied            → verified | rolled_back [human]
 *   rejected / expired / withdrawn / verified / rolled_back are terminal.
 *
 * The review/apply edges are reachable only from human commands (the plugin
 * registers no model-facing tool for them); the ai edges are reachable only
 * from tools. `expired` may also be produced by the system sweep.
 *
 * @module dsh-proposal-gate/machine
 */

/** Every proposal status. */
export const STATUSES = [
  'submitted',
  'in_review',
  'changes_requested',
  'accepted',
  'rejected',
  'expired',
  'withdrawn',
  'applied',
  'verified',
  'rolled_back',
]

/** Actor classes recorded on every transition. */
export const ACTORS = ['ai', 'human', 'system']

/**
 * Allowed transitions: `from → { to: allowed actor classes }`. Terminal
 * statuses have no outgoing edges.
 */
const TRANSITIONS = {
  submitted: {
    in_review: ['human'],
    accepted: ['human'],
    rejected: ['human'],
    changes_requested: ['human'],
    expired: ['human', 'system'],
    withdrawn: ['ai'],
  },
  in_review: {
    accepted: ['human'],
    rejected: ['human'],
    changes_requested: ['human'],
    expired: ['human', 'system'],
    withdrawn: ['ai'],
  },
  changes_requested: {
    submitted: ['ai'],
    withdrawn: ['ai'],
    expired: ['human', 'system'],
  },
  accepted: {
    applied: ['human'],
    rejected: ['human'],
    changes_requested: ['human'],
  },
  applied: {
    verified: ['human'],
    rolled_back: ['human'],
  },
  rejected: {},
  expired: {},
  withdrawn: {},
  verified: {},
  rolled_back: {},
}

/** Fail-loud config error prefix. */
const BAD = 'dsh-proposal-gate: invalid config —'

/**
 * Validate one non-empty string-array vocabulary field.
 *
 * @param {unknown} value - raw config value.
 * @param {string} label - config key for error messages.
 * @returns {string[]} the validated vocabulary.
 */
function validateVocabulary(value, label) {
  if (!Array.isArray(value) || value.length === 0
    || value.some(item => typeof item !== 'string' || item === '')) {
    throw new Error(`${BAD} \`${label}\` must be a non-empty array of non-empty strings`)
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${BAD} \`${label}\` must not contain duplicates`)
  }
  return value
}

/**
 * Validate raw cordis config into a normalized shape, throwing on any
 * misconfiguration (fail loud at plugin load).
 *
 * @param {unknown} raw - the row's `config` value as the Loader passed it.
 * @returns {{ storePath: string, lanes: string[], targetKinds: string[],
 *            requestedActions: string[], riskLevels: string[],
 *            requireEvidence: boolean, expireAfterDays: number | undefined }} normalized config.
 */
export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${BAD} config must be an object`)
  }
  const config = /** @type {Record<string, unknown>} */ (raw)
  if (typeof config.storePath !== 'string' || config.storePath === '') {
    throw new Error(`${BAD} \`storePath\` must be a non-empty string (the bundle default layer derives it from the harness home)`)
  }
  const requireEvidence = config.requireEvidence === undefined ? true : config.requireEvidence
  if (typeof requireEvidence !== 'boolean') {
    throw new Error(`${BAD} \`requireEvidence\` must be a boolean`)
  }
  let expireAfterDays
  if (config.expireAfterDays !== undefined) {
    if (typeof config.expireAfterDays !== 'number' || !Number.isInteger(config.expireAfterDays) || config.expireAfterDays < 1) {
      throw new Error(`${BAD} \`expireAfterDays\` must be a positive integer when set`)
    }
    expireAfterDays = config.expireAfterDays
  }
  return {
    storePath: config.storePath,
    lanes: validateVocabulary(config.lanes, 'lanes'),
    targetKinds: validateVocabulary(config.targetKinds, 'targetKinds'),
    requestedActions: validateVocabulary(config.requestedActions, 'requestedActions'),
    riskLevels: validateVocabulary(config.riskLevels, 'riskLevels'),
    requireEvidence,
    expireAfterDays,
  }
}

/**
 * Check one transition against the machine and the acting class.
 *
 * @param {string} from - current status.
 * @param {string} to - requested status.
 * @param {string} actor - one of {@link ACTORS}.
 * @returns {{ok: true} | {ok: false, reason: string}} the admission decision.
 */
export function checkTransition(from, to, actor) {
  const edges = TRANSITIONS[from]
  if (edges === undefined) return { ok: false, reason: `unknown status "${from}"` }
  const allowed = edges[to]
  if (allowed === undefined) {
    const outgoing = Object.keys(edges)
    return {
      ok: false,
      reason: outgoing.length === 0
        ? `status "${from}" is terminal`
        : `illegal transition ${from} → ${to} (allowed: ${outgoing.join(', ')})`,
    }
  }
  if (!allowed.includes(actor)) {
    return { ok: false, reason: `actor "${actor}" may not perform ${from} → ${to} (allowed: ${allowed.join(', ')})` }
  }
  return { ok: true }
}

/**
 * Validate a submission's vocabulary and evidence against config. Field
 * presence/types are already enforced by the tool parameter schema; this owns
 * the value-level rules.
 *
 * @param {{lane: string, target_kind: string, target_key: string, requested_action: string,
 *          base_version: number, risk: string,
 *          evidence: {for: string[], against: string[], unknowns: string[]}, checks: string[]}} args - schema-checked tool arguments.
 * @param {ReturnType<typeof validateConfig>} config - validated plugin config.
 * @returns {string | undefined} a rejection reason, or undefined when valid.
 */
export function validateSubmission(args, config) {
  if (!config.lanes.includes(args.lane)) {
    return `unknown lane "${args.lane}" (configured: ${config.lanes.join(', ')})`
  }
  if (!config.targetKinds.includes(args.target_kind)) {
    return `unknown target_kind "${args.target_kind}" (configured: ${config.targetKinds.join(', ')})`
  }
  if (!config.requestedActions.includes(args.requested_action)) {
    return `unknown requested_action "${args.requested_action}" (configured: ${config.requestedActions.join(', ')})`
  }
  if (!config.riskLevels.includes(args.risk)) {
    return `unknown risk "${args.risk}" (configured: ${config.riskLevels.join(', ')})`
  }
  if (args.target_key.trim() === '') {
    return 'target_key must not be blank'
  }
  if (!Number.isInteger(args.base_version) || args.base_version < 0) {
    return 'base_version must be a non-negative integer (take it from list_proposals targets)'
  }
  if (config.requireEvidence && args.evidence.for.length === 0) {
    return 'evidence.for must contain at least one entry (requireEvidence is on)'
  }
  return undefined
}

/**
 * Parse a `/proposal` command line into a subcommand invocation. Pure text
 * parsing; existence and state checks stay with the command handler.
 *
 * Grammar: `list [status]` | `show <id>` | `review <id> <verdict> [note…]`
 * | `apply <id> [note…]` | `verify <id> ok|rolled-back [note…]`
 * | `expire <id> [note…]`.
 *
 * @param {string} rawInput - exact text after the command name.
 * @returns {{kind: string} & Record<string, string> | {kind: 'error', message: string}} the parsed invocation.
 */
export function parseProposalCommand(rawInput) {
  const words = rawInput.trim().split(/\s+/u).filter(word => word !== '')
  const [sub, ...rest] = words
  const note = (skip) => rest.slice(skip).join(' ')
  switch (sub) {
    case undefined:
    case 'help':
      return { kind: 'help' }
    case 'list':
      if (rest.length > 1) return { kind: 'error', message: 'usage: list [status]' }
      return rest[0] === undefined ? { kind: 'list' } : { kind: 'list', status: rest[0] }
    case 'show':
      if (rest.length !== 1) return { kind: 'error', message: 'usage: show <id>' }
      return { kind: 'show', id: rest[0] }
    case 'review': {
      const verdicts = { 'accept': 'accepted', 'reject': 'rejected', 'changes': 'changes_requested', 'in-review': 'in_review' }
      const to = verdicts[rest[1]]
      if (rest[0] === undefined || to === undefined) {
        return { kind: 'error', message: 'usage: review <id> accept|reject|changes|in-review [note]' }
      }
      return { kind: 'review', id: rest[0], to, note: note(2) }
    }
    case 'apply':
      if (rest[0] === undefined) return { kind: 'error', message: 'usage: apply <id> [note]' }
      return { kind: 'apply', id: rest[0], note: note(1) }
    case 'verify': {
      const outcomes = { 'ok': 'verified', 'rolled-back': 'rolled_back' }
      const to = outcomes[rest[1]]
      if (rest[0] === undefined || to === undefined) {
        return { kind: 'error', message: 'usage: verify <id> ok|rolled-back [note]' }
      }
      return { kind: 'verify', id: rest[0], to, note: note(2) }
    }
    case 'expire':
      if (rest[0] === undefined) return { kind: 'error', message: 'usage: expire <id> [note]' }
      return { kind: 'expire', id: rest[0], note: note(1) }
    default:
      return { kind: 'error', message: `unknown subcommand "${sub}" (try: help)` }
  }
}

/** Command usage text returned by `/proposal help` (and bad syntax). */
export const HELP_TEXT = [
  'proposal — human review channel for model-submitted proposals',
  '  list [status]                          list proposals (newest first)',
  '  show <id>                              full proposal record',
  '  review <id> accept|reject|changes|in-review [note]',
  '  apply <id> [note]                      apply an accepted proposal (stale base_version is refused)',
  '  verify <id> ok|rolled-back [note]      settle an applied proposal',
  '  expire <id> [note]                     expire a stale proposal',
  'Models submit via the submit_proposal tool; review/apply exist only as this human command.',
].join('\n')
