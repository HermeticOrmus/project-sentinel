/**
 * The plan gates as a pure state machine over the 7-day window's readings: `step(model, input,
 * cfg)` returns the next model and what changed, and the Runtime carries out the mode's effects.
 *
 *   normal → economy → parking → hold         (at `economyAt`, `parkAt`, `holdAt` percent of the 7-day window)
 *   any → normal                               (a new window: another reset time, the reset time passed, or a
 *                                               reading ten points under the mode's floor; or no window to read)
 *
 * The pressure rises only on a fresh reading of the same window and keeps through a wobble under
 * its floor (no flapping): only a reading ten points under the floor reads as a new window. (The
 * sample ring in features/planUsage.ts starts afresh on any lower percent instead: a ring must hold
 * one rising series, while a mode must not flap.) A reading is fresh while a response carried it
 * within `staleMs` (`seenAt`), however long ago its figure last changed; with none, or an older one,
 * nothing moves: the gates act on what Claude Code reported just now, never on a guess. A reading
 * whose reset time has passed is of a window that ended and stands any mode down. Changed floors
 * read the last reading afresh, up or down. `enabled` off is `normal`.
 *
 * Pure: the Runtime feeds it the window it already keeps (features/planUsage.ts) and draws it.
 */

import type { WindowReading } from './planUsage'

export type PlanPressure = 'normal' | 'economy' | 'parking' | 'hold'

/** The modes in rising order; `floorOf` reads a mode's floor from the configuration. */
export const PRESSURES: readonly PlanPressure[] = ['normal', 'economy', 'parking', 'hold']

export type PlanGateConfig = {
  enabled: boolean
  /** Percent of the 7-day window from which each mode holds; kept in order by the settings. */
  economyAt: number
  parkAt: number
  holdAt: number
  /** A reading no response carried within this long (ms) moves nothing. */
  staleMs: number
}

export const DEFAULT_STALE_MS = 10 * 60_000

export type PlanGate = {
  pressure: PlanPressure
  /** The last fresh reading the gates read; null before any, and once the window is gone. */
  reading: WindowReading | null
  /** Since when the pressure holds (ms), null for `normal`. */
  since: number | null
  /** The floors the last reading was read under; changed floors read it afresh. Null before any reading. */
  floors: readonly [number, number, number] | null
  /** The state in a few words, for the trace and the panel. */
  note: string
}

/**
 * What the gates read: the 7-day window as Claude Code reports it now (null before any reading), and
 * when a response last carried it (`seenAt`; null before any): the Runtime's time of the last
 * measurement, answered turn, or minute look whose figure moved. The reading's own `readAt` says when
 * its figure changed, not when it was last reported, so freshness never reads from it.
 */
export type PlanGateInput = { sevenDay: WindowReading | null; seenAt: number | null; now: number }

/** The pressure moved: `from` what, to what; the Runtime applies the mode's effects. */
export type PlanGateEffect = { kind: 'pressure'; from: PlanPressure; to: PlanPressure; percent: number | null }

export type PlanGateStep = { model: PlanGate; effects: PlanGateEffect[] }

export const initialPlanGate = (): PlanGate => ({ pressure: 'normal', reading: null, since: null, floors: null, note: 'Off' })

/** The floor of a mode: the percent from which it holds; `normal` has none. */
export function floorOf(pressure: PlanPressure, cfg: PlanGateConfig): number | null {
  switch (pressure) {
    case 'normal':
      return null
    case 'economy':
      return cfg.economyAt
    case 'parking':
      return cfg.parkAt
    case 'hold':
      return cfg.holdAt
  }
}

/** The mode a percent of the window calls for on its own. */
export function pressureOf(percent: number, cfg: PlanGateConfig): PlanPressure {
  if (percent >= cfg.holdAt) return 'hold'
  if (percent >= cfg.parkAt) return 'parking'
  if (percent >= cfg.economyAt) return 'economy'
  return 'normal'
}

