/**
 * Test-only memory tool: registers `get_hot_context` returning one fixed
 * text so the acceptance runs can prove the session-start fetch-and-inject
 * path without a real memory server. Mounted via a --patch overlay row.
 * Never mount this in a real deployment.
 *
 * @module dsh-memory-discipline/tests/fake-memory-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'fake-memory-tool'

export const inject = ['tools']

/** The fixed hot-context payload asserted by the acceptance runs. */
export const FAKE_HOT_CONTEXT =
  'HOT-CONTEXT-FIXTURE: the user prefers concise answers; active project is aurora.'

/**
 * Register the fake `get_hot_context` tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the tool registry.
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'get_hot_context',
    description: 'Return the current hot memory context snapshot.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve(FAKE_HOT_CONTEXT),
  }))
}
