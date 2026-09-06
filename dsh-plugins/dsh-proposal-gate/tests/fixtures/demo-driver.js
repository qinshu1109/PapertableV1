/**
 * Acceptance-only driver: after the model's submit_proposal call succeeds, it
 * plays the whole human side through the REAL `/proposal` command channel
 * (ctx.commands.execute) and prints `[proposal-demo]` evidence lines to
 * stderr. Mounted via a --patch overlay; never part of the shipped bundle.
 *
 * Sequence: list → in-review → accept → apply (record-only, bumps the target
 * version) → verify ok → a second stale-base proposal is seeded through the
 * real tool pipeline, accepted, and its apply must refuse as stale → the
 * reviewer requests changes, the resubmission lands against the current
 * version, and its apply succeeds → an illegal transition is refused.
 *
 * @module dsh-proposal-gate/tests/demo-driver
 */

export const name = 'proposal-demo-driver'
export const inject = ['tools', 'commands']

/**
 * Install the one-shot driver.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  let ran = false

  /** stderr evidence line. */
  function say(text) {
    process.stderr.write(`[proposal-demo] ${text}\n`)
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (exec.name !== 'submit_proposal' || result.isError || ran) return downstream
    ran = true
    const agent = exec.agent
    const signal = exec.signal

    /** Run one human command line and report its result. */
    async function human(line) {
      const execution = await ctx.commands.execute(agent, line, signal)
      if (execution === undefined) {
        say(`COMMAND NOT RESOLVED: ${line}`)
        return { kind: 'error', text: 'unresolved' }
      }
      say(`$ ${line}\n  -> ${execution.result.kind}: ${(execution.result.text ?? '').split('\n').join('\n     ')}`)
      return execution.result
    }

    /** Submit a proposal through the real tool pipeline (ai actor). */
    async function aiSubmit(args, label) {
      const outcome = await ctx.tools.execute({
        callId: `demo-${label}`,
        name: 'submit_proposal',
        arguments: args,
        agent,
        signal,
      })
      if (outcome.isError) {
        say(`ai submit (${label}) FAILED: ${JSON.stringify(outcome.error)}`)
        return undefined
      }
      say(`ai submit (${label}) -> ${JSON.stringify(outcome.value)}`)
      return outcome.value
    }

    const submitted = result.value
    say(`model submitted ${submitted.id} (stale_at_submit=${submitted.stale_at_submit})`)

    await human('/proposal list')
    await human(`/proposal review ${submitted.id} in-review taking a look`)
    await human(`/proposal review ${submitted.id} accept lgtm`)
    await human(`/proposal apply ${submitted.id}`)
    await human(`/proposal verify ${submitted.id} ok`)

    // Stale path: the first apply bumped doc:demo to version 1; this one still
    // claims base_version 0 and must be refused at apply time.
    const stale = await aiSubmit({
      lane: 'default',
      target_kind: 'document',
      target_key: 'doc:demo',
      requested_action: 'update',
      base_version: 0,
      payload: { text: 'competing edit' },
      evidence: { for: ['second observation'], against: [], unknowns: [] },
      checks: ['human diff review'],
      risk: 'low',
    }, 'stale')
    if (stale !== undefined) {
      await human(`/proposal review ${stale.id} accept fine on its own`)
      await human(`/proposal apply ${stale.id}`)
      await human(`/proposal review ${stale.id} changes rebase on current version`)
      // Wrong-actor probe: 'changes_requested → accepted' by command is legal,
      // but resubmission is an ai edge — prove the command channel cannot fake
      // it by trying an illegal human edge first.
      await human(`/proposal verify ${stale.id} ok`)
      const rebased = await aiSubmit({
        lane: 'default',
        target_kind: 'document',
        target_key: 'doc:demo',
        requested_action: 'update',
        base_version: 1,
        payload: { text: 'competing edit, rebased' },
        evidence: { for: ['second observation', 'rebased on v1'], against: [], unknowns: [] },
        checks: ['human diff review'],
        risk: 'low',
        proposal_id: stale.id,
      }, 'rebase')
      if (rebased !== undefined) {
        await human(`/proposal review ${rebased.id} accept now consistent`)
        await human(`/proposal apply ${rebased.id}`)
      }
    }
    say('driver done')
    return downstream
  })
}
