import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { effective } from '../hooks/core/policy'
import { defaultSettings } from '../hooks/core/settings'
import { handoffPoint } from '../hooks/features/autopilot'
import { type Family, routeSubagent } from '../hooks/features/router'
import { decideSpawn } from '../hooks/features/subagents'
import { fakeHost } from './fixtures/fake-host'

const H = 3_600_000
const live = (planPressure: 'normal' | 'economy' | 'parking' | 'hold') => ({ autopilot: 'armed' as const, autopilotThreshold: 700_000, pressure: 'ok' as const, permissionMode: undefined, planPressure })
const withGates = () => ({ ...defaultSettings(), plan: { ...defaultSettings().plan, gates: true } })
const seen = new Map<Family, string>([['haiku', 'claude-haiku-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['opus', 'claude-opus-5-5']])

describe('plan economy', () => {
  test('policy: under economy the main conversation is not routed for its next turn and says why; off or normal, nothing changes', () => {
    const s = { ...withGates(), router: { ...defaultSettings().router, strategy: 'custom' as const, mainLoop: true } }
    expect(effective(s, live('normal')).economy.isActive).toBe(false)
    expect(effective(s, live('normal')).router.isMainLoop).toBe(true)
    for (const p of ['economy', 'parking', 'hold'] as const) {
      const e = effective(s, live(p))
      expect(e.economy.isActive).toBe(true)
      // The main loop stays on for the running turn (a step never switches mid-turn); the Runtime skips routing the next one.
      expect(e.router.isMainLoop).toBe(true)
      expect(e.router.reason).toBe('main conversation held on the session model under plan economy')
      expect(e.router.isSubagents).toBe(true)
    }
    // The gates off: the pressure is not read.
    expect(effective({ ...s, plan: { ...s.plan, gates: false } }, live('hold')).economy.isActive).toBe(false)
  })

  test('router: under economy Explore agents get the economy model, past Frontier Max and with the router off; other agents as before', () => {
    const base = { router: { ...defaultSettings().router, strategy: 'off' as const }, requested: undefined, isFork: false, isTeammate: false, isFrontier: true, sessionModel: 'claude-opus-5-5', unavailable: new Set<string>(), known: seen }
    expect(routeSubagent({ ...base, subagentType: 'Explore' }).model).toBeNull()
    const eco = routeSubagent({ ...base, subagentType: 'Explore', economyExplore: 'haiku' })
    expect(eco.model).toBe('claude-haiku-5-5')
    expect(eco.why).toBe('plan economy: Explore → haiku')
    // Not an Explore agent: the router's own rules (here off).
    expect(routeSubagent({ ...base, subagentType: 'general-purpose', economyExplore: 'haiku' }).model).toBeNull()
    // Claude's own choice and forks are respected as before.
    expect(routeSubagent({ ...base, subagentType: 'Explore', requested: 'opus', economyExplore: 'haiku' }).model).toBeNull()
    expect(routeSubagent({ ...base, subagentType: 'Explore', isFork: true, economyExplore: 'haiku' }).model).toBeNull()
    // The economy model set to the session's: nothing to route.
    expect(routeSubagent({ ...base, subagentType: 'Explore', economyExplore: 'session' }).model).toBeNull()
  })

  test('subagents: a fork is refused under economy with a reason that names a fresh agent; allowed otherwise', () => {
    const base = { mode: 'unrestricted' as const, limit: 2, active: 0, isTeammate: false, countTeammates: true, type: 'general-purpose', description: 'x', isAllowedForSession: false }
    expect(decideSpawn({ ...base, isFork: true, forks: 'deny' })).toEqual({ action: 'deny', reason: expect.stringContaining('fresh agent') })
    expect(decideSpawn({ ...base, isFork: true, forks: 'allow' })).toEqual({ action: 'allow' })
    expect(decideSpawn({ ...base, isFork: false, forks: 'deny' })).toEqual({ action: 'allow' })
    expect(decideSpawn({ ...base, isFork: true })).toEqual({ action: 'allow' })
    // Subagents blocked: that is said first, since the fresh agent a fork refusal names would be refused too.
    expect(decideSpawn({ ...base, mode: 'block', isFork: true, forks: 'deny' })).toEqual({ action: 'deny', reason: expect.stringContaining('disabled') })
    expect(decideSpawn({ ...base, mode: 'limit', active: 0, isFork: true, forks: 'deny' })).toEqual({ action: 'deny', reason: expect.stringContaining('fresh agent') })
    expect(decideSpawn({ ...base, mode: 'ask', isAllowedForSession: true, isFork: true, forks: 'deny' })).toEqual({ action: 'deny', reason: expect.stringContaining('fresh agent') })
  })

  test('runtime: at the economy floor the hand-off point drops to the economy value, Explore agents go to the economy model and forks are refused; a new window lifts it all', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...withGates(), autopilot: { ...defaultSettings().autopilot, enabled: true, thresholdMode: 'percent', thresholdPercent: 25 } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    rt.router.known.set('haiku', 'claude-haiku-5-5')
    const resetsAt = f.now() + 40 * H
    const read = (pct: number, at = resetsAt) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(at).toISOString() }], changed: ['rateLimits'] })
    const spawn = (subagentType: string, fork: boolean) => rt.onAgentSpawn({ tool_use_id: 't1', prompt: 'p', description: 'd', subagentType, provider: 'local' as never, parentModel: 'claude-opus-5-5', background: false, fork })
    read(20)
    expect(handoffPoint(rt.autopilot)).toBe(250_000)
    expect((await spawn('Explore', false)).model).toBeUndefined()
    expect((await spawn('general-purpose', true)).deny).toBeUndefined()
    read(62)
    expect(rt.planGate.pressure).toBe('economy')
    expect(handoffPoint(rt.autopilot)).toBe(150_000)
    expect((await spawn('Explore', false)).model).toBe('claude-haiku-5-5')
    expect((await spawn('general-purpose', false)).model).toBeUndefined()
    const fork = await spawn('general-purpose', true)
    expect(fork.deny).toContain('plan economy refuses a fork')
    expect(rt.autopilot.isEconomy).toBe(true)
    // Ten points under economy's floor in the same window: as configured again, the saved settings untouched throughout.
    const saved = JSON.stringify(f.kept.store['settings.v1'])
    const own = rt.settings.autopilot
    read(40)
    expect(rt.planGate.pressure).toBe('normal')
    expect(handoffPoint(rt.autopilot)).toBe(250_000)
    expect(rt.autopilot.isEconomy).toBe(false)
    expect((await spawn('general-purpose', true)).deny).toBeUndefined()
    expect(JSON.stringify(f.kept.store['settings.v1'])).toBe(saved)
    expect(rt.settings.autopilot).toBe(own)
    // The next window: the same.
    read(62)
    read(3, resetsAt + 7 * 24 * H)
    expect(rt.planGate.pressure).toBe('normal')
    expect(handoffPoint(rt.autopilot)).toBe(250_000)
    expect((await spawn('general-purpose', true)).deny).toBeUndefined()
    // A person whose own hand-off point is below the economy's keeps theirs.
    rt.update(s => void (s.autopilot = { ...s.autopilot, thresholdMode: 'tokens', thresholdTokens: 100_000 }))
    read(70, resetsAt + 7 * 24 * H)
    expect(rt.planGate.pressure).toBe('economy')
    expect(handoffPoint(rt.autopilot)).toBe(100_000)
  })

  test("runtime: the policies keep the person's own hand-off point, so economy never rewrites the system prompt or a warm cache", async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...withGates(), cache: { ...defaultSettings().cache, stablePolicies: false }, autopilot: { ...defaultSettings().autopilot, enabled: true, thresholdMode: 'percent', thresholdPercent: 25 } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const resetsAt = f.now() + 40 * H
    const read = (pct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    read(20)
    // A warm cache: one turn that wrote a large prefix.
    await rt.onTurnStart({ turnId: 'w1', text: 'build the thing' })
    const e = { turnId: 'w1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }
    const sent = rt.stepRequest(e)
    rt.stepResponse(e, sent, { turnId: 'w1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 120_000, model: 'claude-opus-5-5' } })
    await rt.onStop({ stopHookActive: false, lastMessage: 'Done.', background: [], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(10)
    const before = rt.composeSection(null, [])
    expect(JSON.stringify(before)).toContain('250')
    read(62)
    expect(handoffPoint(rt.autopilot)).toBe(150_000)
    expect(JSON.stringify(rt.composeSection(null, []))).toBe(JSON.stringify(before))
    expect(rt.cache.state.pending.some(p => p.cause === 'policy')).toBe(false)
    // The probe tells: the person's own change does rewrite the section, and the warm cache notes it.
    rt.update(s => void (s.autopilot = { ...s.autopilot, thresholdPercent: 30 }))
    expect(JSON.stringify(rt.composeSection(null, []))).not.toBe(JSON.stringify(before))
    expect(rt.cache.state.pending.some(p => p.cause === 'policy')).toBe(true)
  })

  test('runtime: a turn routed on its model keeps it when economy arrives mid-turn; the next turn is not routed', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...withGates(), frontier: { ...defaultSettings().frontier, enabled: false }, router: { ...defaultSettings().router, strategy: 'economy', mainLoop: true, subagents: true } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    rt.router.known.set('haiku', 'claude-haiku-5-5')
    rt.router.known.set('sonnet', 'claude-sonnet-5-5')
    const resetsAt = f.now() + 40 * H
    const read = (pct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    read(20)
    const turn = async (id: string, text: string, during: () => void) => {
      rt.onPromptSubmit(text, undefined, undefined)
      await rt.onTurnStart({ turnId: id, text })
      const first = rt.stepRequest({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
      during()
      const second = rt.stepRequest({ turnId: id, index: 1, model: 'claude-opus-5-5', messageCount: 5 })
      await rt.onStop({ stopHookActive: false, lastMessage: 'Done.', background: [], wakeups: [], permissionMode: undefined })
      await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
      await f.advance(10)
      return [first.model, second.model]
    }
    const routed = await turn('r1', 'fix the typo in the readme', () => read(62))
    expect(routed[0]).toBeDefined()
    expect(routed[1]).toBe(routed[0])
    expect(rt.planGate.pressure).toBe('economy')
    // The next turn under economy: the session model, with the reason in the policy.
    expect(await turn('r2', 'fix the typo in the changelog', () => undefined)).toEqual([undefined, undefined])
    expect(rt.effective().router.reason).toBe('main conversation held on the session model under plan economy')
    // Economy gone: routed again.
    read(40)
    expect((await turn('r3', 'fix the typo in the license', () => undefined))[0]).toBe(routed[0])
  })

  test("runtime: a pressure move keeps the router's last decision; with the router off, economy leaves no decision for other agents", async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...withGates(), router: { ...defaultSettings().router, strategy: 'balanced', subagents: true } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    rt.router.known.set('haiku', 'claude-haiku-5-5')
    rt.router.known.set('sonnet', 'claude-sonnet-5-5')
    const resetsAt = f.now() + 40 * H
    const read = (pct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    const spawn = (subagentType: string) => rt.onAgentSpawn({ tool_use_id: 't1', prompt: 'p', description: 'd', subagentType, provider: 'local' as never, parentModel: 'claude-opus-5-5', background: false, fork: false })
    read(20)
    await spawn('Explore')
    const last = rt.router.lastDecision
    expect(last).toContain('Explore')
    read(62)
    expect(rt.router.lastDecision).toBe(last)
    read(90)
    expect(rt.router.lastDecision).toBe(last)
    // The router off: economy routes Explore alone and says so; a general agent leaves the decision as it was.
    rt.update(s => void (s.router = { ...s.router, strategy: 'off' }))
    rt.router.lastDecision = null
    expect((await spawn('general-purpose')).model).toBeUndefined()
    expect(rt.router.lastDecision).toBeNull()
    expect((await spawn('Explore')).model).toBe('claude-haiku-5-5')
    expect(rt.router.lastDecision).toBe('subagent: plan economy: Explore → haiku')
  })
})
