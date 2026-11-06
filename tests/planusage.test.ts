import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { statusText } from '../hooks/app/commands'
import { defaultSettings } from '../hooks/core/settings'
import { type PlanUsage, emptyPlanUsage, emptySamples, isTicking, noteAnswered, noteRateLimited, noteSamples, planUsageView, readWindows, samplesOf, trendOf, windowRows } from '../hooks/features/planUsage'
import { hudCells, hudSegments, planDetail, tiersOf } from '../hooks/ui/hud'
import { fakeHost } from './fixtures/fake-host'
import { SESSION, world } from './fixtures/world'

// The status bar's 5H reading (1.7.0) replaces the run's cost there. Seen live on Claude Code 2.1.296: before
// the session's first response `$.session.usage().rateLimits` is []; then [{five_hour 47%, resets 04:20Z},
// {seven_day 17%, …}]; `session.measure` names 'rateLimits' in `changed` when a window moves a whole point;
// the readings carry across /clear. Off a subscription the list stays empty. Nothing is estimated.

const H = 3_600_000
const M = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const five = (percentUsed: number, resetsAt: number | null) => ({ kind: 'five_hour', percentUsed, ...(resetsAt === null ? {} : { resetsAt: iso(resetsAt) }) })
const seven = (percentUsed: number, resetsAt: number) => ({ kind: 'seven_day', percentUsed, resetsAt: iso(resetsAt) })

