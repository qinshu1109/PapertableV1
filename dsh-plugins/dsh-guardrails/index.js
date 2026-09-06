/**
 * dsh-guardrails — declarative protected-path approval gate for DeepSeek
 * Harness. A `tools/pre-execute` waterfall listener matches write-capable tool
 * calls against configured protected globs and returns `{kind: 'ask'}` so the
 * tools registry routes the call through `ctx.approval`: interactive surfaces
 * prompt the human, and a composition without an answerer fails closed
 * (deny). `ctx.tools.guard()` is deliberately not used — a guard's denial is
 * monotonic, and the whole point of this gate is that a human can approve.
 *
 * Config (validated fail-loud at plugin load, see `guardrails.js`):
 *   protected:    [{glob, reason}]           required, non-empty
 *   pathTools:    [{tool, argument, skipWhen?}]  optional, defaults cover dsh fs tools
 *   commandTools: [{tool, argument}]         optional, defaults cover bash/pwsh
 *
 * @module dsh-guardrails
 */

import { compileRules, decide, validateConfig } from './guardrails.js'

export const name = 'guardrails'

/**
 * Install the pre-execute gate.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context; the listener disposes with it.
 * @param {unknown} config - raw row config; validated fail-loud here.
 */
export function apply(ctx, config) {
  const compiled = compileRules(validateConfig(config))
  ctx.on('tools/pre-execute', (exec, next) => {
    const decision = decide(exec, compiled)
    if (decision) return Promise.resolve(decision)
    return next()
  })
}
