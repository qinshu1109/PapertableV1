/**
 * Test-only approval answerer: grants every request. Mounted via a --patch
 * overlay in the acceptance runs to demonstrate that a human "allow" lets a
 * guardrails-gated call proceed (the reason `ask` is used instead of a guard
 * veto). Never mount this in a real deployment.
 *
 * @module dsh-guardrails/tests/auto-approve
 */

export const name = 'auto-approve-answerer'

/**
 * Register the grant-everything answerer.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  ctx.on('approval/request', async () => 'allowed-once')
}