describe('the five-hour window', () => {
  test('no reading before the first response; none after an answered turn means no five-hour window (an API key)', () => {
    const empty = emptyPlanUsage()
    expect(planUsageView(empty, 0)).toEqual({ kind: 'pending' })
    // A measurement with an empty list before any answer: still waiting.
    expect(planUsageView(readWindows(empty, [], 1000), 1000)).toEqual({ kind: 'pending' })
    // A turn answered and the list still empty: absent.
    const absent = readWindows(empty, [], 2000, true)
    expect(planUsageView(absent, 2000)).toEqual({ kind: 'absent' })
    // A window that appears later (a /login to a plan) is read.
    expect(planUsageView(readWindows(absent, [five(12, 4 * H)], 3000), 3000)).toMatchObject({ kind: 'reading', percent: 12 })
    // A gateway's spend limit alone is not a five-hour window.
    expect(planUsageView(readWindows(empty, [{ kind: 'spend_limit', percentUsed: 40 }], 2000, true), 2000)).toEqual({ kind: 'absent' })
  })

  test('a reading: the engine percentage and the time to the window reset; amber from 80%', () => {
    const now = 10 * H
    const state = readWindows(emptyPlanUsage(), [five(63, now + 2 * H + 14 * M), seven(18, now + 30 * H)], now)
    expect(planUsageView(state, now)).toEqual({ kind: 'reading', percent: 63, resetsAt: now + 2 * H + 14 * M, leftMs: 2 * H + 14 * M, isHigh: false })
    expect(planUsageView(readWindows(state, [five(80, now + H)], now), now)).toMatchObject({ percent: 80, isHigh: true })
    // One decimal at most, as the engine gives it; never negative.
    expect(planUsageView(readWindows(emptyPlanUsage(), [five(23.46, now + H)], now), now)).toMatchObject({ percent: 23.5 })
    expect(planUsageView(readWindows(emptyPlanUsage(), [five(-3, now + H)], now), now)).toMatchObject({ percent: 0 })
    // A window with no reset time: the reading without a countdown.
    expect(planUsageView(readWindows(emptyPlanUsage(), [five(30, null)], now), now)).toMatchObject({ kind: 'reading', leftMs: null, resetsAt: null })
    expect(windowRows(state, now)).toEqual([
      { key: 'five_hour', name: '5-hour', percent: 63, resetsAt: now + 2 * H + 14 * M, leftMs: 2 * H + 14 * M, isReset: false, trend: null },
      { key: 'seven_day', name: '7-day', percent: 18, resetsAt: now + 30 * H, leftMs: 30 * H, isReset: false, trend: null },
    ])
  })

  test('an unchanged refresh keeps the same state (nothing to redraw)', () => {
    const state = readWindows(emptyPlanUsage(), [five(40, 5 * H)], 1000)
    expect(readWindows(state, [five(40, 5 * H)], 61_000)).toBe(state)
  })

  test('at the reset: no number until a response reads the new window, whether the old reading stays or leaves the list', () => {
    const resetAt = 5 * H
    const before = readWindows(emptyPlanUsage(), [five(91, resetAt), seven(30, 100 * H)], resetAt - M)
    expect(planUsageView(before, resetAt - M)).toMatchObject({ kind: 'reading', percent: 91, isHigh: true, leftMs: M })
    // The engine still reports the old window past its reset (no response since): reset, no number.
    expect(planUsageView(before, resetAt)).toEqual({ kind: 'reset', at: resetAt })
    const stale = readWindows(before, [five(91, resetAt)], resetAt + 30_000)
    expect(planUsageView(stale, resetAt + 30_000)).toEqual({ kind: 'reset', at: resetAt })
    // The window leaves the list right after its reset: the same.
    const gone = readWindows(before, [seven(30, 100 * H)], resetAt + M)
    expect(planUsageView(gone, resetAt + M)).toEqual({ kind: 'reset', at: resetAt })
    expect(windowRows(gone, resetAt + M)[0]).toMatchObject({ name: '5-hour', percent: null, isReset: true })
    // The next response reads the new window.
    const next = readWindows(gone, [five(2, resetAt + 5 * H)], resetAt + 2 * M)
    expect(planUsageView(next, resetAt + 2 * M)).toMatchObject({ kind: 'reading', percent: 2, leftMs: 5 * H - 2 * M })
    // A window missing from the list before its reset keeps its last reading (the engine's last word).
    const missing = readWindows(before, [], resetAt - 30 * M)
    expect(planUsageView(missing, resetAt - 30 * M)).toMatchObject({ kind: 'reading', percent: 91 })
  })

  test('the limit: a window at 100%, or a request refused on the rate limit, until it lifts', () => {
    const now = 10 * H
    const full = readWindows(emptyPlanUsage(), [five(100, now + H)], now)
    expect(planUsageView(full, now)).toEqual({ kind: 'limited', window: 'five_hour', percent: 100, resetsAt: now + H, leftMs: H })
    // A request refused while the five-hour window reads full: limited by it; a later reading under 100% lifts it.
    let s: PlanUsage = noteRateLimited(full, now + 1000)
    expect(s.limited).toEqual({ at: now + 1000, window: 'five_hour' })
    expect(planUsageView(s, now + 2000)).toMatchObject({ kind: 'limited', window: 'five_hour' })
    s = readWindows(s, [five(3, now + 6 * H)], now + 2 * H)
    expect(s.limited).toBeNull()
    expect(planUsageView(s, now + 2 * H)).toMatchObject({ kind: 'reading', percent: 3 })
    // Its reset passing lifts it too: reset, no number.
    const atReset = noteRateLimited(full, now + 1000)
    expect(planUsageView(atReset, now + H)).toEqual({ kind: 'reset', at: now + H })
    // A refusal while no window reads full (a throttle): "rate limited" until a turn is answered; readings do not lift it.
    let throttled = noteRateLimited(readWindows(emptyPlanUsage(), [five(40, now + H)], now), now + 1000)
    expect(planUsageView(throttled, now + 2000)).toEqual({ kind: 'limited', window: null, percent: 40, resetsAt: null, leftMs: null })
    throttled = readWindows(throttled, [five(41, now + H)], now + 3000)
    expect(planUsageView(throttled, now + 3000)).toMatchObject({ kind: 'limited', window: null })
    expect(planUsageView(noteAnswered(throttled), now + 4000)).toMatchObject({ kind: 'reading', percent: 41 })
    // The seven-day window full: its own limit and reset.
    const week = noteRateLimited(readWindows(emptyPlanUsage(), [five(20, now + H), seven(100, now + 50 * H)], now), now + 1000)
    expect(planUsageView(week, now + 2000)).toEqual({ kind: 'limited', window: 'seven_day', percent: 100, resetsAt: now + 50 * H, leftMs: 50 * H - 2000 })
  })

  test('the minute look runs only while a countdown is ahead', () => {
    const now = 10 * H
    expect(isTicking(emptyPlanUsage(), now)).toBe(false)
    const reading = readWindows(emptyPlanUsage(), [five(10, now + H)], now)
    expect(isTicking(reading, now)).toBe(true)
    expect(isTicking(reading, now + H)).toBe(false)
    expect(isTicking(readWindows(emptyPlanUsage(), [], now, true), now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The runtime and the status bar.

async function started(rateLimits: unknown[] = []) {
  const f = fakeHost()
  f.live.usage = { ...f.live.usage, rateLimits: rateLimits as never }
  f.kept.store['settings.v1'] = defaultSettings()
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}

const segment = (rt: Runtime, columns = 160) => {
  const all = hudSegments(Views.hudOf(rt), tiersOf(columns)[0]!)
  const s = all.find(x => x.key === 'plan')
  return s === undefined ? null : [...s.spans, ...(s.after ?? [])].map(p => p.text).join('')
}
const cell = (rt: Runtime, columns = 120) => {
  const c = hudCells(Views.hudOf(rt), columns).find(x => x.key === 'plan')
  return c === undefined ? null : `${c.caption.map(p => p.text).join('')}|${c.parts.flatMap(p => p.value).map(p => p.text).join('')}`
}

describe('the 5H reading in the runtime', () => {
  test('before the first response: 5H — on the bar, a dash on Desktop; the run cost leaves the bar but stays in /cr status', async () => {
    const { rt } = await started()
    expect(segment(rt)).toBe('5H —')
    expect(cell(rt)).toBe('5-hour usage|—')
    expect(cell(rt, 60)).toBe('5h|—')
    const line = Views.statusLineOf(Views.hudOf(rt))
    expect(line).toContain('5H —')
    expect(line).not.toContain('Run $')
    expect(hudSegments(Views.hudOf(rt), tiersOf(160)[0]!).some(s => s.key === 'run')).toBe(false)
    expect(statusText(rt)).toContain('Cost')
    expect(statusText(rt)).toContain('Plan usage       No reading yet: it comes with the first response')
  })

  test('a measurement brings the windows: meter, percentage and countdown; a minute later the countdown has moved without a model call', async () => {
    const f = await started()
    const { rt } = f
    const resetsAt = f.now() + 2 * H + 14 * M
    rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [five(63, resetsAt), seven(18, f.now() + 40 * H)], changed: ['rateLimits'] })
    expect(segment(rt)).toBe('5H ▂▂▂▂▂▂ 63% · 2h14m')
    // The bar's used part in its tone, the rest the quietest gray: four of six cells for 63%.
    const spans = hudSegments(Views.hudOf(rt), tiersOf(160)[0]!).find(x => x.key === 'plan')!.spans
    expect(spans.filter(p => p.text.includes('▂')).map(p => [p.text.length, p.isTrack === true])).toEqual([[4, false], [2, true]])
    expect(cell(rt)).toBe('5-hour usage|63% · 2h14m')
    expect(cell(rt, 60)).toBe('5h|63%')
    expect(Views.statusLineOf(Views.hudOf(rt))).toContain('5H 63% · 2h14m')
    expect(f.kept.traces.some(t => t.startsWith('plan usage: five-hour 63%'))).toBe(true)
    // The narrowest bar keeps the number and the countdown, without the meter.
    expect(segment(rt, 44)).toBe('5H 63% · 2h14m')
    // The minute look: the countdown moves on its own; the reading is read again (no model call, no request).
    f.live.usage = { ...f.live.usage, rateLimits: [five(64, resetsAt), seven(18, f.now() + 40 * H)] as never }
    await f.advance(60_000)
    expect(segment(rt)).toBe('5H ▂▂▂▂▂▂ 64% · 2h13m')
    expect(planDetail(Views.hudOf(rt).plan, f.now())).toMatch(/^5-hour 64%, resets .+ \(in 2h 13m\) · 7-day 18%, resets .+ \(in 39h 59m\)$/)
  })

  test('the reset passes: no number, the minute look stops; the next response reads the new window', async () => {
    const f = await started()
    const { rt } = f
    rt.onMeasure({ context: f.live.usage.context, rateLimits: [five(88, f.now() + 3 * M)], changed: ['rateLimits'] } as never)
    expect(segment(rt)).toBe('5H ▂▂▂▂▂▂ 88% · 3m')
    expect(hudSegments(Views.hudOf(rt), tiersOf(160)[0]!).find(x => x.key === 'plan')!.spans.find(p => p.text === ' 88%')?.tone).toBe('warn')
    f.live.usage = { ...f.live.usage, rateLimits: [] as never }
    await f.advance(4 * M)
    expect(segment(rt)).toBe('5H reset · new window')
    expect(cell(rt)).toBe('5-hour usage|reset · new window')
    expect(Views.statusLineOf(Views.hudOf(rt))).toContain('5H reset · new window')
    expect((rt as unknown as { usageTicker: unknown }).usageTicker).toBeNull()
    // A new window's first reading.
    rt.onMeasure({ context: f.live.usage.context, rateLimits: [five(1, f.now() + 5 * H)], changed: ['rateLimits'] } as never)
    expect(segment(rt)).toBe('5H ▂▂▂▂▂▂ 1% · 5h')
  })

  test('a request refused on the rate limit: red, the one reading that never drops for room; an answered turn lifts it', async () => {
    const f = await started([five(100, 1_000_000 + 90 * M)])
    const { rt } = f
    // Another API error is not the plan's limit.
    rt.onStopFailure('overloaded')
    expect(rt.planUsage.limited).toBeNull()
    rt.onStopFailure('rate_limit')
    expect(rt.planUsage.limited).toMatchObject({ window: 'five_hour' })
    const s = hudSegments(Views.hudOf(rt), tiersOf(160)[0]!).find(x => x.key === 'plan')!
    expect(s.priority).toBe(0)
    expect(s.spans.map(p => p.text).join('')).toBe('5H limit · 1h30m')
    expect(s.spans.find(p => p.text === 'limit')?.tone).toBe('bad')
    expect(cell(rt)).toBe('5-hour usage|limit reached · 1h30m')
    expect(Views.statusLineOf(Views.hudOf(rt))).toContain('5H limit · 1h30m')
    expect(statusText(rt)).toContain('5-hour limit reached, resets')
    // A refusal with no window read as full: rate limited, until a turn is answered.
    const g = await started([five(40, 1_000_000 + 90 * M)])
    g.rt.onStopFailure('rate_limit')
    expect(segment(g.rt)).toBe('Rate limited')
    await g.rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'ok' })
    expect(segment(g.rt)).toBe('5H ▂▂▂▂▂▂ 40% · 1h30m')
  })

  test('an API key (no windows): after an answered turn the bar shows nothing for 5H, Desktop says Plan usage —', async () => {
    const f = await started()
    const { rt } = f
    expect(segment(rt)).toBe('5H —')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'ok' })
    expect(segment(rt)).toBeNull()
    expect(cell(rt)).toBe('Plan usage|—')
    expect(Views.statusLineOf(Views.hudOf(rt))).not.toContain('5H')
    expect(statusText(rt)).toContain('No five-hour window on this account')
    // An interrupted turn is no proof that a response came back.
    const g = await started()
    await g.rt.onTurnComplete({ agentId: undefined, reason: 'aborted', answer: '' })
    expect(segment(g.rt)).toBe('5H —')
  })

  test('a reload reads the windows again from Claude Code: the reading survives', async () => {
    const f = await started([five(52, 1_000_000 + 4 * H), seven(9, 1_000_000 + 99 * H)])
    expect(segment(f.rt)).toBe('5H ▂▂▂▂▂▂ 52% · 4h')
    f.rt.stopTimers()
    const again = new Runtime()
    again.bind(f.host)
    await again.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(segment(again)).toBe('5H ▂▂▂▂▂▂ 52% · 4h')
    expect(Views.hudOf(again).plan.windows.map(w => [w.name, w.percent])).toEqual([['5-hour', 52], ['7-day', 9]])
  })
})

