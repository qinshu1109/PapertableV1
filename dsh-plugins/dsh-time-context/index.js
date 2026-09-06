/**
 * dsh-time-context — proactive time awareness for DeepSeek Harness. The model
 * does not need to remember to query a time tool: every assembly carries the
 * current local time as dynamic runtime context, and a short rule section
 * tells it to compute relative times ("today", "yesterday", "due", "not
 * touched in days") from that injected instant instead of guessing from
 * training data.
 *
 * Wiring (all via the documented systemPrompt service):
 * - `ctx.systemPrompt.context()` registers the runtime context. Both
 *   `section()` and `context()` are fiber-scoped Cordis effect registrations
 *   (`dsh:docs/subsystems/system-prompt.md`): they dispose with the plugin
 *   fiber (HMR / profile reload / shutdown), satisfying the reversible-
 *   registration constraint without extra bookkeeping.
 * - The context text is a pure function of the instant and the validated
 *   config (`time-context.js`), so the harness's change-only append keeps the
 *   injected line stable for a whole refresh bucket (KV-cache friendly).
 *
 * Config is validated fail-loud at plugin load (see `time-context.js`).
 *
 * @module dsh-time-context
 */

import { formatCurrentTime, RELATIVE_TIME_RULE, validateConfig } from './time-context.js'

/** Stable plugin id used by the bundle row (`cordis.patch.yml`). */
export const name = 'time-context'

/** Declared service injections. */
export const inject = ['systemPrompt']

/** Runtime-context contribution name (unique per scope layer). */
const CONTEXT_NAME = 'time-context'

/** System-prompt section name (unique per scope layer). */
const SECTION_NAME = 'time-context-rule'

/**
 * Install the runtime-context time injection and the relative-time rule
 * section. Both registrations are fiber-scoped effects; disposal is implicit
 * with the plugin fiber and explicit via their returned disposers.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - raw row config; validated fail-loud here.
 */
export function apply(ctx, config) {
  const resolved = validateConfig(config)
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolved.sectionOrder,
    text: RELATIVE_TIME_RULE,
  })
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: resolved.contextOrder,
    text: () => formatCurrentTime(new Date(), resolved),
  })
}
