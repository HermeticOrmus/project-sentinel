/**
 * The plan alerts (`plan.alerts`): at each percent listed, once per 7-day window, the person is told
 * through their own notification channel (`host.notify`, Claude Code's `ui.notify`: their
 * `Notification` hooks run first, then the channel writes). Pure: `dueAlert` reads the window's
 * latest reading against what was raised for that window and says what to raise now; the Runtime
 * raises it and keeps the state in the store (`planAlerts.v1`), so every session on the machine
 * shares one list and a restart raises nothing twice.
 *
 * One alert per step: when a reading crosses several thresholds at once (40 then 80 with 50 and
 * 75 listed), one alert names the reading and both thresholds are marked raised. A new window
 * (another reset time where both are known; a window whose reset has passed; where either side
 * lacks a reset time, a percent under the lowest threshold raised, since usage never falls inside a
 * window) starts afresh; a reading past its reset raises nothing. Freshness is not read here: the
 * figure is what Claude Code reports, and a late alert still tells the truth. `merged` joins what
 * the store holds with what this session raised, each read for the reading's window first by the
 * same rule, so a store write that failed, two sessions writing at once, or a reading with no reset
 * time (the engine's is optional) raise no threshold twice from here nor lose one, short of a failed
 * write here and another session's write landing between two readings without a reset time. The
 * Runtime writes a new window to the store as soon as a reading starts one, so a list the store
 * holds without a reset time from the old window is not read into the new one. The percent rule
 * takes usage never to fall inside a window: a late or cached lower figure (a new session's startup
 * read of the engine's earlier one) against a store without a reset time reads as a new window and
 * writes over it, and a session holding that list may raise its thresholds again; a store with a
 * reset time is not misread so.
 */

import type { WindowReading } from './planUsage'

/** What was raised for one window: its reset time names it. */
export type PlanAlertState = { resetsAt: number | null; raised: number[] }

export const emptyPlanAlerts = (): PlanAlertState => ({ resetsAt: null, raised: [] })

/** The state as the store kept it; anything foreign or corrupt reads as none. */
export function planAlertsOf(raw: unknown): PlanAlertState {
  const r = typeof raw === 'object' && raw !== null ? (raw as { resetsAt?: unknown; raised?: unknown }) : {}
  const resetsAt = typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt) ? r.resetsAt : null
  const raised = Array.isArray(r.raised) ? r.raised.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : []
  return { resetsAt, raised }
}

/** The alert to raise now: the reading, the thresholds it crossed, and the window's reset. */
export type PlanAlert = { percent: number; thresholds: number[]; resetsAt: number | null }

/**
 * A state read for this reading's window: afresh where the reading says a new window (another reset
 * time where both are known; the state's reset passed; where either side lacks a reset time, a percent
 * under the lowest threshold raised), the reading's reset time taken where the state had none, else
 * the state itself.
 */
function windowFor(state: PlanAlertState, sevenDay: WindowReading, now: number): PlanAlertState {
  const isNewWindow =
    (state.resetsAt !== null && sevenDay.resetsAt !== null && state.resetsAt !== sevenDay.resetsAt) ||
    (state.resetsAt !== null && state.resetsAt <= now) ||
    ((state.resetsAt === null || sevenDay.resetsAt === null) && state.raised.length > 0 && sevenDay.percent < Math.min(...state.raised))
  if (isNewWindow) return { resetsAt: sevenDay.resetsAt, raised: [] }
  if (state.resetsAt === null && sevenDay.resetsAt !== null) return { resetsAt: sevenDay.resetsAt, raised: state.raised }
  return state
}

/**
 * Reads the 7-day window against the thresholds (percent, in any order) and what was raised for this
 * window. Returns the state to keep (`state` itself when nothing changed) and the alert due, if any.
 */
export function dueAlert(state: PlanAlertState, sevenDay: WindowReading | null, thresholds: readonly number[], now: number): { state: PlanAlertState; alert: PlanAlert | null } {
  if (sevenDay === null || thresholds.length === 0) return { state, alert: null }
  if (sevenDay.resetsAt !== null && sevenDay.resetsAt <= now) return { state, alert: null }
  const current = windowFor(state, sevenDay, now)
  const crossed = thresholds.filter(t => sevenDay.percent >= t && !current.raised.includes(t)).sort((a, b) => a - b)
  if (crossed.length === 0) return { state: current, alert: null }
  return { state: { resetsAt: current.resetsAt, raised: [...current.raised, ...crossed].sort((a, b) => a - b) }, alert: { percent: sevenDay.percent, thresholds: crossed, resetsAt: sevenDay.resetsAt } }
}

/**
 * What the store holds and what this session raised, each read for the reading's window first (as
 * `dueAlert` reads it, so the two never disagree): the union where both name one window, the later
 * window where they differ (a store that would not write, or one reset by hand, loses nothing this
 * session raised; a session behind another's window reads that window, not its own old one; no
 * reset time counts as the earliest), the store's side itself when nothing is added (its own object
 * where the reading left it as it was). With no reading, or nothing raised here, the store's.
 */
export function merged(stored: PlanAlertState, mine: PlanAlertState | null, sevenDay: WindowReading | null, now: number): PlanAlertState {
  if (mine === null || sevenDay === null) return stored
  const s = windowFor(stored, sevenDay, now)
  const m = windowFor(mine, sevenDay, now)
  if (s.resetsAt !== m.resetsAt) return (s.resetsAt ?? -Infinity) > (m.resetsAt ?? -Infinity) ? s : m
  const extra = m.raised.filter(t => !s.raised.includes(t))
  return extra.length === 0 ? s : { resetsAt: s.resetsAt, raised: [...s.raised, ...extra].sort((a, b) => a - b) }
}

/**
 * Whether the store's list is of a window this reading leaves behind (its thresholds all gone once read
 * for the reading's window): the Runtime writes the new window at once then, so a later reading of it
 * never reads the old list in. An empty or unreadable store is never stale; a reading past its reset
 * says nothing about the window.
 */
export function isStale(stored: PlanAlertState, sevenDay: WindowReading | null, now: number): boolean {
  if (sevenDay === null || stored.raised.length === 0) return false
  if (sevenDay.resetsAt !== null && sevenDay.resetsAt <= now) return false
  return windowFor(stored, sevenDay, now).raised.length === 0
}

/** The notification's words: the reading, the threshold crossed, and when the window resets (UTC, so every machine reads the same). */
export function alertWords(alert: PlanAlert): string {
  const at = alert.thresholds[alert.thresholds.length - 1] ?? alert.percent
  const reset = alert.resetsAt === null ? '' : `, resets ${new Date(alert.resetsAt).toISOString().slice(0, 16).replace('T', ' ')}Z`
  return `7-day plan window at ${alert.percent}% (past ${at}%${reset})`
}