describe('the 5H reading on the surfaces', () => {
  test('terminal and Desktop draw it from Claude Code\'s own session.measure; Context → Run spells out each window', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    // The engine beneath the plugin's hook: it echoes which units moved.
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.start(SESSION)
    await w.clock.advance(300)
    const resetsAt = Date.now() + 2 * H + 14 * M - 30_000
    const rateLimits = [five(63, resetsAt), seven(18, Date.now() + 40 * H)]
    w.live.usage = { ...w.live.usage, rateLimits: rateLimits as never }
    await $.session.measure({ context: w.live.usage.context, rateLimits: rateLimits as never, cost: { usd: 1.25 }, changed: ['rateLimits'] })
    await w.clock.advance(300)
    const terminal = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 160, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    const text = JSON.stringify(await terminal.drawn())
    expect(text).toContain('63%')
    expect(text).toContain('2h14m')
    expect(text).not.toContain('$1.25')
    await terminal.unmount()
    const desktop = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    const plan = await desktop.find({ key: 'cell-plan' })
    expect(plan).toBeDefined()
    expect(JSON.stringify(plan)).toContain('Five-hour plan usage 63%, resets in 2h 14m')
    // Seen in the Desktop app: "5-hour usage" sat flush right over its wider reading. The cell keeps the right edge
    // (it does not grow), and its caption starts where its reading starts, as in every other cell.
    expect(plan?.props.flexGrow).toBe(0)
    for (const key of ['cell-work', 'cell-ctx', 'cell-cache', 'cell-machine', 'cell-plan']) expect((await desktop.find({ key }))?.props.alignItems, key).toBe('flex-start')
    await desktop.unmount()
    const pane = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: { title: 'Control Room', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: { columns: 200, rows: 50, isFullscreen: true } })
    await pane.press({ key: 'tab-context' })
    await w.clock.advance(300)
    const ctx = JSON.stringify(await pane.drawn())
    expect(ctx).toContain('Plan usage')
    expect(ctx).toContain('7-day 18%')
  })
})

