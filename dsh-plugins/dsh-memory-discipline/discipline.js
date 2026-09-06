/**
 * Pure memory-discipline logic: config validation, policy-text rendering with
 * tool-name interpolation, and the model-facing notice texts. No Cordis or
 * harness imports so the module unit-tests without a harness install;
 * `index.js` owns the plugin wiring.
 *
 * @module dsh-memory-discipline/discipline
 */

/** Fail-loud config error prefix shared by every validation throw. */
const BAD = 'dsh-memory-discipline: invalid config —'

/** Model-facing registered tool names (DeepSeek function-name contract). */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Placeholder keys usable as `{key}` inside policy lines. */
const PLACEHOLDER_KEY_PATTERN = /^[A-Za-z0-9_-]+$/

/** The complete set of accepted config keys; anything else is a typo and fails loud. */
const KNOWN_KEYS = new Set([
  'hotContextTool',
  'autoFetch',
  'policyLines',
  'toolVocabulary',
  'sectionOrder',
  'toolWaitAttempts',
  'toolWaitDelayMs',
  'callTimeoutMs',
  'toolRetryAttempts',
  'toolRetryDelayMs',
  'lateRegistrationMaxWaitMs',
])

/**
 * Default placeholder→tool-name vocabulary referenced by the built-in policy
 * lines. A configured `toolVocabulary` replaces this map wholesale; the `hot`
 * placeholder is always bound to `hotContextTool` on top of either map.
 */
export const DEFAULT_TOOL_VOCABULARY = Object.freeze({
  route: 'route_memory',
  search: 'search_memories',
  add: 'add_memory',
})

/** Explicit defaults for every non-required scalar config field. */
export const CONFIG_DEFAULTS = Object.freeze({
  hotContextTool: 'get_hot_context',
  autoFetch: true,
  sectionOrder: 150,
  toolWaitAttempts: 10,
  toolWaitDelayMs: 500,
  callTimeoutMs: 30_000,
  toolRetryAttempts: 2,
  toolRetryDelayMs: 1500,
  // Upper bound for the late-registration backfill listener (B1): once the
  // startup wait budget expires, keep listening this long for the hot-context
  // tool to appear and then inject one backfill notice for the same session.
  // The listener also dies with the plugin's disposal signal, whichever comes
  // first, so no orphan watcher outlives either boundary.
  lateRegistrationMaxWaitMs: 120_000,
})

/**
 * Built-in English policy lines. `{hot}`, `{route}`, `{search}`, and `{add}`
 * interpolate from the resolved tool vocabulary. The second line depends on
 * `autoFetch`: with automatic seeding the model must not re-fetch; without it
 * the model is instructed to fetch once itself.
 *
 * @param {boolean} autoFetch - whether the plugin seeds hot context automatically.
 * @returns {string[]} the policy lines before interpolation.
 */
export function defaultPolicyLines(autoFetch) {
  return [
    'Treat the configured memory toolset as the single persistent source of memory across sessions.',
    autoFetch
      ? 'Hot memory context is loaded automatically once per session start and injected as a notice; do not fetch it again unless it is reported unavailable — then call {hot} once yourself.'
      : 'At the start of each session, call {hot} once to load hot memory context before other work.',
    'When past context may matter, call {route} first, then search only the one or two explicit memory stores it returns, using {search}.',
    'Consult a broad index or catalog only when the hot context leaves the target store unclear; full-library search is the last resort.',
    'Save only durable facts, preferences, decisions, constraints, goals, and reusable knowledge, using {add}; do not store transient task chatter.',
    'Never claim an unavailable or failed memory operation succeeded; report memory failures plainly.',
  ]
}

/**
 * Validate one registered tool name.
 *
 * @param {unknown} value - candidate tool name.
 * @param {string} label - config key used in error messages.
 * @returns {string} the validated tool name.
 */
function validateToolName(value, label) {
  if (typeof value !== 'string' || !TOOL_NAME_PATTERN.test(value)) {
    throw new Error(`${BAD} \`${label}\` must be a registered tool name matching ${String(TOOL_NAME_PATTERN)}`)
  }
  return value
}

