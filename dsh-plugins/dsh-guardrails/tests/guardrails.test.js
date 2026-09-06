import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  compileRules,
  decide,
  matchProtectedCommand,
  matchProtectedPath,
  validateConfig,
} from '../guardrails.js'

const BASE_CONFIG = {
  protected: [
    { glob: 'scripts/verify-*', reason: 'Verification scripts are protected.' },
    { glob: '**/*.env', reason: 'Env files are protected.' },
    { glob: '.github/workflows/**', reason: 'CI definitions are protected.' },
  ],
}

function compiled(config = BASE_CONFIG) {
  return compileRules(validateConfig(config))
}

test('validateConfig accepts a minimal valid config and applies tool defaults', () => {
  const config = validateConfig(BASE_CONFIG)
  assert.equal(config.protected.length, 3)
  assert.ok(config.pathTools.some(entry => entry.tool === 'write'))
  assert.ok(config.commandTools.some(entry => entry.tool === 'bash'))
})

test('validateConfig fails loud on missing, empty, or malformed rules', () => {
  assert.throws(() => validateConfig(undefined), /must be an object/)
  assert.throws(() => validateConfig({}), /non-empty array/)
  assert.throws(() => validateConfig({ protected: [] }), /non-empty array/)
  assert.throws(() => validateConfig({ protected: [{ glob: 'x' }] }), /protected\[0\]/)
  assert.throws(() => validateConfig({ protected: [{ glob: '', reason: 'r' }] }), /protected\[0\]/)
  assert.throws(
    () => validateConfig({ protected: [{ glob: 'a', reason: 'r' }, { glob: 'a', reason: 'r2' }] }),
    /duplicate/,
  )
})

test('validateConfig fails loud on malformed tool lists and misplaced skipWhen', () => {
  assert.throws(
    () => validateConfig({ ...BASE_CONFIG, pathTools: [{ tool: 'write' }] }),
    /pathTools\[0\]/,
  )
  assert.throws(
    () => validateConfig({ ...BASE_CONFIG, commandTools: 'bash' }),
    /must be an array/,
  )
  assert.throws(
    () => validateConfig({
      ...BASE_CONFIG,
      commandTools: [{ tool: 'bash', argument: 'command', skipWhen: { argument: 'x', equals: [] } }],
    }),
    /skipWhen is not supported/,
  )
})

test('relative globs match at any depth, absolute and relative alike', () => {
  const rules = compiled()
  assert.ok(matchProtectedPath(rules, 'scripts/verify-docs.ts'))
  assert.ok(matchProtectedPath(rules, './scripts/verify-docs.ts'))
  assert.ok(matchProtectedPath(rules, '/home/user/repo/scripts/verify-docs.ts'))
  assert.ok(matchProtectedPath(rules, 'deep/nested/scripts/verify-x'))
  assert.equal(matchProtectedPath(rules, 'scripts/generate.ts'), undefined)
})

test('dotfiles and backslash paths match', () => {
  const rules = compiled()
  assert.ok(matchProtectedPath(rules, 'config/production.env'))
  assert.ok(matchProtectedPath(rules, String.raw`repo\config\production.env`))
  assert.ok(matchProtectedPath(rules, '.github/workflows/ci.yml'))
})

test('command text hits by token, by --flag=path, and by static-prefix substring', () => {
  const rules = compiled()
  assert.ok(matchProtectedCommand(rules, 'cat scripts/verify-docs.ts'))
  assert.ok(matchProtectedCommand(rules, 'tool --output=deploy/prod.env run'))
  assert.ok(matchProtectedCommand(rules, 'sed -i s/x/y/ .github/workflows/ci.yml'))
  assert.equal(matchProtectedCommand(rules, 'echo hello && ls src/'), undefined)
})

test('decide asks for protected write targets and stays silent otherwise', () => {
  const rules = compiled()
  const ask = decide({ name: 'write', arguments: { file_path: 'scripts/verify-x', content: 'y' } }, rules)
  assert.equal(ask?.kind, 'ask')
  assert.match(ask.reason, /Verification scripts are protected\./)
  assert.match(ask.reason, /human approval required/)
  assert.equal(
    decide({ name: 'write', arguments: { file_path: 'src/index.ts', content: 'y' } }, rules),
    undefined,
  )
})

test('decide respects str_replace_editor read-only command and gates its writes', () => {
  const rules = compiled()
  assert.equal(
    decide({ name: 'str_replace_editor', arguments: { command: 'view', path: 'config/production.env' } }, rules),
    undefined,
  )
  const ask = decide(
    { name: 'str_replace_editor', arguments: { command: 'create', path: 'config/production.env', file_text: 'x' } },
    rules,
  )
  assert.equal(ask?.kind, 'ask')
})

test('decide gates command tools conservatively and ignores unknown tools and malformed args', () => {
  const rules = compiled()
  const ask = decide({ name: 'bash', arguments: { command: 'rm .github/workflows/ci.yml' } }, rules)
  assert.equal(ask?.kind, 'ask')
  assert.equal(decide({ name: 'read', arguments: { file_path: 'config/production.env' } }, rules), undefined)
  assert.equal(decide({ name: 'write', arguments: 'not-an-object' }, rules), undefined)
  assert.equal(decide({ name: 'write', arguments: null }, rules), undefined)
})

test('custom pathTools replace the defaults wholesale', () => {
  const rules = compiled({
    protected: [{ glob: 'db/migrations/**', reason: 'Schema migrations are protected.' }],
    pathTools: [{ tool: 'apply_patch', argument: 'target' }],
    commandTools: [],
  })
  const ask = decide({ name: 'apply_patch', arguments: { target: 'db/migrations/001.sql' } }, rules)
  assert.equal(ask?.kind, 'ask')
  assert.equal(
    decide({ name: 'write', arguments: { file_path: 'db/migrations/001.sql' } }, rules),
    undefined,
  )
})
