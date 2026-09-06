import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildHotContextNotice,
  buildMemoryUnavailableNotice,
  CONFIG_DEFAULTS,
  defaultPolicyLines,
  extractResultText,
  interpolatePolicyLine,
  renderPolicyText,
  validateConfig,
} from '../discipline.js'

test('validateConfig accepts an omitted config and applies every default', () => {
  for (const raw of [undefined, null, {}]) {
    const config = validateConfig(raw)
    assert.equal(config.hotContextTool, CONFIG_DEFAULTS.hotContextTool)
    assert.equal(config.autoFetch, true)
    assert.equal(config.policyLines, undefined)
    assert.equal(config.toolVocabulary.hot, 'get_hot_context')
    assert.equal(config.toolVocabulary.route, 'route_memory')
    assert.equal(config.sectionOrder, CONFIG_DEFAULTS.sectionOrder)
    assert.equal(config.toolWaitAttempts, CONFIG_DEFAULTS.toolWaitAttempts)
    assert.equal(config.toolWaitDelayMs, CONFIG_DEFAULTS.toolWaitDelayMs)
    assert.equal(config.callTimeoutMs, CONFIG_DEFAULTS.callTimeoutMs)
    assert.equal(config.toolRetryAttempts, CONFIG_DEFAULTS.toolRetryAttempts)
    assert.equal(config.toolRetryDelayMs, CONFIG_DEFAULTS.toolRetryDelayMs)
    assert.equal(config.lateRegistrationMaxWaitMs, CONFIG_DEFAULTS.lateRegistrationMaxWaitMs)
  }
})

test('validateConfig fails loud on non-object configs and unknown keys', () => {
  assert.throws(() => validateConfig('x'), /must be an object/)
  assert.throws(() => validateConfig([]), /must be an object/)
  assert.throws(() => validateConfig({ hotContexTool: 'oops' }), /unknown key `hotContexTool`/)
})

test('validateConfig fails loud on malformed field values', () => {
  assert.throws(() => validateConfig({ hotContextTool: '' }), /hotContextTool/)
  assert.throws(() => validateConfig({ hotContextTool: 'has space' }), /hotContextTool/)
  assert.throws(() => validateConfig({ autoFetch: 'yes' }), /autoFetch/)
  assert.throws(() => validateConfig({ policyLines: [] }), /policyLines/)
  assert.throws(() => validateConfig({ policyLines: ['ok', ' '] }), /policyLines/)
  assert.throws(() => validateConfig({ toolVocabulary: [] }), /toolVocabulary/)
  assert.throws(() => validateConfig({ toolVocabulary: { 'bad key': 'x_y' } }), /toolVocabulary key/)
  assert.throws(() => validateConfig({ toolVocabulary: { route: '' } }), /toolVocabulary\.route/)
  assert.throws(() => validateConfig({ sectionOrder: Number.NaN }), /sectionOrder/)
  assert.throws(() => validateConfig({ toolWaitAttempts: 0 }), /toolWaitAttempts/)
  assert.throws(() => validateConfig({ toolWaitAttempts: 1.5 }), /toolWaitAttempts/)
  assert.throws(() => validateConfig({ toolWaitDelayMs: -1 }), /toolWaitDelayMs/)
  assert.throws(() => validateConfig({ callTimeoutMs: 0 }), /callTimeoutMs/)
  assert.throws(() => validateConfig({ toolRetryAttempts: 1.5 }), /toolRetryAttempts/)
  assert.throws(() => validateConfig({ toolRetryDelayMs: -1 }), /toolRetryDelayMs/)
  assert.equal(validateConfig({ toolRetryAttempts: 0 }).toolRetryAttempts, 0)
  assert.throws(() => validateConfig({ lateRegistrationMaxWaitMs: 0 }), /lateRegistrationMaxWaitMs/)
  assert.equal(validateConfig({ lateRegistrationMaxWaitMs: 1.5 }).lateRegistrationMaxWaitMs, 1.5)
  assert.equal(validateConfig({ lateRegistrationMaxWaitMs: 60_000 }).lateRegistrationMaxWaitMs, 60_000)
})

