/**
 * Pure guardrails logic: config validation, rule compilation, and the
 * per-tool-call decision. No Cordis imports so the module unit-tests without a
 * harness install; `index.js` owns the plugin wiring.
 *
 * @module dsh-guardrails/guardrails
 */

import picomatch from 'picomatch'

/**
 * Default mapping from shipped dsh write-capable tools to the argument that
 * carries the filesystem target. `str_replace_editor` is read-only under its
 * `view` command, so that command is skipped. Deployments may replace the list
 * wholesale from cordis config (`pathTools`).
 */
export const DEFAULT_PATH_TOOLS = [
  { tool: 'write', argument: 'file_path' },
  { tool: 'edit', argument: 'file_path' },
  {
    tool: 'str_replace_editor',
    argument: 'path',
    skipWhen: { argument: 'command', equals: ['view'] },
  },
]

/**
 * Default command-text tools: their single string argument is scanned
 * conservatively for protected-path hits. Deployments may replace the list
 * from cordis config (`commandTools`).
 */
export const DEFAULT_COMMAND_TOOLS = [
  { tool: 'bash', argument: 'command' },
  { tool: 'pwsh', argument: 'command' },
]

/** Fail-loud config error prefix shared by every validation throw. */
const BAD = 'dsh-guardrails: invalid config —'

/**
 * Validate raw cordis config into a normalized shape, throwing on any
 * misconfiguration (fail loud at plugin load, never a silent fallback).
 *
 * @param {unknown} raw - the row's `config` value as the Loader passed it.
 * @returns {{ protected: {glob: string, reason: string}[],
 *            pathTools: {tool: string, argument: string, skipWhen?: {argument: string, equals: string[]}}[],
 *            commandTools: {tool: string, argument: string}[] }} normalized config.
 */
export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${BAD} config must be an object with a \`protected\` list`)
  }
  const config = /** @type {Record<string, unknown>} */ (raw)
  const rules = config.protected
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(`${BAD} \`protected\` must be a non-empty array of {glob, reason}`)
  }
  const seen = new Set()
  for (const [i, rule] of rules.entries()) {
    if (rule === null || typeof rule !== 'object'
      || typeof (/** @type {Record<string, unknown>} */ (rule).glob) !== 'string'
      || /** @type {Record<string, unknown>} */ (rule).glob === ''
      || typeof (/** @type {Record<string, unknown>} */ (rule).reason) !== 'string'
      || /** @type {Record<string, unknown>} */ (rule).reason === '') {
      throw new Error(`${BAD} protected[${i}] must be {glob: non-empty string, reason: non-empty string}`)
    }
    const glob = /** @type {{glob: string}} */ (rule).glob
    if (seen.has(glob)) throw new Error(`${BAD} duplicate protected glob "${glob}"`)
    seen.add(glob)
  }
  const pathTools = config.pathTools === undefined
    ? DEFAULT_PATH_TOOLS
    : validateToolList(config.pathTools, 'pathTools', true)
  const commandTools = config.commandTools === undefined
    ? DEFAULT_COMMAND_TOOLS
    : validateToolList(config.commandTools, 'commandTools', false)
  return {
    protected: rules.map(rule => ({
      glob: /** @type {{glob: string}} */ (rule).glob,
      reason: /** @type {{reason: string}} */ (rule).reason,
    })),
    pathTools,
    commandTools,
  }
}

/**
 * Validate one tool-mapping list (`pathTools` or `commandTools`).
 *
 * @param {unknown} value - raw list from config.
 * @param {string} label - config key used in error messages.
 * @param {boolean} allowSkipWhen - whether `skipWhen` clauses are legal here.
 * @returns {{tool: string, argument: string, skipWhen?: {argument: string, equals: string[]}}[]} the validated list.
 */
function validateToolList(value, label, allowSkipWhen) {
  if (!Array.isArray(value)) throw new Error(`${BAD} \`${label}\` must be an array`)
  return value.map((entry, i) => {
    if (entry === null || typeof entry !== 'object'
      || typeof (/** @type {Record<string, unknown>} */ (entry).tool) !== 'string'
      || typeof (/** @type {Record<string, unknown>} */ (entry).argument) !== 'string') {
      throw new Error(`${BAD} ${label}[${i}] must be {tool: string, argument: string}`)
    }
    const record = /** @type {Record<string, unknown>} */ (entry)
    const result = { tool: /** @type {string} */ (record.tool), argument: /** @type {string} */ (record.argument) }
    if (record.skipWhen !== undefined) {
      if (!allowSkipWhen) throw new Error(`${BAD} ${label}[${i}].skipWhen is not supported here`)
      const skip = /** @type {Record<string, unknown>} */ (record.skipWhen)
      if (skip === null || typeof skip !== 'object'
        || typeof skip.argument !== 'string'
        || !Array.isArray(skip.equals)
        || skip.equals.some(v => typeof v !== 'string')) {
        throw new Error(`${BAD} ${label}[${i}].skipWhen must be {argument: string, equals: string[]}`)
      }
      return { ...result, skipWhen: { argument: /** @type {string} */ (skip.argument), equals: /** @type {string[]} */ (skip.equals) } }
    }
    return result
  })
}

