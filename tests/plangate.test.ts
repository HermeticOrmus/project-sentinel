import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { defaultSettings, normalizeSettings } from '../hooks/core/settings'
import { DEFAULT_STALE_MS, type PlanGate, type PlanGateConfig, floorOf, initialPlanGate, isTicking, pressureOf, step } from '../hooks/features/planGate'
import { fakeHost } from './fixtures/fake-host'

const H = 3_600_000
const M = 60_000
const CFG: PlanGateConfig = { enabled: true, economyAt: 60, parkAt: 85, holdAt: 95, staleMs: DEFAULT_STALE_MS }
const reading = (percent: number, resetsAt: number | null, readAt: number) => ({ percent, resetsAt, readAt })

/** Feeds readings a response carried just then (`seenAt` is `at`), one step each. */
function feed(model: PlanGate, readings: { percent: number; resetsAt: number; at: number }[], cfg = CFG) {
  const moves: string[] = []
  for (const r of readings) {
    const out = step(model, { sevenDay: reading(r.percent, r.resetsAt, r.at), seenAt: r.at, now: r.at }, cfg)
    model = out.model
    moves.push(...out.effects.map(e => `${e.from}→${e.to}@${e.percent}`))
  }
  return { model, moves }
}

describe('the plan gates', () => {
  test('a percent calls for a mode by its floors; the floors read from the configuration', () => {
    expect([0, 59.9, 60, 84.9, 85, 94.9, 95, 100].map(p => pressureOf(p, CFG))).toEqual(['normal', 'normal', 'economy', 'economy', 'parking', 'parking', 'hold', 'hold'])
    expect((['normal', 'economy', 'parking', 'hold'] as const).map(p => floorOf(p, CFG))).toEqual([null, 60, 85, 95])
  })

  test('the pressure rises with fresh readings of one window, keeps through a wobble, and falls only with a new window', () => {
    const reset = 100 * H
    const t = (h: number) => h * H
    const { model, moves } = feed(initialPlanGate(), [
      { percent: 20, resetsAt: reset, at: t(1) },
      { percent: 61, resetsAt: reset, at: t(2) },
      { percent: 59, resetsAt: reset, at: t(3) }, // a point under the floor: still economy
      { percent: 86, resetsAt: reset, at: t(4) },
      { percent: 96, resetsAt: reset, at: t(5) },
      { percent: 90, resetsAt: reset, at: t(6) }, // under hold's floor, within ten points: still hold
      { percent: 3, resetsAt: reset + 7 * 24 * H, at: t(7) }, // the next window: afresh
    ])
    expect(moves).toEqual(['normal→economy@61', 'economy→parking@86', 'parking→hold@96', 'hold→normal@3'])
    expect(model.pressure).toBe('normal')
    expect(model.since).toBeNull()
  })

  test("a reading ten points under the mode's floor is a new window; one well under the last reading but not the floor keeps the mode", () => {
    const reset = 100 * H
    const held = feed(initialPlanGate(), [{ percent: 96, resetsAt: reset, at: H }]).model
    expect(held.pressure).toBe('hold')
    // 85: eleven under the last reading, yet within ten of hold's floor (95): the mode keeps, since when it held too.
    const kept = feed(held, [{ percent: 85, resetsAt: reset, at: 2 * H }])
    expect(kept.moves).toEqual([])
    expect(kept.model.pressure).toBe('hold')
    expect(kept.model.since).toBe(H)
    // A slow slide stays hold until a reading ten points under the floor: then the window reads afresh.
    const slide = feed(kept.model, [
      { percent: 88, resetsAt: reset, at: 3 * H },
      { percent: 84, resetsAt: reset, at: 4 * H },
    ])
    expect(slide.moves).toEqual(['hold→economy@84'])
    expect(slide.model.since).toBe(4 * H)
    // The same reading again: the same model (nothing to redraw).
    expect(feed(slide.model, [{ percent: 84, resetsAt: reset, at: 4 * H }]).model).toBe(slide.model)
  })

  test('a stale reading moves nothing and says so once; a reading a response carried just now is fresh however old its figure', () => {
    const reset = 100 * H
    const armed = feed(initialPlanGate(), [{ percent: 88, resetsAt: reset, at: H }]).model
    // Its figure read an hour ago and no response since: stale. Repeated, the note stays one note and the model the same.
    const stale = step(armed, { sevenDay: reading(88, reset, H), seenAt: H, now: 3 * H }, CFG)
    expect(stale.effects).toEqual([])
    expect(stale.model.pressure).toBe('parking')
    expect(stale.model.note).toBe('7-day 88%: finishing the turn, then the handoff and a park until the reset (stale reading)')
    expect(step(stale.model, { sevenDay: reading(88, reset, H), seenAt: H, now: 4 * H }, CFG).model).toBe(stale.model)
    // A figure that moved (its readAt is now) with no response reported (the engine's own, read at startup): not fresh.
    const startup = step(armed, { sevenDay: reading(99, reset, 3 * H), seenAt: H, now: 3 * H }, CFG)
    expect(startup.effects).toEqual([])
    expect(startup.model.pressure).toBe('parking')
    // The same figure carried by a response a minute ago: fresh, though the figure itself last changed two hours ago.
    const fresh = step(armed, { sevenDay: reading(99, reset, H), seenAt: 3 * H - M, now: 3 * H }, CFG)
    expect(fresh.effects).toEqual([{ kind: 'pressure', from: 'parking', to: 'hold', percent: 99 }])
    // A window steady at 90% for fifteen minutes, read by a response just now, from nothing: parking at once.
    const steady = step(initialPlanGate(), { sevenDay: reading(90, reset, H), seenAt: H + 15 * M, now: H + 15 * M }, CFG)
    expect(steady.model.pressure).toBe('parking')
    expect(steady.model.since).toBe(H + 15 * M)
    // No response ever: nothing is fresh.
    expect(step(initialPlanGate(), { sevenDay: reading(90, reset, H), seenAt: null, now: H }, CFG).model.pressure).toBe('normal')
  })

  test('no window, or a window past its reset, stands any mode down; a reading of an ended window raises nothing', () => {
    const reset = 100 * H
    const armed = feed(initialPlanGate(), [{ percent: 88, resetsAt: reset, at: H }]).model
    const gone = step(armed, { sevenDay: null, seenAt: H, now: 2 * H }, CFG)
    expect(gone.effects).toEqual([{ kind: 'pressure', from: 'parking', to: 'normal', percent: null }])
    expect(gone.model.note).toBe('No 7-day reading')
    expect(gone.model.reading).toBeNull()
    // The reset time passed with no reading of the new window yet: down, whatever the old figure said.
    const past = step(armed, { sevenDay: reading(97, reset, H), seenAt: reset + M, now: reset + M }, CFG)
    expect(past.effects).toEqual([{ kind: 'pressure', from: 'parking', to: 'normal', percent: null }])
    expect(past.model.note).toBe('The 7-day window reset; waiting for a reading of the new one')
    expect(step(past.model, { sevenDay: reading(97, reset, H), seenAt: reset + M, now: reset + 2 * M }, CFG).model).toBe(past.model)
    // From normal, a reading past its reset (a reload after the reset) raises nothing.
    const late = step(initialPlanGate(), { sevenDay: reading(97, H, H - M), seenAt: H, now: H }, CFG)
    expect(late.effects).toEqual([])
    expect(late.model.pressure).toBe('normal')
    // The next window's first reading reads afresh.
    expect(feed(past.model, [{ percent: 3, resetsAt: reset + 7 * 24 * H, at: reset + 2 * M }]).moves).toEqual([])
    expect(feed(past.model, [{ percent: 70, resetsAt: reset + 7 * 24 * H, at: reset + 2 * M }]).moves).toEqual(['normal→economy@70'])
    // A look a minute is wanted while a mode holds and its window's reset is ahead.
    expect(isTicking(armed, 2 * H)).toBe(true)
    expect(isTicking(armed, reset)).toBe(false)
    expect(isTicking(past.model, reset + M)).toBe(false)
    expect(isTicking(initialPlanGate(), H)).toBe(false)
  })

  test('the configuration is read against the last reading at once, up or down; off stands any mode down and stays one model', () => {
    const reset = 100 * H
    const economy = feed(initialPlanGate(), [{ percent: 70, resetsAt: reset, at: H }]).model
    const at = { sevenDay: reading(70, reset, H), seenAt: H, now: H + M }
    const lower = step(economy, at, { ...CFG, parkAt: 65 })
    expect(lower.effects).toEqual([{ kind: 'pressure', from: 'economy', to: 'parking', percent: 70 }])
    // Lowered an hour after the last move, responses still coming: read at once too.
    expect(step(economy, { ...at, seenAt: 2 * H, now: 2 * H }, { ...CFG, parkAt: 65 }).model.pressure).toBe('parking')
    // A floor raised over the reading, by less than the ten wobble points: afresh, the mode falls.
    const raised = step(economy, at, { ...CFG, economyAt: 72 })
    expect(raised.effects).toEqual([{ kind: 'pressure', from: 'economy', to: 'normal', percent: 70 }])
    expect(raised.model.since).toBeNull()
    expect(step(lower.model, at, { ...CFG, parkAt: 72 }).model.pressure).toBe('economy')
    // The same floors again: the same mode, since when it held, and the same model.
    expect(step(economy, at, CFG).model).toBe(economy)
    const off = step(lower.model, at, { ...CFG, enabled: false })
    expect(off.effects).toEqual([{ kind: 'pressure', from: 'parking', to: 'normal', percent: null }])
    expect(off.model.note).toBe('Off')
    expect(step(off.model, { ...at, now: H + 2 * M }, { ...CFG, enabled: false }).model).toBe(off.model)
    const fresh = initialPlanGate()
    expect(step(fresh, at, { ...CFG, enabled: false }).model).toBe(fresh)
    // On again with a stale last reading: nothing moves, and the note says what it waits for, once.
    const on = step(off.model, { ...at, now: 5 * H }, CFG)
    expect(on.effects).toEqual([])
    expect(on.model.note).toBe('No fresh 7-day reading')
    expect(step(on.model, { ...at, now: 5 * H + M }, CFG).model).toBe(on.model)
  })

  test('the settings keep the floors in rising order around the ones set, and validate the economy keys', () => {
    const base = defaultSettings()
    const s = normalizeSettings({ ...base, plan: { gates: true, economyAt: 70, parkAt: 50, holdAt: 10, economy: { thresholdTokens: 5, explore: 'nope', forks: 'maybe' } } })
    expect(s.plan).toEqual({ rate: false, gates: true, economyAt: 70, parkAt: 70, holdAt: 70, economy: { thresholdTokens: 10_000, explore: 'haiku', forks: 'deny' }, alerts: [] })
    expect(normalizeSettings(undefined).plan).toEqual({ rate: false, gates: false, economyAt: 60, parkAt: 85, holdAt: 95, economy: { thresholdTokens: 150_000, explore: 'haiku', forks: 'deny' }, alerts: [] })
    // A floor set alone stands; the ones left to their defaults bend down to it.
    const floors = (plan: Record<string, unknown>) => {
      const p = normalizeSettings({ ...base, plan }).plan
      return [p.economyAt, p.parkAt, p.holdAt]
    }
    expect(floors({ holdAt: 50 })).toEqual([50, 50, 50])
    expect(floors({ parkAt: 50 })).toEqual([50, 50, 95])
    expect(floors({ economyAt: 90 })).toEqual([90, 90, 95])
    expect(floors({ economyAt: 70 })).toEqual([70, 85, 95])
    // Two set out of order: the higher mode's floor is lifted to the lower mode's.
    expect(floors({ holdAt: 50, economyAt: 70 })).toEqual([70, 70, 70])
  })

  test('the runtime feeds the gates its readings and traces the pressure; nothing else happens yet', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, gates: true } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const resetsAt = f.now() + 40 * H
    const read = (pct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    read(20)
    expect(rt.planGate.pressure).toBe('normal')
    read(62)
    expect(rt.planGate.pressure).toBe('economy')
    read(90)
    expect(rt.planGate.pressure).toBe('parking')
    expect(f.kept.traces.filter(t => t.startsWith('plan gates:'))).toEqual(['plan gates: normal → economy (7-day 62%)', 'plan gates: economy → parking (7-day 90%)'])
    expect(f.kept.submitted).toEqual([])
    expect(f.kept.asked).toEqual([])
    // A list with the 7-day window alone, read after an answer: the five-hour window is absent, the 7-day reading stands.
    f.live.usage.rateLimits = [{ kind: 'seven_day', percentUsed: 90, resetsAt: new Date(resetsAt).toISOString() }]
    await rt.refreshUsage(false, true)
    expect(rt.planUsage.isAbsent).toBe(true)
    expect(rt.planGate.pressure).toBe('parking')
    // A measurement that moved the context alone (a clear) carries the last response's figure: not a fresh report.
    await f.advance(11 * M)
    rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 90, resetsAt: new Date(resetsAt).toISOString() }], changed: ['context'] })
    rt.update(s => void (s.plan = { ...s.plan, parkAt: 80, holdAt: 89 }))
    expect(rt.planGate.pressure).toBe('parking')
    expect(rt.planGate.note).toContain('stale')
    // An aborted turn's read is not a report either; an answered turn's is.
    await rt.refreshUsage(false, false)
    expect(rt.planGate.pressure).toBe('parking')
    await rt.refreshUsage(false, true)
    expect(rt.planGate.pressure).toBe('hold')
    // Off (the default): the gates never read.
    const g = fakeHost()
    g.kept.store['settings.v1'] = defaultSettings()
    const off = new Runtime()
    off.bind(g.host)
    await off.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await g.advance(200)
    off.onMeasure({ context: g.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 96, resetsAt: new Date(g.now() + H).toISOString() }], changed: ['rateLimits'] })
    expect(off.planGate.pressure).toBe('normal')
    expect(g.kept.traces.some(t => t.startsWith('plan gates:'))).toBe(false)
  })

  test('the runtime: a steady window is fresh when the gates go on, new floors apply at once, and the minute look stands a mode down at its reset', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = defaultSettings()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const resetsAt = f.now() + 30 * M
    const read = (pct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    // Steady at 90% for fifteen minutes, a response each minute, the gates off.
    for (let i = 0; i < 15; i++) {
      read(90)
      await f.advance(M)
    }
    rt.update(s => void (s.plan = { ...s.plan, gates: true }))
    expect(rt.planGate.pressure).toBe('parking')
    // A floor lowered: the same reading is read against it at once.
    rt.update(s => void (s.plan = { ...s.plan, holdAt: 90 }))
    expect(rt.planGate.pressure).toBe('hold')
    // The reset passes with no response at all: the minute look stands the mode down.
    await f.advance(16 * M)
    expect(rt.planGate.pressure).toBe('normal')
    expect(f.kept.traces.filter(t => t.startsWith('plan gates:'))).toEqual(['plan gates: normal → parking (7-day 90%)', 'plan gates: parking → hold (7-day 90%)', 'plan gates: hold → normal'])
    expect(f.kept.submitted).toEqual([])
  })

  test("the runtime after a reload: the engine's figure read at startup is not fresh until a response carries it, or it moves", async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, gates: true } }
    const resetsAt = f.now() + 40 * H
    const at = (pct: number) => [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }]
    f.live.usage.rateLimits = at(90)
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(rt.planGate.pressure).toBe('normal')
    expect(rt.planGate.note).toBe('No fresh 7-day reading')
    expect(rt.planUsage.sevenDay?.percent).toBe(90)
    // A measurement that moved the context alone brings the five-hour window (the minute look starts) and the same 7-day figure: not fresh.
    const five = { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(f.now() + H).toISOString() }
    f.live.usage.rateLimits = [...at(90), five]
    rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: f.live.usage.rateLimits, changed: ['context'] })
    expect(rt.planGate.pressure).toBe('normal')
    // The minute look re-reads the same figure: still not fresh.
    await f.advance(3 * M)
    expect(rt.planGate.pressure).toBe('normal')
    expect(rt.planGate.note).toBe('No fresh 7-day reading')
    // The figure moves on the minute look (a response no measurement reported): fresh now.
    f.live.usage.rateLimits = [...at(91), five]
    await f.advance(M)
    expect(rt.planGate.pressure).toBe('parking')
    expect(f.kept.traces.filter(t => t.startsWith('plan gates:'))).toEqual(['plan gates: normal → parking (7-day 91%)'])
  })
})