// The burn rate (`plan.rate`, off by default): each window's readings are kept where they moved, and the detail says how
// fast the window moves over its last six hours and when it would be full at that pace, counted from now. Derived from the
// readings only: no pace from stale or too few readings.

describe('the burn rate', () => {
  test('readings are kept where they moved, one per five minutes at most; a lower percent or another reset time starts afresh; the store shape is validated', () => {
    const t0 = 1_000_000
    const reset = t0 + 40 * H
    const at = (ms: number, pct: number, resetsAt: number | null = reset) => readWindows(emptyPlanUsage(), [seven(pct, resetsAt ?? reset)], ms)
    let kept = noteSamples(emptySamples(), at(t0, 20), t0)
    expect(kept.sevenDay).toEqual({ resetsAt: reset, points: [{ at: t0, percent: 20 }] })
    // The same reading, now or an hour later: nothing kept (the object is the same one).
    expect(noteSamples(kept, at(t0 + M, 20), t0 + M)).toBe(kept)
    expect(noteSamples(kept, at(t0 + H, 20), t0 + H)).toBe(kept)
    // A move within five minutes of the last kept reading replaces it.
    kept = noteSamples(kept, at(t0 + 2 * M, 21), t0 + 2 * M)
    expect(kept.sevenDay.points).toEqual([{ at: t0 + 2 * M, percent: 21 }])
    // A move past five minutes is added.
    kept = noteSamples(kept, at(t0 + 8 * M, 22), t0 + 8 * M)
    expect(kept.sevenDay.points.map(p => p.percent)).toEqual([21, 22])
    // A lower percent with the same reset time: a new window, read afresh.
    kept = noteSamples(kept, at(t0 + 20 * M, 5), t0 + 20 * M)
    expect(kept.sevenDay).toEqual({ resetsAt: reset, points: [{ at: t0 + 20 * M, percent: 5 }] })
    // Another reset time: afresh too.
    kept = noteSamples(kept, at(t0 + 30 * M, 9, reset + 7 * 24 * H), t0 + 30 * M)
    expect(kept.sevenDay).toEqual({ resetsAt: reset + 7 * 24 * H, points: [{ at: t0 + 30 * M, percent: 9 }] })
    // A window past its reset is not read into the ring.
    const past = readWindows(emptyPlanUsage(), [seven(50, t0)], t0 + H)
    expect(noteSamples(kept, past, t0 + H)).toBe(kept)
    // The five-hour window is kept the same way, on its own ring.
    const both = readWindows(emptyPlanUsage(), [five(30, t0 + 3 * H), seven(9, reset + 7 * 24 * H)], t0 + 31 * M)
    kept = noteSamples(kept, both, t0 + 31 * M)
    expect(kept.fiveHour.points).toEqual([{ at: t0 + 31 * M, percent: 30 }])
    // The store's copy, and a corrupt one.
    expect(samplesOf(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
    expect(samplesOf({ fiveHour: 'no', sevenDay: { resetsAt: 'x', points: [{ at: 1 }, { at: 2, percent: 3 }] } })).toEqual({
      fiveHour: { resetsAt: null, points: [] },
      sevenDay: { resetsAt: null, points: [{ at: 2, percent: 3 }] },
    })
    expect(samplesOf(undefined)).toEqual(emptySamples())
  })

  test('the pace is the slope over the last six hours of readings, from a fresh last reading; the time to full counts from now and only before the reset', () => {
    const t0 = 10 * H
    const ring = (points: [number, number][]) => ({ resetsAt: t0 + 100 * H, points: points.map(([at, percent]) => ({ at, percent })) })
    expect(trendOf(ring([]), t0, null)).toBeNull()
    expect(trendOf(ring([[t0 - M, 10]]), t0, null)).toBeNull()
    expect(trendOf(ring([[t0 - 5 * M, 10], [t0, 11]]), t0, null)).toBeNull()
    // 10% to 20% over two hours: 5 %/h; 80% left is 16 hours from the last reading.
    expect(trendOf(ring([[t0 - 2 * H, 10], [t0 - H, 15], [t0, 20]]), t0, 40 * H)).toEqual({ perHour: 5, fullInMs: 16 * H })
    // Ten minutes on, the time to full has moved on with the clock (the same readings).
    expect(trendOf(ring([[t0 - 2 * H, 10], [t0, 20]]), t0 + 10 * M, 40 * H)).toEqual({ perHour: 5, fullInMs: 16 * H - 10 * M })
    // A last reading older than fifteen minutes says nothing about now.
    expect(trendOf(ring([[t0 - 2 * H, 10], [t0, 20]]), t0 + 16 * M, 40 * H)).toBeNull()
    // The reset comes first: no "full in".
    expect(trendOf(ring([[t0 - 2 * H, 10], [t0, 20]]), t0, 10 * H)).toEqual({ perHour: 5, fullInMs: null })
    // Readings older than six hours are left out: the pace is read from the ones inside the span.
    expect(trendOf(ring([[t0 - 8 * H, 0], [t0 - 2 * H, 10], [t0, 20]]), t0, null)).toEqual({ perHour: 5, fullInMs: 16 * H })
    // A flat window has a pace of nought and no "full in"; a full one none either.
    expect(trendOf(ring([[t0 - H, 20], [t0, 20]]), t0, null)).toEqual({ perHour: 0, fullInMs: null })
    expect(trendOf(ring([[t0 - H, 90], [t0, 100]]), t0, null)).toEqual({ perHour: 10, fullInMs: null })
    // The time to full is read from the pace as measured, not from the rounded figure shown.
    const slow = trendOf(ring([[t0 - 2 * H, 0], [t0, 1.08]]), t0, null)
    expect(slow?.perHour).toBe(0.5)
    expect(slow?.fullInMs).toBe(Math.round(((100 - 1.08) / 0.54) * H))
    // Rows carry the pace only with samples; without them the row is as before.
    const state = readWindows(emptyPlanUsage(), [seven(20, t0 + 40 * H)], t0)
    expect(windowRows(state, t0).map(r => r.trend)).toEqual([null])
    const samples = { ...emptySamples(), sevenDay: ring([[t0 - 2 * H, 10], [t0, 20]]) }
    expect(windowRows(state, t0, samples).map(r => r.trend)).toEqual([{ perHour: 5, fullInMs: 16 * H }])
  })

  test('with plan.rate on, the detail shows each window\'s pace and the time to full, the readings survive a restart and the session end; off, nothing changes', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, rate: true } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const sevenReset = f.now() + 80 * H
    const fiveReset = f.now() + 4 * H
    const read = (fivePct: number, sevenPct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [five(fivePct, fiveReset), seven(sevenPct, sevenReset)], changed: ['rateLimits'] })
    read(30, 20)
    expect(planDetail(Views.hudOf(rt).plan, f.now())).not.toContain('%/h')
    await f.advance(H)
    read(35, 22)
    await f.advance(H)
    read(40, 24)
    // 7-day: 20% to 24% over two hours, +2.0 %/h, full 38 hours from the last reading (the reset is 78 hours away).
    // 5-hour: 30% to 40%, +5.0 %/h, full in 12 hours: after its reset in 2 hours, so no "full in".
    const detail = planDetail(Views.hudOf(rt).plan, f.now())
    expect(detail).toMatch(/^5-hour 40%, \+5\.0 %\/h, resets .+ · 7-day 24%, \+2\.0 %\/h \(100% in 38h\), resets /)
    // Ten minutes on, with no new reading, the time to full has moved on with the clock.
    await f.advance(10 * M)
    expect(planDetail(Views.hudOf(rt).plan, f.now())).toContain('(100% in 37h 50m)')
    // Past fifteen minutes without a reading, no pace at all.
    await f.advance(6 * M)
    expect(planDetail(Views.hudOf(rt).plan, f.now())).not.toContain('%/h')
    // The readings are in the store under their own key, and a restart reads them back.
    const saved = f.kept.store['plan.v1'] as { sevenDay: { points: { percent: number }[] } }
    expect(saved.sevenDay.points.map(p => p.percent)).toEqual([20, 22, 24])
    const again = new Runtime()
    again.bind(f.host)
    await again.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(again.planSamples.sevenDay.points.length).toBe(3)
    // A reading right before the session ends is written at the end, not lost in the debounce.
    again.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [five(41, fiveReset), seven(26, sevenReset)], changed: ['rateLimits'] })
    await again.onSessionEnd({ reason: 'prompt_input_exit' } as never)
    expect((f.kept.store['plan.v1'] as typeof saved).sevenDay.points.map(p => p.percent)).toEqual([20, 22, 24, 26])
    // Off (the default): no pace in the detail, nothing in the store.
    const g = fakeHost()
    g.kept.store['settings.v1'] = defaultSettings()
    const off = new Runtime()
    off.bind(g.host)
    await off.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await g.advance(200)
    off.onMeasure({ context: g.live.usage.context, cost: { usd: 0.6 }, rateLimits: [seven(20, g.now() + 40 * H)], changed: ['rateLimits'] })
    await g.advance(H)
    off.onMeasure({ context: g.live.usage.context, cost: { usd: 0.6 }, rateLimits: [seven(24, g.now() + 39 * H)], changed: ['rateLimits'] })
    await g.advance(5000)
    expect(planDetail(Views.hudOf(off).plan, g.now())).not.toContain('%/h')
    expect(g.kept.store['plan.v1']).toBeUndefined()
  })

  test('turning plan.rate on in the session reads the kept readings back and goes on from there', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = defaultSettings()
    const t0 = f.now()
    const reset = t0 + 80 * H
    f.kept.store['plan.v1'] = { fiveHour: { resetsAt: null, points: [] }, sevenDay: { resetsAt: reset, points: [{ at: t0 - 2 * H, percent: 10 }, { at: t0 - H, percent: 15 }] } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const read = (pct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [five(30, t0 + 3 * H), seven(pct, reset)], changed: ['rateLimits'] })
    read(20)
    expect(rt.planSamples.sevenDay.points).toEqual([])
    rt.update(s => void (s.plan = { ...s.plan, rate: true }))
    await f.advance(200)
    expect(rt.planSamples.sevenDay.points.map(p => p.percent)).toEqual([10, 15, 20])
    expect(planDetail(Views.hudOf(rt).plan, f.now())).toContain('+5.0 %/h')
  })
})