/**
 * Compile validated config into matchers. A relative glob also matches at any
 * depth (an any-depth `**` prefix is added), so `scripts/verify-*.ts` protects
 * that path under any workspace root, absolute or relative.
 *
 * @param {ReturnType<typeof validateConfig>} config - validated config.
 * @returns {{rules: {glob: string, reason: string, match: (path: string) => boolean, staticBase: string}[],
 *            pathTools: Map<string, ReturnType<typeof validateConfig>['pathTools'][number]>,
 *            commandTools: Map<string, ReturnType<typeof validateConfig>['commandTools'][number]>}} compiled matchers.
 */
export function compileRules(config) {
  const rules = config.protected.map(({ glob, reason }) => {
    const patterns = glob.startsWith('/') || glob.startsWith('**')
      ? [glob]
      : [glob, `**/${glob}`]
    const match = picomatch(patterns, { dot: true })
    // Longest glob-free prefix, for conservative substring hits in command text.
    const scanned = picomatch.scan(glob)
    return { glob, reason, match, staticBase: scanned.base ?? '' }
  })
  return {
    rules,
    pathTools: new Map(config.pathTools.map(entry => [entry.tool, entry])),
    commandTools: new Map(config.commandTools.map(entry => [entry.tool, entry])),
  }
}

/**
 * Normalize one path candidate for matching: strip a leading `./` and trailing
 * slashes; backslashes normalize to forward slashes.
 *
 * @param {string} value - raw path string from tool arguments or command text.
 * @returns {string} normalized candidate.
 */
function normalizePath(value) {
  let path = value.replaceAll('\\', '/')
  while (path.startsWith('./')) path = path.slice(2)
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/** First protected rule matching the given filesystem path, if any.
 * @param {ReturnType<typeof compileRules>} compiled - compiled matchers.
 * @param {string} path - candidate filesystem path.
 * @returns {{glob: string, reason: string} | undefined} the matching rule.
 */
export function matchProtectedPath(compiled, path) {
  const candidate = normalizePath(path)
  return compiled.rules.find(rule => rule.match(candidate))
}

/**
 * Split command text into path-like tokens. Quotes and shell separators are
 * token boundaries; the split is a conservative lexer, not a shell parser.
 *
 * @param {string} text - raw command string.
 * @returns {string[]} candidate tokens.
 */
function commandTokens(text) {
  return text
    .split(/[\s'"`;|&()<>]+/)
    .filter(token => token.length > 0)
    .map(token => token.replace(/^-+[A-Za-z-]*=/, '')) // --flag=path → path
    .filter(token => token.length > 0)
}

/**
 * First protected rule hit inside command text: every token is glob-tested,
 * and a rule whose glob-free prefix (≥ 3 chars, contains `/`) appears verbatim
 * in the text also hits. Over-triggering is acceptable — the decision is
 * `ask`, and a human can approve.
 *
 * @param {ReturnType<typeof compileRules>} compiled - compiled matchers.
 * @param {string} text - raw command string.
 * @returns {{glob: string, reason: string, hit: string} | undefined} the rule and offending fragment.
 */
export function matchProtectedCommand(compiled, text) {
  const tokens = commandTokens(text)
  for (const token of tokens) {
    const rule = matchProtectedPath(compiled, token)
    if (rule) return { glob: rule.glob, reason: rule.reason, hit: token }
  }
  for (const rule of compiled.rules) {
    const base = rule.staticBase
    if (base.length >= 3 && base.includes('/') && text.includes(base)) {
      return { glob: rule.glob, reason: rule.reason, hit: base }
    }
  }
  return undefined
}

/**
 * Decide one tool call. Returns an `ask` pre-tool decision when the call
 * writes to (or its command text touches) a protected path, `undefined` when
 * the guard has no opinion (the caller then delegates down the waterfall).
 *
 * @param {{name: string, arguments: unknown}} exec - tool name and parsed arguments.
 * @param {ReturnType<typeof compileRules>} compiled - compiled matchers.
 * @returns {{kind: 'ask', reason: string} | undefined} the decision.
 */
export function decide(exec, compiled) {
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = /** @type {Record<string, unknown>} */ (args)

  const pathTool = compiled.pathTools.get(exec.name)
  if (pathTool) {
    const skip = pathTool.skipWhen !== undefined
      && typeof record[pathTool.skipWhen.argument] === 'string'
      && pathTool.skipWhen.equals.includes(/** @type {string} */ (record[pathTool.skipWhen.argument]))
    const target = record[pathTool.argument]
    if (!skip && typeof target === 'string') {
      const rule = matchProtectedPath(compiled, target)
      if (rule) {
        return {
          kind: 'ask',
          reason: `${rule.reason} [guardrails: "${target}" matches protected pattern "${rule.glob}"; human approval required]`,
        }
      }
    }
  }

  const commandTool = compiled.commandTools.get(exec.name)
  if (commandTool) {
    const text = record[commandTool.argument]
    if (typeof text === 'string') {
      const found = matchProtectedCommand(compiled, text)
      if (found) {
        return {
          kind: 'ask',
          reason: `${found.reason} [guardrails: command text touches "${found.hit}" (protected pattern "${found.glob}"); human approval required]`,
        }
      }
    }
  }

  return undefined
}
