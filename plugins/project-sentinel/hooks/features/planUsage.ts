/**
 * The plan's five-hour usage window, as Claude Code reports it.
 *
 * On a claude.ai plan each API response carries the account's rate-limit windows, and Claude Code
 * hands them on: `$.session.usage().rateLimits`, and `session.measure`'s `rateLimits` (its `changed`
 * names 'rateLimits' when a window moves a whole point, appears or leaves). Each window has a
 * `kind` ('five_hour', 'seven_day', a Claude gateway's 'spend_limit'), `percentUsed` (0 to 100, at
 * most one decimal) and `resetsAt` (ISO 8601). Seen live on Claude Code 2.1.296: the list is empty
 * before the first response of a session, then reads five_hour 47% (resets 04:20Z) and seven_day
 * 17%; it carries across /clear; off a subscription (an API key) it stays empty.
 *
 * Nothing here estimates. The percentage is the engine's latest reading and the countdown is the
 * window's own reset time against the clock. Once that time has passed, the old reading says
 * nothing about the new window: it reads "reset" with no number until a response brings the new
 * window's figure (a window that drops out of the list at its reset reads the same). A request
 * Claude Code ended on the rate limit (StopFailure `rate_limit`), or a window read at 100%, reads
 * "limit reached" until a turn is answered again, a reading under 100% comes, or the window resets.
 *
 * Pure: the Runtime feeds it readings and draws its view.
 */

/** One window as Claude Code reads it (SessionRateLimit, Claude Code 2.1.289 and later). */
export type RateLimitReading = { kind: string; percentUsed: number; resetsAt?: string }

/** A window's latest reading: how much is used, when it resets (ms; null when the engine gave no time), when it was read. */
export type WindowReading = { percent: number; resetsAt: number | null; readAt: number }

export type LimitWindow = 'five_hour' | 'seven_day'

export type PlanUsage = {
  fiveHour: WindowReading | null
  sevenDay: WindowReading | null
  /**
   * A turn was answered and the list still held no five-hour window: an API key, or a plan
   * without one. False until then (the list is empty before the first response too).
   */
  isAbsent: boolean
  /** Claude Code ended a request on the rate limit: when, and the window read as full then (null: none was). */
  limited: { at: number; window: LimitWindow | null } | null
}

export const emptyPlanUsage = (): PlanUsage => ({ fiveHour: null, sevenDay: null, isAbsent: false, limited: null })

/** From this share of the window used, the reading asks for a look (amber); at 100% the limit is reached (red). */
export const WARN_PERCENT = 80

const percentOf = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.round(n * 10) / 10) : 0)

function timeOf(iso: string | undefined): number | null {
  if (iso === undefined) return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : null
}

const readingOf = (r: RateLimitReading | undefined, now: number): WindowReading | null =>
  r === undefined ? null : { percent: percentOf(r.percentUsed), resetsAt: timeOf(r.resetsAt), readAt: now }

/** Two readings that say the same (a refresh of an unchanged window): the state is kept as it is. */
const isSame = (a: WindowReading | null, b: WindowReading | null): boolean =>
  a === b || (a !== null && b !== null && a.percent === b.percent && a.resetsAt === b.resetsAt)

/**
 * The windows Claude Code reports now. A window missing from the list keeps its last reading (it
 * lapses at its own reset time, in the view). `isAfterAnswer`: read right after a turn was answered,
 * so an API response has come back and an empty list means no five-hour window on this account.
 */
export function readWindows(state: PlanUsage, rateLimits: readonly RateLimitReading[], now: number, isAfterAnswer = false): PlanUsage {
  const five = readingOf(rateLimits.find(r => r.kind === 'five_hour'), now)
  const seven = readingOf(rateLimits.find(r => r.kind === 'seven_day'), now)
  const fiveHour = five === null ? state.fiveHour : isSame(state.fiveHour, five) ? state.fiveHour : five
  const sevenDay = seven === null ? state.sevenDay : isSame(state.sevenDay, seven) ? state.sevenDay : seven
  const isAbsent = five !== null ? false : isAfterAnswer && state.fiveHour === null ? true : state.isAbsent
  // A fresh reading under 100% of the window that was full: the limit has lifted.
  let limited = state.limited
  if (limited !== null && limited.window !== null) {
    const fresh = limited.window === 'five_hour' ? five : seven
    if (fresh !== null && fresh.percent < 100 && now > limited.at) limited = null
  }
  if (fiveHour === state.fiveHour && sevenDay === state.sevenDay && isAbsent === state.isAbsent && limited === state.limited) return state
  return { fiveHour, sevenDay, isAbsent, limited }
}