/** While a mode holds and its window's reset is ahead: a look a minute catches the reset without a response. */
export const isTicking = (model: PlanGate, now: number): boolean =>
  model.pressure !== 'normal' && model.reading !== null && model.reading.resetsAt !== null && now < model.reading.resetsAt

const rank = (p: PlanPressure): number => PRESSURES.indexOf(p)

/** How far under a mode's floor a reading may fall before it counts as a new window rather than a wobble. */
const DROP_POINTS = 10

const wordsOf = (pressure: PlanPressure, percent: number): string => {
  switch (pressure) {
    case 'normal':
      return `7-day ${percent}%: as configured`
    case 'economy':
      return `7-day ${percent}%: economy (shorter contexts, light agents, no forks)`
    case 'parking':
      return `7-day ${percent}%: finishing the turn, then the handoff and a park until the reset`
    case 'hold':
      return `7-day ${percent}%: automated turns held until the reset; your own prompts still run`
  }
}

const isSameReading = (a: WindowReading | null, b: WindowReading | null): boolean =>
  a === b || (a !== null && b !== null && a.percent === b.percent && a.resetsAt === b.resetsAt && a.readAt === b.readAt)

const floorsOf = (cfg: PlanGateConfig): readonly [number, number, number] => [cfg.economyAt, cfg.parkAt, cfg.holdAt]

const isSameFloors = (a: readonly [number, number, number] | null, b: readonly [number, number, number] | null): boolean =>
  a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2])

/** The next model, the same object when nothing changed, and the move as an effect when the pressure did. */
function settle(model: PlanGate, next: Omit<PlanGate, 'note'> & { note: string }): PlanGateStep {
  const from = model.pressure
  if (from === next.pressure && isSameReading(model.reading, next.reading) && model.since === next.since && isSameFloors(model.floors, next.floors) && model.note === next.note) {
    return { model, effects: [] }
  }
  return { model: next, effects: from === next.pressure ? [] : [{ kind: 'pressure', from, to: next.pressure, percent: next.reading?.percent ?? null }] }
}

/** Any mode stands down: no reading to hold it. */
const down = (model: PlanGate, note: string): PlanGateStep => settle(model, { pressure: 'normal', reading: null, since: null, floors: model.floors, note })

export function step(model: PlanGate, input: PlanGateInput, cfg: PlanGateConfig): PlanGateStep {
  if (!cfg.enabled) return down(model, 'Off')
  const r = input.sevenDay
  // No window to read (an API key, no response yet): any mode stands down, its reason gone.
  if (r === null) return down(model, 'No 7-day reading')
  // The reset time has passed: the reading is of a window that ended and says nothing about the one running now.
  if (r.resetsAt !== null && r.resetsAt <= input.now) return down(model, 'The 7-day window reset; waiting for a reading of the new one')
  // Fresh while a response carried the window within `staleMs`; a stale one moves nothing, and the note says so once.
  if (input.seenAt === null || input.now - input.seenAt > cfg.staleMs) {
    const note = model.reading === null ? 'No fresh 7-day reading' : `${wordsOf(model.pressure, model.reading.percent)} (stale reading)`
    return settle(model, { ...model, note })
  }
  const called = pressureOf(r.percent, cfg)
  const floor = floorOf(model.pressure, cfg)
  const floors = floorsOf(cfg)
  const isNewWindow = (model.reading !== null && model.reading.resetsAt !== r.resetsAt) || (floor !== null && r.percent < floor - DROP_POINTS)
  // Within a window the pressure only rises; a wobble under the floor keeps the mode. A new window, or new floors, reads afresh.
  const to = isNewWindow || !isSameFloors(model.floors, floors) || rank(called) >= rank(model.pressure) ? called : model.pressure
  const since = to === 'normal' ? null : to === model.pressure ? model.since : input.now
  return settle(model, { pressure: to, reading: r, since, floors, note: wordsOf(to, r.percent) })
}