/**
 * Validate one finite number with a lower bound.
 *
 * @param {unknown} value - candidate number.
 * @param {string} label - config key used in error messages.
 * @param {{ min: number, integer?: boolean }} bounds - inclusive lower bound and integrality.
 * @returns {number} the validated number.
 */
function validateNumber(value, label, bounds) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < bounds.min
    || (bounds.integer === true && !Number.isInteger(value))) {
    const kind = bounds.integer === true ? 'an integer' : 'a finite number'
    throw new Error(`${BAD} \`${label}\` must be ${kind} >= ${bounds.min}`)
  }
  return value
}

/**
 * Validate raw cordis config into a normalized shape, throwing on any
 * misconfiguration (fail loud at plugin load, never a silent fallback).
 * Unknown keys are rejected so a typo cannot silently fall back to a default.
 *
 * @param {unknown} raw - the row's `config` value as the Loader passed it (may be undefined).
 * @returns {{ hotContextTool: string, autoFetch: boolean,
 *            policyLines: string[] | undefined,
 *            toolVocabulary: Record<string, string>,
 *            sectionOrder: number, toolWaitAttempts: number,
 *            toolWaitDelayMs: number, callTimeoutMs: number,
 *            toolRetryAttempts: number, toolRetryDelayMs: number,
 *            lateRegistrationMaxWaitMs: number }} normalized config.
 */
export function validateConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${BAD} config must be an object (or omitted for all defaults)`)
  }
  const config = /** @type {Record<string, unknown>} */ (raw)
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`${BAD} unknown key \`${key}\``)
  }

  const hotContextTool = config.hotContextTool === undefined
    ? CONFIG_DEFAULTS.hotContextTool
    : validateToolName(config.hotContextTool, 'hotContextTool')

  if (config.autoFetch !== undefined && typeof config.autoFetch !== 'boolean') {
    throw new Error(`${BAD} \`autoFetch\` must be a boolean`)
  }
  const autoFetch = config.autoFetch === undefined ? CONFIG_DEFAULTS.autoFetch : config.autoFetch

  let policyLines
  if (config.policyLines !== undefined) {
    if (!Array.isArray(config.policyLines) || config.policyLines.length === 0
      || config.policyLines.some(line => typeof line !== 'string' || line.trim() === '')) {
      throw new Error(`${BAD} \`policyLines\` must be a non-empty array of non-empty strings`)
    }
    policyLines = config.policyLines.map(line => /** @type {string} */ (line).trim())
  }

  let vocabularyBase = DEFAULT_TOOL_VOCABULARY
  if (config.toolVocabulary !== undefined) {
    const map = config.toolVocabulary
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error(`${BAD} \`toolVocabulary\` must be an object mapping placeholder keys to tool names`)
    }
    for (const [key, value] of Object.entries(map)) {
      if (!PLACEHOLDER_KEY_PATTERN.test(key)) {
        throw new Error(`${BAD} toolVocabulary key \`${key}\` must match ${String(PLACEHOLDER_KEY_PATTERN)}`)
      }
      validateToolName(value, `toolVocabulary.${key}`)
    }
    const hot = /** @type {Record<string, unknown>} */ (map).hot
    if (hot !== undefined && hot !== hotContextTool) {
      throw new Error(`${BAD} toolVocabulary.hot (${JSON.stringify(hot)}) conflicts with hotContextTool (${JSON.stringify(hotContextTool)}); \`hot\` is always bound to hotContextTool — omit it or make them equal`)
    }
    vocabularyBase = /** @type {Record<string, string>} */ (map)
  }
  const toolVocabulary = { ...vocabularyBase, hot: hotContextTool }

  const resolved = {
    hotContextTool,
    autoFetch,
    policyLines,
    toolVocabulary,
    sectionOrder: config.sectionOrder === undefined
      ? CONFIG_DEFAULTS.sectionOrder
      : validateNumber(config.sectionOrder, 'sectionOrder', { min: -Number.MAX_VALUE }),
    toolWaitAttempts: config.toolWaitAttempts === undefined
      ? CONFIG_DEFAULTS.toolWaitAttempts
      : validateNumber(config.toolWaitAttempts, 'toolWaitAttempts', { min: 1, integer: true }),
    toolWaitDelayMs: config.toolWaitDelayMs === undefined
      ? CONFIG_DEFAULTS.toolWaitDelayMs
      : validateNumber(config.toolWaitDelayMs, 'toolWaitDelayMs', { min: 0 }),
    callTimeoutMs: config.callTimeoutMs === undefined
      ? CONFIG_DEFAULTS.callTimeoutMs
      : validateNumber(config.callTimeoutMs, 'callTimeoutMs', { min: 1 }),
    toolRetryAttempts: config.toolRetryAttempts === undefined
      ? CONFIG_DEFAULTS.toolRetryAttempts
      : validateNumber(config.toolRetryAttempts, 'toolRetryAttempts', { min: 0, integer: true }),
    toolRetryDelayMs: config.toolRetryDelayMs === undefined
      ? CONFIG_DEFAULTS.toolRetryDelayMs
      : validateNumber(config.toolRetryDelayMs, 'toolRetryDelayMs', { min: 0 }),
    lateRegistrationMaxWaitMs: config.lateRegistrationMaxWaitMs === undefined
      ? CONFIG_DEFAULTS.lateRegistrationMaxWaitMs
      : validateNumber(config.lateRegistrationMaxWaitMs, 'lateRegistrationMaxWaitMs', { min: 1 }),
  }
  // Fail at load, not at first assembly: rendering validates every placeholder
  // against the resolved vocabulary.
  renderPolicyText(resolved)
  return resolved
}