/** Claude Code ended a request on the rate limit (StopFailure `rate_limit`). */
export function noteRateLimited(state: PlanUsage, now: number): PlanUsage {
  const window: LimitWindow | null = (state.fiveHour?.percent ?? 0) >= 100 ? 'five_hour' : (state.sevenDay?.percent ?? 0) >= 100 ? 'seven_day' : null
  return { ...state, limited: { at: now, window } }
}

/** A turn of the main conversation was answered: whatever limit stopped a request before has lifted. */
export function noteAnswered(state: PlanUsage): PlanUsage {
  return state.limited === null ? state : { ...state, limited: null }
}

export type PlanUsageView =
  /** No reading yet: before the session's first API response. */
  | { kind: 'pending' }
  /** Responses came back with no five-hour window: an API key, or a plan without one. */
  | { kind: 'absent' }
  | { kind: 'reading'; percent: number; resetsAt: number | null; leftMs: number | null; isHigh: boolean }
  /** The window's reset time has passed: a new window, with no reading of it until the next response. */
  | { kind: 'reset'; at: number }
  /** The limit is reached: a request was refused for it, or the window reads 100%. */
  | { kind: 'limited'; window: LimitWindow | null; percent: number | null; resetsAt: number | null; leftMs: number | null }

const isPast = (w: WindowReading | null, now: number): boolean => w !== null && w.resetsAt !== null && now >= w.resetsAt

const leftOf = (w: WindowReading | null, now: number): number | null => (w === null || w.resetsAt === null ? null : Math.max(0, w.resetsAt - now))

/** The five-hour window at `now` (system time: `resetsAt` is wall-clock). */
export function planUsageView(state: PlanUsage, now: number): PlanUsageView {
  const five = state.fiveHour
  const limited = state.limited
  if (limited !== null) {
    const full = limited.window === 'seven_day' ? state.sevenDay : limited.window === 'five_hour' ? five : null
    // A known full window that has since reset no longer holds the limit; an unknown one holds until a turn is answered.
    if (!isPast(full, now)) {
      const shown = limited.window === 'seven_day' ? state.sevenDay : isPast(five, now) ? null : five
      return { kind: 'limited', window: limited.window, percent: shown?.percent ?? null, resetsAt: full?.resetsAt ?? null, leftMs: leftOf(full, now) }
    }
  }
  if (five === null) return state.isAbsent ? { kind: 'absent' } : { kind: 'pending' }
  if (isPast(five, now)) return { kind: 'reset', at: five.resetsAt ?? now }
  if (five.percent >= 100) return { kind: 'limited', window: 'five_hour', percent: five.percent, resetsAt: five.resetsAt, leftMs: leftOf(five, now) }
  return { kind: 'reading', percent: five.percent, resetsAt: five.resetsAt, leftMs: leftOf(five, now), isHigh: five.percent >= WARN_PERCENT }
}

/** Whether a countdown or a reset is still ahead, so a minute tick has something to redraw. */
export const isTicking = (state: PlanUsage, now: number): boolean => {
  const v = planUsageView(state, now)
  return v.kind === 'reading' || (v.kind === 'limited' && v.leftMs !== null)
}

// ---------------------------------------------------------------------------
// The readings over time (`plan.rate`): how fast a window moves, and when it would be full.

/** One reading kept: when it was read, and the window's percent then. */
export type Sample = { at: number; percent: number }

/** A window's kept readings, all of one window: `resetsAt` names it, so a reset starts the ring afresh. */
export type WindowSamples = { resetsAt: number | null; points: Sample[] }

export type PlanSamples = { fiveHour: WindowSamples; sevenDay: WindowSamples }

export const emptySamples = (): PlanSamples => ({ fiveHour: { resetsAt: null, points: [] }, sevenDay: { resetsAt: null, points: [] } })

/** At most this many readings per window: one per five minutes over a day. */
export const SAMPLE_LIMIT = 288

/** A reading that moved within this long of the last kept one replaces it, so the ring holds at most one per five minutes. */
const SAMPLE_GAP_MS = 5 * 60_000

/** The pace is read over the readings of this span. */
export const TREND_SPAN_MS = 6 * 3_600_000

/** Below this span between the first and last reading used, no pace is shown: too little to say. */
const TREND_MIN_SPAN_MS = 10 * 60_000

/** A last reading older than this says nothing about now (the session idle, other sessions burning): no pace. */
export const TREND_STALE_MS = 15 * 60_000

const isSampleRecord = (v: unknown): v is Sample =>
  typeof v === 'object' && v !== null && typeof (v as Sample).at === 'number' && typeof (v as Sample).percent === 'number'

const windowSamplesOf = (v: unknown): WindowSamples => {
  const r = typeof v === 'object' && v !== null ? (v as { resetsAt?: unknown; points?: unknown }) : {}
  const resetsAt = typeof r.resetsAt === 'number' ? r.resetsAt : null
  const points = Array.isArray(r.points) ? r.points.filter(isSampleRecord).slice(-SAMPLE_LIMIT) : []
  return { resetsAt, points }
}

