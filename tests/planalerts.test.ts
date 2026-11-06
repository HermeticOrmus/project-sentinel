import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { defaultSettings, normalizeSettings } from '../hooks/core/settings'
import { diffSystems } from '../hooks/core/profiles'
import { alertWords, dueAlert, emptyPlanAlerts, isStale, merged, planAlertsOf } from '../hooks/features/planAlerts'
import { fakeHost } from './fixtures/fake-host'

const H = 3_600_000
const reading = (percent: number, resetsAt: number | null, readAt = 0) => ({ percent, resetsAt, readAt })

describe('the plan alerts', () => {
  test('each threshold raises once per window; several crossed at once raise one; a new window starts afresh; past the reset nothing', () => {
    const reset = 100 * H
    const t = [50, 75, 90]
    let s = emptyPlanAlerts()
    const step = (percent: number, resetsAt: number | null, now = H) => {
      const out = dueAlert(s, reading(percent, resetsAt), t, now)
      s = out.state
      return out.alert
    }
    expect(step(20, reset)).toBeNull()
    expect(step(50, reset)).toEqual({ percent: 50, thresholds: [50], resetsAt: reset })
    expect(step(51, reset)).toBeNull()
    expect(step(50, reset)).toBeNull()
    // 92 at once: one alert, both 75 and 90 marked.
    expect(step(92, reset)).toEqual({ percent: 92, thresholds: [75, 90], resetsAt: reset })
    expect(s.raised).toEqual([50, 75, 90])
    expect(step(99, reset)).toBeNull()
    // Past the reset: nothing, the state untouched.
    const before = s
    expect(step(99, reset, reset)).toBeNull()
    expect(s).toBe(before)
    // The next window: afresh.
    expect(step(3, reset + 7 * 24 * H)).toBeNull()
    expect(s).toEqual({ resetsAt: reset + 7 * 24 * H, raised: [] })
    expect(step(76, reset + 7 * 24 * H)).toEqual({ percent: 76, thresholds: [50, 75], resetsAt: reset + 7 * 24 * H })
    // No reading, or no thresholds: nothing, the same state.
    expect(dueAlert(s, null, t, H)).toEqual({ state: s, alert: null })
    expect(dueAlert(s, reading(99, reset), [], H)).toEqual({ state: s, alert: null })
    // The thresholds in any order read the same.
    expect(dueAlert(emptyPlanAlerts(), reading(80, reset), [90, 50, 75], H).alert?.thresholds).toEqual([50, 75])
    // No reset time given: a percent under the lowest threshold raised is a new window.
    let n = emptyPlanAlerts()
    const bare = (percent: number) => {
      const out = dueAlert(n, reading(percent, null), t, H)
      n = out.state
      return out.alert?.thresholds ?? null
    }
    expect([bare(60), bare(95), bare(5), bare(60)]).toEqual([[50], [75, 90], null, [50]])
    // What the store holds joined with this session's own, each read for the reading's window first: a union where both name
    // it, the later window where they differ (none counts as the earliest), the store's own object when nothing is added.
    const at = (percent: number, resetsAt: number | null = reset) => reading(percent, resetsAt)
    expect(merged({ resetsAt: reset, raised: [50] }, { resetsAt: reset, raised: [50, 75] }, at(80), H)).toEqual({ resetsAt: reset, raised: [50, 75] })
    const stored = { resetsAt: reset, raised: [50, 75] }
    expect(merged(stored, { resetsAt: reset, raised: [50] }, at(80), H)).toBe(stored)
    const mine = { resetsAt: reset + 1, raised: [90] }
    expect(merged(stored, mine, at(91, reset + 1), H)).toEqual(mine)
    expect(merged(stored, mine, at(80), H)).toBe(stored)
    expect(merged(stored, null, at(80), H)).toBe(stored)
    expect(merged(stored, mine, null, H)).toBe(stored)
    // A reading with no reset time between two with one is the same window.
    let w = emptyPlanAlerts()
    const r = (percent: number, resetsAt: number | null) => {
      const out = dueAlert(w, reading(percent, resetsAt), t, H)
      w = out.state
      return out.alert?.thresholds ?? null
    }
    expect([r(55, reset), r(56, null), r(57, reset)]).toEqual([[50], null, null])
    expect(w).toEqual({ resetsAt: reset, raised: [50] })
    // A state with no reset time yet takes the reading's.
    expect(dueAlert({ resetsAt: null, raised: [50] }, reading(60, reset), t, H).state).toEqual({ resetsAt: reset, raised: [50] })
    // A state raised from readings with no reset time, read at a low percent with one: a new window, not the old list carried in.
    const carried = dueAlert({ resetsAt: null, raised: [50, 75, 90] }, reading(10, reset), t, H)
    expect(carried).toEqual({ state: { resetsAt: reset, raised: [] }, alert: null })
    expect(dueAlert(carried.state, reading(55, reset), t, H).alert).toEqual({ percent: 55, thresholds: [50], resetsAt: reset })
    // And the other way: a state with a reset time, read at a low percent without one, is a new window too.
    expect(dueAlert({ resetsAt: reset, raised: [50] }, reading(10, null), t, H).state).toEqual({ resetsAt: null, raised: [] })
    // A reading with no reset time reads against the later window either side knows; a session whose readings had none reads
    // against the window the reading names.
    expect(merged({ resetsAt: null, raised: [] }, { resetsAt: reset, raised: [50] }, at(56, null), H)).toEqual({ resetsAt: reset, raised: [50] })
    expect(merged({ resetsAt: null, raised: [] }, { resetsAt: null, raised: [50] }, at(57), H)).toEqual({ resetsAt: reset, raised: [50] })
    expect(merged({ resetsAt: reset, raised: [50] }, { resetsAt: null, raised: [75] }, at(80), H)).toEqual({ resetsAt: reset, raised: [50, 75] })
    expect(merged({ resetsAt: reset, raised: [50] }, { resetsAt: reset + 1, raised: [50] }, at(60, null), H)).toEqual({ resetsAt: reset + 1, raised: [50] })
    // This session's list from readings with no reset time, the store's from the window: a low reading of the window starts this
    // session's afresh and the store's thresholds alone count, so 80% then raises 75 rather than nothing.
    const joined = merged({ resetsAt: reset, raised: [50] }, { resetsAt: null, raised: [50, 75, 90] }, at(10), H)
    expect(joined).toEqual({ resetsAt: reset, raised: [50] })
    expect(dueAlert(joined, at(80), t, H).alert?.thresholds).toEqual([75])
    // Another session moved on to the next window: a reading with no reset time reads that window, not this session's old
    // one, so the other session never raises 75 again.
    const moved = merged({ resetsAt: reset + 1, raised: [50] }, { resetsAt: reset, raised: [50] }, at(80, null), H)
    expect(moved).toEqual({ resetsAt: reset + 1, raised: [50] })
    expect(dueAlert(moved, at(80, null), t, H)).toEqual({ state: { resetsAt: reset + 1, raised: [50, 75] }, alert: { percent: 80, thresholds: [75], resetsAt: null } })
    expect(dueAlert({ resetsAt: reset + 1, raised: [50, 75] }, at(81, reset + 1), t, H).alert).toBeNull()
    // The two agree: with a store that never writes, 55 at the reset, 56 with none, 57 at the reset raise 50 once.
    let m: ReturnType<typeof emptyPlanAlerts> | null = null
    const raisedOn = [55, 56, 57].map((percent, i) => {
      const r = at(percent, i === 1 ? null : reset)
      const out = dueAlert(merged(emptyPlanAlerts(), m, r, H), r, t, H)
      m = out.state
      return out.alert?.thresholds ?? null
    })
    expect(raisedOn).toEqual([[50], null, null])
    // A state whose window has passed, read without a reset time: a new window, its first threshold raised.
    expect(dueAlert({ resetsAt: reset, raised: [50] }, at(60, null), t, reset + H)).toEqual({ state: { resetsAt: null, raised: [50] }, alert: { percent: 60, thresholds: [50], resetsAt: null } })
    expect(merged({ resetsAt: reset, raised: [50] }, { resetsAt: null, raised: [50] }, at(60, null), reset + H)).toEqual({ resetsAt: null, raised: [50] })
    // The store's list is stale once a reading leaves its window behind; empty, unread, or past the reading's own reset, it is not.
    expect(isStale({ resetsAt: null, raised: [50] }, at(10), H)).toBe(true)
    expect(isStale({ resetsAt: reset, raised: [50] }, at(10, reset + 1), H)).toBe(true)
    expect(isStale({ resetsAt: reset, raised: [50] }, at(60, null), reset + H)).toBe(true)
    expect(isStale({ resetsAt: reset, raised: [] }, at(55), H)).toBe(false)
    expect(isStale({ resetsAt: reset, raised: [50] }, at(60), H)).toBe(false)
    expect(isStale({ resetsAt: reset, raised: [50] }, at(60), reset + H)).toBe(false)
    expect(isStale({ resetsAt: null, raised: [50] }, null, H)).toBe(false)
  })

  test('the words name the reading, the highest threshold crossed and the reset in UTC; the store shape is validated', () => {
    expect(alertWords({ percent: 76, thresholds: [50, 75], resetsAt: Date.UTC(2026, 10, 9, 0, 0) })).toBe('7-day plan window at 76% (past 75%, resets 2026-11-09 00:00Z)')
    expect(alertWords({ percent: 50, thresholds: [50], resetsAt: null })).toBe('7-day plan window at 50% (past 50%)')
    expect(planAlertsOf(undefined)).toEqual({ resetsAt: null, raised: [] })
    expect(planAlertsOf({ resetsAt: 5, raised: [50, 'x', 75, null] })).toEqual({ resetsAt: 5, raised: [50, 75] })
    expect(planAlertsOf('junk')).toEqual({ resetsAt: null, raised: [] })
  })

  test('the setting is a list of whole percents, unique and rising, at most ten; anything else is the default', () => {
    const base = defaultSettings()
    expect(normalizeSettings(undefined).plan.alerts).toEqual([])
    expect(normalizeSettings({ ...base, plan: { ...base.plan, alerts: [90, 50, 75.4, 50, 0, 101, 'x'] } }).plan.alerts).toEqual([50, 75, 90])
    expect(normalizeSettings({ ...base, plan: { ...base.plan, alerts: 'all' } }).plan.alerts).toEqual([])
    expect(normalizeSettings({ ...base, plan: { ...base.plan, alerts: Array.from({ length: 20 }, (_, i) => i + 1) } }).plan.alerts).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    // A profile diff shows the percents, not JSON.
    const change = diffSystems(base, { ...base, plan: { ...base.plan, alerts: [50, 75, 90] } }).find(c => c.label === 'Plan alerts')
    expect(change).toMatchObject({ from: 'Off', to: '50%, 75%, 90%' })
  })

  test('the runtime raises each alert once per window on the machine through host.notify, keeps it in the store, and falls back to a toast when refused', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, alerts: [50, 75, 90] } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const resetsAt = Date.UTC(2026, 10, 9, 0, 0)
    const read = async (pct: number, at = resetsAt) => {
      rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(at).toISOString() }], changed: ['rateLimits'] })
      await f.advance(10)
    }
    await read(20)
    expect(f.kept.notified).toEqual([])
    await read(55)
    expect(f.kept.notified).toEqual([{ title: 'Plan', text: '7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z)' }])
    expect(f.kept.store['planAlerts.v1']).toEqual({ resetsAt, raised: [50] })
    expect(f.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z), sent (kitty)')
    await read(60)
    await read(55)
    expect(f.kept.notified).toHaveLength(1)
    // Another session on this machine raised 75 meanwhile: this one does not raise it again.
    f.kept.store['planAlerts.v1'] = { resetsAt, raised: [50, 75] }
    await read(80)
    expect(f.kept.notified).toHaveLength(1)
    // No channel: a toast on the terminal says it, and the alert still counts as raised.
    f.live.notifyResult = { isSent: false, reason: 'no-channel' }
    await read(92)
    expect(f.kept.notified).toHaveLength(2)
    expect(f.kept.notified[1]!.text).toBe('7-day plan window at 92% (past 90%, resets 2026-11-09 00:00Z)')
    expect(f.kept.toasts.at(-1)).toBe('Plan alert: 7-day plan window at 92% (past 90%, resets 2026-11-09 00:00Z)')
    expect(f.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 92% (past 90%, resets 2026-11-09 00:00Z), raised through the Notification hooks, no channel wrote it (no-channel), shown as a toast')
    expect(f.kept.store['planAlerts.v1']).toEqual({ resetsAt, raised: [50, 75, 90] })
    // The next window: 50 again. A hook's refusal, or a rejection (a hook's deny or a failed write, reported the same): no toast,
    // the trace says so.
    const toasts = f.kept.toasts.length
    f.live.notifyResult = { isSent: false, reason: 'refused' }
    await read(52, resetsAt + 7 * 24 * H)
    expect(f.kept.notified).toHaveLength(3)
    expect(f.kept.store['planAlerts.v1']).toEqual({ resetsAt: resetsAt + 7 * 24 * H, raised: [50] })
    expect(f.kept.toasts).toHaveLength(toasts)
    expect(f.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 52% (past 50%, resets 2026-11-16 00:00Z), refused by a hook above')
    f.live.notifyResult = { isSent: false, reason: 'rejected', detail: 'a hook said no' }
    await read(77, resetsAt + 7 * 24 * H)
    expect(f.kept.toasts).toHaveLength(toasts)
    expect(f.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 77% (past 75%, resets 2026-11-16 00:00Z), rejected (a hook said no)')
    // A bell alone wrote nothing in words: a toast carries them.
    f.live.notifyResult = { isSent: true, channel: 'terminal_bell' }
    await read(91, resetsAt + 7 * 24 * H)
    expect(f.kept.toasts.at(-1)).toBe('Plan alert: 7-day plan window at 91% (past 90%, resets 2026-11-16 00:00Z)')
    expect(f.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 91% (past 90%, resets 2026-11-16 00:00Z), sent (terminal_bell), shown as a toast')
    // Nothing else went out: no prompt, no question, and the gates (off) read nothing.
    expect(f.kept.submitted).toEqual([])
    expect(f.kept.asked).toEqual([])
    expect(rt.planGate.pressure).toBe('normal')
  })

  test('two readings back to back, or a store that will not write, never raise a threshold twice from one session; Desktop toasts, headless does not', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, alerts: [50, 75, 90] } }
    f.host.surfaces = async () => ['desktop']
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await f.advance(200)
    const resetsAt = Date.UTC(2026, 10, 9, 0, 0)
    const read = (pct: number) => rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    // Two readings before either alert was read against the store: one alert.
    read(55)
    read(55.3)
    await f.advance(10)
    expect(f.kept.notified).toHaveLength(1)
    // On Desktop the engine answers no-surface after the hooks ran: a toast shows the words there.
    f.live.notifyResult = { isSent: false, reason: 'no-surface' }
    read(76)
    await f.advance(10)
    expect(f.kept.notified).toHaveLength(2)
    expect(f.kept.toasts.at(-1)).toBe('Plan alert: 7-day plan window at 76% (past 75%, resets 2026-11-09 00:00Z)')
    // The store will not write: this session still remembers what it raised.
    f.host.storeSet = async () => {
      throw new Error('disk full')
    }
    read(91)
    read(92)
    read(93)
    await f.advance(10)
    expect(f.kept.notified).toHaveLength(3)
    expect(f.kept.store['planAlerts.v1']).toEqual({ resetsAt, raised: [50, 75] })
    // Headless: no surface, no toast; the hooks alone ran.
    const g = fakeHost()
    g.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, alerts: [50] } }
    g.host.surfaces = async () => []
    g.live.notifyResult = { isSent: false, reason: 'no-surface' }
    const headless = new Runtime()
    headless.bind(g.host)
    await headless.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: false })
    await g.advance(200)
    headless.onMeasure({ context: g.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    await g.advance(10)
    expect(g.kept.notified).toHaveLength(1)
    expect(g.kept.toasts.filter(t => t.startsWith('Plan alert'))).toEqual([])
    expect(g.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 60% (past 50%, resets 2026-11-09 00:00Z), raised through the Notification hooks, no channel wrote it (no-surface)')
  })

  test('a store that never writes still raises each threshold once per window from this session; one failure never stops the next alert; alerts set mid-window read at once', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, alerts: [50, 75] } }
    f.host.storeSet = async () => {
      throw new Error('disk full')
    }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const resetsAt = Date.UTC(2026, 10, 9, 0, 0)
    const read = async (pct: number, at = resetsAt) => {
      rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(at).toISOString() }], changed: ['rateLimits'] })
      await f.advance(10)
    }
    // First use, the store empty and never written: one alert for 50 across three moved readings, the second of them with no
    // reset time (the engine's is optional); the next window its own.
    await read(55)
    rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 56 }], changed: ['rateLimits'] })
    await f.advance(10)
    await read(57)
    expect(f.kept.notified.map(n => n.text)).toEqual(['7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z)'])
    await read(52, resetsAt + 7 * 24 * H)
    await read(53, resetsAt + 7 * 24 * H)
    await read(77, resetsAt + 7 * 24 * H)
    expect(f.kept.notified.map(n => n.text)).toEqual([
      '7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z)',
      '7-day plan window at 52% (past 50%, resets 2026-11-16 00:00Z)',
      '7-day plan window at 77% (past 75%, resets 2026-11-16 00:00Z)',
    ])
    expect(f.kept.store['planAlerts.v1']).toBeUndefined()
    // A toast that throws once: traced, and the next threshold still raises.
    const g = fakeHost()
    g.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, alerts: [50, 75, 90] } }
    g.live.notifyResult = { isSent: false, reason: 'no-channel' }
    const toast = g.host.toast
    g.host.toast = () => {
      g.host.toast = toast
      throw new Error('boom')
    }
    const rt2 = new Runtime()
    rt2.bind(g.host)
    await rt2.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await g.advance(200)
    const read2 = async (pct: number) => {
      rt2.onMeasure({ context: g.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
      await g.advance(10)
    }
    await read2(55)
    // The toast's failure is said on the alert's own line, after what the notification did; no line claims it showed.
    expect(g.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z), raised through the Notification hooks, no channel wrote it (no-channel), the toast failed (boom)')
    expect(g.kept.traces.filter(t => t.includes('shown as a toast') || t.startsWith('plan alert: failed'))).toEqual([])
    await read2(80)
    expect(g.kept.notified.map(n => n.text)).toEqual(['7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z)', '7-day plan window at 80% (past 75%, resets 2026-11-09 00:00Z)'])
    expect(g.kept.toasts.at(-1)).toBe('Plan alert: 7-day plan window at 80% (past 75%, resets 2026-11-09 00:00Z)')
    // An error inside the alert itself (the store read throwing outright): the chain says so, and the next reading still raises.
    const storeGet = g.host.storeGet
    g.host.storeGet = () => {
      g.host.storeGet = storeGet
      throw new Error('boom')
    }
    await read2(91)
    expect(g.kept.traces.at(-1)).toBe('plan alert: failed (boom)')
    expect(g.kept.notified).toHaveLength(2)
    // Toasts off: no toast, and the trace does not claim one.
    rt2.update(s => void (s.ui = { ...s.ui, toasts: false }))
    await read2(92)
    expect(g.kept.toasts.filter(t => t.includes('92%'))).toEqual([])
    expect(g.kept.traces.at(-1)).toBe('plan alert: 7-day plan window at 92% (past 90%, resets 2026-11-09 00:00Z), raised through the Notification hooks, no channel wrote it (no-channel)')
    // Alerts set mid-window, the window already past a threshold: read at once.
    const h = fakeHost()
    h.kept.store['settings.v1'] = defaultSettings()
    const rt3 = new Runtime()
    rt3.bind(h.host)
    await rt3.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await h.advance(200)
    rt3.onMeasure({ context: h.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })
    await h.advance(10)
    expect(h.kept.notified).toEqual([])
    rt3.update(s => void (s.plan = { ...s.plan, alerts: [50, 75] }))
    await h.advance(10)
    expect(h.kept.notified.map(n => n.text)).toEqual(['7-day plan window at 60% (past 50%, resets 2026-11-09 00:00Z)'])
  })

  test("a new window is written to the store as soon as a reading starts one, so the old window's list without a reset time is not read into it", async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, alerts: [50, 75, 90] } }
    // The store's list from the previous window, written from readings that carried no reset time.
    f.kept.store['planAlerts.v1'] = { resetsAt: null, raised: [50, 75, 90] }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const resetsAt = Date.UTC(2026, 10, 9, 0, 0)
    const read = async (pct: number, at: number | null = resetsAt) => {
      rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, ...(at === null ? {} : { resetsAt: new Date(at).toISOString() }) }], changed: ['rateLimits'] })
      await f.advance(10)
    }
    await read(10)
    expect(f.kept.notified).toEqual([])
    expect(f.kept.store['planAlerts.v1']).toEqual({ resetsAt, raised: [] })
    await read(55)
    await read(80)
    expect(f.kept.notified.map(n => n.text)).toEqual(['7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z)', '7-day plan window at 80% (past 75%, resets 2026-11-09 00:00Z)'])
    // A reading that changes nothing writes nothing.
    const storeSet = f.host.storeSet
    let writes = 0
    f.host.storeSet = async (key: string, value: unknown) => {
      writes++
      return storeSet(key, value)
    }
    await read(81)
    await read(82, null)
    expect(writes).toBe(0)
    expect(f.kept.store['planAlerts.v1']).toEqual({ resetsAt, raised: [50, 75] })
    // A session that holds a list of its own when the new window starts: the store is written over all the same.
    const g = fakeHost()
    g.kept.store['settings.v1'] = { ...defaultSettings(), plan: { ...defaultSettings().plan, alerts: [50, 75, 90] } }
    const rt2 = new Runtime()
    rt2.bind(g.host)
    await rt2.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await g.advance(200)
    const read2 = async (pct: number, at: number | null) => {
      rt2.onMeasure({ context: g.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, ...(at === null ? {} : { resetsAt: new Date(at).toISOString() }) }], changed: ['rateLimits'] })
      await g.advance(10)
    }
    await read2(55, null)
    expect(g.kept.store['planAlerts.v1']).toEqual({ resetsAt: null, raised: [50] })
    await read2(10, resetsAt)
    expect(g.kept.store['planAlerts.v1']).toEqual({ resetsAt, raised: [] })
    await read2(55, resetsAt)
    await read2(80, resetsAt)
    expect(g.kept.notified.map(n => n.text)).toEqual(['7-day plan window at 55% (past 50%)', '7-day plan window at 55% (past 50%, resets 2026-11-09 00:00Z)', '7-day plan window at 80% (past 75%, resets 2026-11-09 00:00Z)'])
  })

  test('with no alerts set (the default) nothing is read, notified or stored', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = defaultSettings()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 96, resetsAt: new Date(f.now() + H).toISOString() }], changed: ['rateLimits'] })
    await f.advance(10)
    expect(f.kept.notified).toEqual([])
    expect(f.kept.toasts.filter(t => t.startsWith('Plan alert'))).toEqual([])
    expect(f.kept.store['planAlerts.v1']).toBeUndefined()
  })
})