/**
 * Interpolate `{key}` placeholders in one policy line from the vocabulary.
 * An unknown key throws — a policy line that names a missing tool is
 * misconfiguration, not a literal brace to preserve.
 *
 * @param {string} line - one policy line.
 * @param {Record<string, string>} vocabulary - placeholder→tool-name map.
 * @returns {string} the interpolated line.
 */
export function interpolatePolicyLine(line, vocabulary) {
  return line.replaceAll(/\{([A-Za-z0-9_-]+)\}/g, (_match, key) => {
    const tool = vocabulary[key]
    if (tool === undefined) {
      throw new Error(`${BAD} policy line references unknown tool placeholder {${key}} (vocabulary keys: ${Object.keys(vocabulary).sort().join(', ')})`)
    }
    return tool
  })
}

/**
 * Render the complete system-prompt section text. The result is a pure
 * function of the validated config, so the section is byte-stable across
 * assemblies (KV-cache friendly).
 *
 * @param {ReturnType<typeof validateConfig>} config - validated config.
 * @returns {string} the section text.
 */
export function renderPolicyText(config) {
  const lines = config.policyLines ?? defaultPolicyLines(config.autoFetch)
  const rendered = lines.map(line => `- ${interpolatePolicyLine(line, config.toolVocabulary)}`)
  return `Memory discipline:\n${rendered.join('\n')}`
}

/**
 * Join the text blocks of a tool result into the notice body.
 *
 * @param {readonly { type: string, text?: string }[]} content - model-facing result blocks.
 * @returns {string} concatenated text, trimmed; empty when no text blocks exist.
 */
export function extractResultText(content) {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => /** @type {string} */ (block.text))
    .join('\n')
    .trim()
}

/**
 * Model-facing notice for successfully fetched hot context.
 *
 * @param {string} hotContextTool - the tool the context came from.
 * @param {string} body - the fetched hot-context text (non-empty).
 * @returns {{ text: string, summary: string }} injected text and one-line summary.
 */
export function buildHotContextNotice(hotContextTool, body) {
  return {
    text: `Hot memory context, loaded automatically at session start via ${hotContextTool}:\n\n${body}`,
    summary: 'Hot memory context loaded at session start.',
  }
}

/**
 * Model-facing notice when hot context cannot be fetched. The session
 * continues; the model is told not to fabricate remembered facts.
 *
 * @param {string} hotContextTool - the tool that was expected to provide context.
 * @param {string} reason - short English failure description.
 * @returns {{ text: string, summary: string }} injected text and one-line summary.
 */
export function buildMemoryUnavailableNotice(hotContextTool, reason) {
  return {
    text: `Memory notice: hot memory context is unavailable for this session (${reason}). Continue without stored memory, do not fabricate remembered facts, and report memory as unavailable if asked about it. If ${hotContextTool} becomes available later in the session, you may retry it once.`,
    summary: 'Memory unavailable at session start.',
  }
}