/** The samples as the store kept them; anything foreign or corrupt reads as none. */
export function samplesOf(raw: unknown): PlanSamples {
  const r = typeof raw === 'object' && raw !== null ? (raw as { fiveHour?: unknown; sevenDay?: unknown }) : {}
  return { fiveHour: windowSamplesOf(r.fiveHour), sevenDay: windowSamplesOf(r.sevenDay) }
}

function noteWindow(kept: WindowSamples, w: WindowReading | null, now: number): WindowSamples {
  if (w === null || isPast(w, now)) return kept
  const last = kept.points[kept.points.length - 1]
  // Usage never falls inside one window: a lower percent, like another reset time, is a new window and starts afresh.
  const isNewWindow = kept.resetsAt !== w.resetsAt || (last !== undefined && w.percent < last.percent)
  const ring = isNewWindow ? { resetsAt: w.resetsAt, points: [] } : kept
  const kept2 = ring.points[ring.points.length - 1]
  if (kept2 !== undefined && (kept2.percent === w.percent || now <= kept2.at)) return ring
  // A move within five minutes of the last kept reading replaces it: at most one reading per five minutes.
  const base = kept2 !== undefined && now - kept2.at < SAMPLE_GAP_MS ? ring.points.slice(0, -1) : ring.points
  const points = [...base, { at: now, percent: w.percent }].slice(-SAMPLE_LIMIT)
  return { resetsAt: w.resetsAt, points }
}

/** The windows' current readings, kept where they moved. Returns `samples` itself when nothing was kept. */
export function noteSamples(samples: PlanSamples, state: PlanUsage, now: number): PlanSamples {
  const fiveHour = noteWindow(samples.fiveHour, state.fiveHour, now)
  const sevenDay = noteWindow(samples.sevenDay, state.sevenDay, now)
  return fiveHour === samples.fiveHour && sevenDay === samples.sevenDay ? samples : { fiveHour, sevenDay }
}

/** A window's pace: percent per hour over its recent readings, and when it reaches 100% at that pace. */
export type Trend = { perHour: number; fullInMs: number | null }

/**
 * The pace over the readings of the last `TREND_SPAN_MS`, from the oldest of them to the newest,
 * while the newest is fresh (`TREND_STALE_MS`). Null below two readings or ten minutes between
 * them. `fullInMs` counts from `now` (the last reading's time is taken off), and is null when the
 * window is full already, when the pace is not upward, or when `leftMs` says the window resets
 * first. The pace shown is rounded to a tenth; the time to full is read from the pace as measured.
 */
export function trendOf(kept: WindowSamples, now: number, leftMs: number | null): Trend | null {
  const recent = kept.points.filter(p => p.at >= now - TREND_SPAN_MS && p.at <= now)
  if (recent.length < 2) return null
  const first = recent[0]!
  const last = recent[recent.length - 1]!
  if (now - last.at > TREND_STALE_MS) return null
  const spanMs = last.at - first.at
  if (spanMs < TREND_MIN_SPAN_MS) return null
  const rate = (last.percent - first.percent) / (spanMs / 3_600_000)
  const perHour = Math.round(rate * 10) / 10
  if (rate <= 0 || last.percent >= 100) return { perHour, fullInMs: null }
  const fullInMs = Math.round(((100 - last.percent) / rate) * 3_600_000 - (now - last.at))
  if (fullInMs <= 0) return { perHour, fullInMs: null }
  return { perHour, fullInMs: leftMs !== null && fullInMs >= leftMs ? null : fullInMs }
}

/** One window for the detail views (Context → Run): its name, its reading, its reset, and with samples its pace. */
export type WindowRow = { key: LimitWindow; name: string; percent: number | null; resetsAt: number | null; leftMs: number | null; isReset: boolean; trend: Trend | null }

export function windowRows(state: PlanUsage, now: number, samples: PlanSamples | null = null): WindowRow[] {
  const rows: WindowRow[] = []
  const add = (key: LimitWindow, name: string, w: WindowReading | null, kept: WindowSamples | null) => {
    if (w === null) return
    const isReset = isPast(w, now)
    const leftMs = isReset ? null : leftOf(w, now)
    const trend = isReset || kept === null ? null : trendOf(kept, now, leftMs)
    rows.push({ key, name, percent: isReset ? null : w.percent, resetsAt: w.resetsAt, leftMs, isReset, trend })
  }
  add('five_hour', '5-hour', state.fiveHour, samples?.fiveHour ?? null)
  add('seven_day', '7-day', state.sevenDay, samples?.sevenDay ?? null)
  return rows
}
