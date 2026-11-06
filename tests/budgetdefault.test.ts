import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { diffSystems } from '../hooks/core/profiles'
import { defaultSettings, normalizeSettings } from '../hooks/core/settings'
import { budgetWords } from '../hooks/features/ops'
import { fakeHost } from './fixtures/fake-host'

const H = 3_600_000

async function started(budget: unknown): Promise<ReturnType<typeof fakeHost> & { rt: Runtime }> {
  const f = fakeHost()
  f.kept.store['settings.v1'] = { ...defaultSettings(), ops: { ...defaultSettings().ops, budget } }
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

describe('the default run budget', () => {
  test('the setting is null or the limits a run starts with; a record with no limit is null; out-of-range limits read as none', () => {
    const base = defaultSettings()
    const of = (budget: unknown) => normalizeSettings({ ...base, ops: { ...base.ops, budget } }).ops.budget
    expect(normalizeSettings(undefined).ops.budget).toBeNull()
    expect(of(null)).toBeNull()
    expect(of({ handoffs: 4, atLimit: 'ask' })).toEqual({ costUsd: null, durationMs: null, handoffs: 4, atLimit: 'ask' })
    expect(of({ costUsd: 12.345, durationMs: 6 * H, handoffs: 2.6, atLimit: 'finish' })).toEqual({ costUsd: 12.35, durationMs: 6 * H, handoffs: 3, atLimit: 'finish' })
    expect(of({ handoffs: 0 })).toBeNull()
    // Rounded first, then the range; handoffs past fifty read as fifty, the other limits as none.
    expect(of({ handoffs: 51, costUsd: -1, durationMs: 1000, atLimit: 'explode' })).toEqual({ costUsd: null, durationMs: null, handoffs: 50, atLimit: 'ask' })
    expect(of({ costUsd: 0.005 })).toEqual({ costUsd: 0.01, durationMs: null, handoffs: null, atLimit: 'ask' })
    expect(of({ costUsd: 0.004 })).toBeNull()
    expect(of({ costUsd: 100_000.004 })).toEqual({ costUsd: 100_000, durationMs: null, handoffs: null, atLimit: 'ask' })
    expect(of({ handoffs: 50.4 })).toEqual({ costUsd: null, durationMs: null, handoffs: 50, atLimit: 'ask' })
    expect(of('four')).toBeNull()
    expect(budgetWords({ costUsd: 5, durationMs: 2 * H, handoffs: 4, atLimit: 'ask' })).toBe('cost $5, time 2h, handoffs 4, ask')
    expect(budgetWords({ costUsd: 1.2, durationMs: null, handoffs: null, atLimit: 'finish' })).toBe('cost $1.20, finish')
    // A profile diff shows the budget as one worded setting, both ways.
    const on = diffSystems(base, { ...base, ops: { ...base.ops, budget: { costUsd: null, durationMs: null, handoffs: 4, atLimit: 'ask' } } })
    expect(on).toEqual([{ path: 'ops.budget', label: 'Default run budget', from: 'None', to: 'handoffs 4, ask' }])
    const off = diffSystems({ ...base, ops: { ...base.ops, budget: { costUsd: 5, durationMs: 2 * H, handoffs: null, atLimit: 'finish' } } }, base)
    expect(off).toEqual([{ path: 'ops.budget', label: 'Default run budget', from: 'cost $5, time 2h, finish', to: 'None' }])
  })

  test('a new run starts with the default budget on its record, said in the trace; /cr budget still overrides it', async () => {
    const f = await started({ handoffs: 4, atLimit: 'ask' })
    expect(f.rt.ops.current().budget).toEqual({ costUsd: null, durationMs: null, handoffs: 4, atLimit: 'ask', warned: [], reached: [], approved: [] })
    expect(f.kept.traces).toContain('ops: run budget from the settings (handoffs 4, ask)')
    expect(f.rt.ops.current().log.some(l => l.text === 'Run budget from the settings: handoffs 4, ask')).toBe(true)
    expect(f.rt.ops.current().log.some(l => l.text === 'Run budget set')).toBe(false)
    // Saved at once: one run in the store, with the budget.
    expect(Object.keys(f.kept.store).filter(k => k.startsWith('run.v1.'))).toHaveLength(1)
    f.rt.ops.setBudget({ handoffs: 2, atLimit: 'notify' })
    expect(f.rt.ops.current().budget).toMatchObject({ handoffs: 2, atLimit: 'notify' })
    f.rt.ops.setBudget(null)
    expect(f.rt.ops.current().budget).toBeNull()
  })

  test('at the limit the run asks once and never stops by itself: automation holds, the person is asked with their next message', async () => {
    const f = await started({ costUsd: 0.1, atLimit: 'ask' })
    f.rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [], changed: ['cost'] })
    await f.advance(10)
    f.rt.ops.checkBudget()
    expect(f.rt.ops.budgetCheck()?.reached).toEqual(['cost'])
    expect(f.rt.ops.isBudgetHolding()).toBe(true)
    expect(f.rt.ops.mayAutomate('queued work')).toBe(false)
    expect(f.kept.submitted).toEqual([])
    // Continue anyway: automation goes on past this limit.
    f.rt.ops.approveBudget()
    expect(f.rt.ops.isBudgetHolding()).toBe(false)
  })

  test("at a handoff limit of one, Autopilot's own fresh context (a roll-over) reaches it: the person's next message is asked once, and a run resumed through Claude Code's resume keeps its own budget", async () => {
    const f = await started({ handoffs: 1, atLimit: 'ask' })
    f.rt.autopilot = { ...f.rt.autopilot, state: 'clearing' }
    f.live.sessionId = 'S2'
    await f.rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    await f.advance(10)
    f.rt.ops.checkBudget()
    expect(f.rt.ops.budgetCheck()?.reached).toEqual(['handoffs'])
    expect(f.rt.ops.current().log.filter(l => l.text.startsWith('Run budget from the settings'))).toHaveLength(1)
    f.live.answer = 'Not now'
    const held = await f.rt.ops.budgetGuard({ text: 'Go on.' })
    expect(held?.drop).toContain('the run budget is reached')
    expect(f.kept.asked.at(-1)).toMatchObject({ header: 'Budget', options: ['Continue the run', 'Not now'] })
    f.live.answer = 'Continue the run'
    expect(await f.rt.ops.budgetGuard({ text: 'Go on.' })).toBeNull()
    // A resume known at start (Claude Code's own resume): the previous run and its budget, not the default.
    const g = fakeHost()
    g.kept.store = { ...f.kept.store, 'settings.v1': { ...defaultSettings(), ops: { ...defaultSettings().ops, budget: { costUsd: null, durationMs: null, handoffs: 4, atLimit: 'ask' } } } }
    g.live.sessionId = 'S3'
    const rt = new Runtime()
    rt.bind(g.host)
    await rt.onClassicSessionStart({ source: 'resume', sessionId: 'S2' })
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await g.advance(200)
    expect(rt.run?.id).toBe(f.rt.run?.id)
    expect(rt.run?.sessions.map(x => x.id)).toEqual(['S1', 'S2', 'S3'])
    expect(rt.ops.current().budget?.handoffs).toBe(1)
    expect(g.kept.traces.some(t => t.startsWith('ops: run budget from the settings'))).toBe(false)
  })

  test('with the default null (the default) a run starts with no budget, as before', async () => {
    const f = await started(null)
    expect(f.rt.ops.current().budget).toBeNull()
    expect(f.kept.traces.some(t => t.startsWith('ops: run budget from the settings'))).toBe(false)
    // Saved at once either way: one run in the store.
    expect(Object.keys(f.kept.store).filter(k => k.startsWith('run.v1.'))).toHaveLength(1)
  })
})