test('validateConfig binds the hot placeholder to hotContextTool and rejects conflicts', () => {
  const config = validateConfig({ hotContextTool: 'mcp__memos__get_hot_context' })
  assert.equal(config.toolVocabulary.hot, 'mcp__memos__get_hot_context')
  const consistent = validateConfig({
    hotContextTool: 'load_context',
    toolVocabulary: { hot: 'load_context', route: 'route_memory', search: 's', add: 'a' },
  })
  assert.equal(consistent.toolVocabulary.hot, 'load_context')
  assert.throws(
    () => validateConfig({ hotContextTool: 'load_context', toolVocabulary: { hot: 'other_tool' } }),
    /conflicts with hotContextTool/,
  )
})

test('a configured vocabulary replaces the defaults wholesale, failing loud when default lines lose a placeholder', () => {
  // Custom lines + custom vocabulary: fine.
  const config = validateConfig({
    toolVocabulary: { recall: 'memory_recall' },
    policyLines: ['Use {recall} before answering.', 'Fetch {hot} once per session.'],
  })
  assert.match(renderPolicyText(config), /Use memory_recall before answering\./)
  // Default lines reference {route}/{search}/{add}; a vocabulary without them
  // must be rejected at load, not at first assembly.
  assert.throws(
    () => validateConfig({ toolVocabulary: { recall: 'memory_recall' } }),
    /unknown tool placeholder \{route\}/,
  )
})

test('interpolatePolicyLine substitutes known placeholders and throws on unknown ones', () => {
  const vocabulary = { hot: 'get_hot_context', route: 'route_memory' }
  assert.equal(
    interpolatePolicyLine('Call {route}; then {hot}.', vocabulary),
    'Call route_memory; then get_hot_context.',
  )
  assert.throws(
    () => interpolatePolicyLine('Use {missing} now.', vocabulary),
    /unknown tool placeholder \{missing\}/,
  )
})

test('renderPolicyText is stable, fully interpolated, and adapts the fetch line to autoFetch', () => {
  const auto = validateConfig({})
  const autoText = renderPolicyText(auto)
  assert.equal(autoText, renderPolicyText(auto), 'same config must render byte-identical text')
  assert.match(autoText, /^Memory discipline:\n- /)
  assert.match(autoText, /loaded automatically once per session start/)
  assert.match(autoText, /call route_memory first/)
  assert.match(autoText, /using search_memories/)
  assert.match(autoText, /using add_memory/)
  assert.doesNotMatch(autoText, /\{[A-Za-z0-9_-]+\}/, 'no placeholder may survive rendering')

  const manual = validateConfig({ autoFetch: false })
  assert.match(renderPolicyText(manual), /call get_hot_context once to load hot memory context/)
  assert.equal(defaultPolicyLines(true).length, defaultPolicyLines(false).length)
})

test('extractResultText joins text blocks and ignores non-text blocks', () => {
  assert.equal(
    extractResultText([
      { type: 'text', text: 'line one' },
      { type: 'image', data: 'ignored' },
      { type: 'text', text: 'line two' },
    ]),
    'line one\nline two',
  )
  assert.equal(extractResultText([]), '')
})

test('notice builders produce bounded one-line summaries and English bodies', () => {
  const hot = buildHotContextNotice('get_hot_context', 'FACTS')
  assert.match(hot.text, /loaded automatically at session start via get_hot_context/)
  assert.match(hot.text, /FACTS/)
  assert.ok(hot.summary.length <= 120)

  const gone = buildMemoryUnavailableNotice('get_hot_context', 'tool "get_hot_context" failed: boom')
  assert.match(gone.text, /unavailable for this session/)
  assert.match(gone.text, /do not fabricate remembered facts/)
  assert.match(gone.text, /boom/)
  assert.ok(gone.summary.length <= 120)
})
