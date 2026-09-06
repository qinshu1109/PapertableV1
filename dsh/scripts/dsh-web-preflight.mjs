#!/usr/bin/env node
/**
 * dsh-web-preflight — 启动前只读检查（简报 34 · A 级原子启动）。
 *
 * 解析 web profile 的 loader 入口（profile cordis.patch.yml 的 name 字段 +
 * package.json dsh.profile.bundles），逐个验证：包可 resolve、入口文件存在。
 * 失败则退出码 1 并输出单一明确错误，wrapper 据此拒绝启动 dsh web——
 * 防止 8-15 的 P0 复现（@dsh-external/dsh-super-injector/lib/index.js 缺失导致
 * 整棵插件树启动失败、KeepAlive 反复拉起空转）。
 *
 * 说明：真实 `import()` 插件模块会执行其顶层代码且其运行时依赖依赖宿主进程的
 * 解析环境（profile node_modules + dsh 全局安装），独立进程无法等价复现，故
 * 采用 require.resolve（从 profile 目录解析，与 Loader 同源）+ 入口文件存在性
 * 验证——Loader 加载的前置条件正是"文件在且可解析"。
 */

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOME = process.env.HOME ?? '/Users/qinshu'
const PROFILE = join(HOME, '.dsh', 'profiles', 'web')
const DSH_ROOT = '/Users/qinshu/.local/node/lib/node_modules/@deepseek-ai/dsh'

const require = createRequire(join(DSH_ROOT, 'package.json'))
const yaml = require('yaml')

const failures = []
const checked = new Set()
const origins = []

/**
 * 验证一个 loader 入口名：从 profile（含 dsh 全局）解析出入口文件并确认存在。
 * @param {string} name - loader entry name（包名或路径）。
 * @param {string} origin - 来源描述（patch / bundle）。
 */
async function checkName(name, origin) {
  if (checked.has(name)) return
  checked.add(name)
  origins.push(`${origin}: ${name}`)
  try {
    const resolved = require.resolve(name, { paths: [PROFILE, DSH_ROOT] })
    if (!existsSync(resolved)) {
      failures.push(`${origin}: "${name}" resolved to missing file: ${resolved}`)
      return
    }
    // 已知 P0 坑：super-injector 曾因 lib/index.js 缺失导致整树失败，特检一次。
    if (name === '@dsh-external/dsh-super-injector') {
      const expected = join(dirnameOf(resolved), 'index.js')
      if (!existsSync(expected)) {
        failures.push(`${origin}: @dsh-external/dsh-super-injector entry missing ${expected}`)
      }
    }
  } catch (error) {
    failures.push(`${origin}: "${name}" unresolvable: ${error?.message ?? String(error)}`)
  }
}

function dirnameOf(file) {
  return file.slice(0, Math.max(file.lastIndexOf('/'), 0))
}

// 1) profile cordis.patch.yml 的 name 字段（insert 内条目）
const patchPath = join(PROFILE, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  failures.push(`profile patch missing: ${patchPath}`)
} else {
  let patch
  try {
    patch = yaml.parse(readFileSync(patchPath, 'utf8'))
  } catch (error) {
    failures.push(`profile patch unparseable: ${error?.message ?? String(error)}`)
    patch = []
  }
  for (const entry of Array.isArray(patch) ? patch : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.name === 'string') await checkName(entry.name, 'patch')
    if (Array.isArray(entry.insert)) {
      for (const sub of entry.insert) {
        if (sub && typeof sub.name === 'string') await checkName(sub.name, 'patch.insert')
      }
    }
  }
}

// 2) profile package.json 的 bundle 列表
const pkgPath = join(PROFILE, 'package.json')
if (existsSync(pkgPath)) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    failures.push(`profile package.json unparseable: ${error?.message ?? String(error)}`)
    pkg = {}
  }
  for (const bundle of pkg.dsh?.profile?.bundles ?? []) {
    await checkName(bundle, 'bundle')
  }
}

if (failures.length > 0) {
  console.error('dsh-web PREFLIGHT FAILED — refusing to start dsh web:')
  for (const f of failures) console.error(`  - ${f}`)
  console.error(`verified ${checked.size} entries; ${failures.length} failed`)
  process.exit(1)
}
console.log(`dsh-web preflight OK (${checked.size} loader entries verified: ${origins.join(', ')})`)
process.exit(0)
