import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { parkPrompt } from '../hooks/features/prompts'
import { clockAhead } from '../hooks/features/when'
import { classicSettings, type Settings } from '../hooks/core/settings'
import { fakeHost } from './fixtures/fake-host'

const H = 3_600_000
const M = 60_000
const OPUS = 'claude-opus-4-1'

type Started = ReturnType<typeof fakeHost> & { rt: Runtime }

/** A session with the plan gates on, Watchers on, healthy handoff notes, and a run started by one turn. */
async function started(patch: (s: Settings) => void = () => undefined): Promise<Started> {
  const f = fakeHost({ handoffSize: () => 4000, handoffMtime: () => Date.now() })
  const s = classicSettings()
  s.plan = { ...s.plan, gates: true }
  s.ops = { ...s.ops, watchers: true }
  patch(s)
  f.kept.store['settings.v1'] = s
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

let turns = 0

/** One main turn: its prompt (through the prompt hook, as the person's), one request, then its end. */
async function turn(f: Started, text: string, opts: { during?: () => Promise<void> | void; own?: boolean } = {}): Promise<string[]> {
  const { rt } = f
  const turnId = `t${++turns}`
  const context = opts.own === true ? [] : rt.onPromptSubmit(text, undefined, undefined)
  await rt.onTurnStart({ turnId, text })
  const e = { turnId, index: 0, model: OPUS, messageCount: 3 }
  const sent = rt.stepRequest(e)
  await opts.during?.()
  rt.stepResponse(e, sent, {
    turnId,
    index: 0,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 2_000, model: OPUS },
  })
  await rt.onStop({ stopHookActive: false, lastMessage: 'Done.', background: [], wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
  await f.advance(10)
  return context
}

/** A reading of the 7-day window, as a measurement reports it. */
const read = (f: Started, percent: number, resetsAt: number) =>
  f.rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, rateLimits: [{ kind: 'seven_day', percentUsed: percent, resetsAt: new Date(resetsAt).toISOString() }], changed: ['rateLimits'] })

const planWatchers = (f: Started) => f.rt.ops.current().watchers.filter(w => w.source === 'plan')

/** Claude Code's /clear as it answers Project Sentinel's own: a new session, its SessionStart{clear}. */
function clears(f: Started): void {
  let n = 1
  f.host.clearContext = async () => {
    f.kept.commands.push('clear')
    const id = `C${++n}`
    f.live.sessionId = id
    void f.rt.onClassicSessionStart({ source: 'clear', sessionId: id })
    return { text: '' }
  }
}

const milestones = (f: Started) => f.rt.recordMilestones({ objective: 'Ship the thing', milestones: [{ title: 'Build it', status: 'in_progress' }] }, undefined)

/** A plugin reload in the same process: the old runtime's timers cancelled, a new one takes the run on. */
async function reloaded(f: Started): Promise<Started> {
  f.rt.stopTimers()
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}
const parkPrompts = (f: Started) => f.kept.submitted.filter(t => t.startsWith('Project Sentinel · park the run ('))

describe('the plan park', () => {
  test('at parkAt with the session free: one fresh watcher at the reset, the notes asked for once, then the run sleeps', async () => {
    const f = await started()
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 30 * H
    read(f, 70, resetsAt)
    expect(planWatchers(f)).toEqual([])
    read(f, 86, resetsAt)
    const [w] = planWatchers(f)
    expect(w).toMatchObject({ status: 'armed', strategy: 'fresh', source: 'plan', wakeAt: resetsAt })
    expect(w!.label).toBe("the 7-day window's reset (plan at 86%)")
    // The notes go at the boundary, as Control Room's own prompt, naming the plan as the cause.
    await f.advance(2000)
    expect(parkPrompts(f)).toHaveLength(1)
    expect(parkPrompts(f)[0]).toContain("Control Room is parking this run until")
    expect(parkPrompts(f)[0]).toContain('the 7-day plan window\'s reset (the window is at 86%)')
    expect(parkPrompts(f)[0]).toContain('carry on after the reset')
    expect(parkPrompts(f)[0]).not.toContain('the user is parking')
    // The notes turn ends: the run is parked, and a further reading in parking or hold arms nothing more.
    await turn(f, parkPrompts(f)[0]!, { own: true })
    expect(f.rt.ops.isSleeping()).toBe(true)
    read(f, 88, resetsAt)
    read(f, 96, resetsAt)
    expect(planWatchers(f)).toHaveLength(1)
    expect(parkPrompts(f)).toHaveLength(1)
    expect(f.kept.traces.filter(t => t.startsWith('plan gates:'))).toEqual(['plan gates: normal → economy (7-day 70%)', 'plan gates: economy → parking (7-day 86%)', 'plan gates: parking → hold (7-day 96%)'])
    // Queued work waits for the wake, as behind any park.
    const q = f.rt.ops.queueAdd('next step', 'turn')
    expect(q.ok).toBe(true)
    await f.advance(2000)
    expect(f.kept.submitted.filter(t => t.startsWith('Mission Queue'))).toEqual([])
  })

  test('at parkAt mid-turn: the watcher is armed now, the notes are asked for when the turn ends', async () => {
    const f = await started()
    const resetsAt = f.now() + 30 * H
    await turn(f, 'build the thing', {
      during: async () => {
        read(f, 90, resetsAt)
        expect(planWatchers(f)).toHaveLength(1)
        await f.advance(2000)
        expect(parkPrompts(f)).toEqual([])
      },
    })
    await f.advance(2000)
    expect(parkPrompts(f)).toHaveLength(1)
    expect(planWatchers(f)[0]!.checkpoint).not.toBeNull()
  })

  test('Watchers off: no park is armed and nothing is asked; the pressure still reads, and the log says why', async () => {
    const f = await started(s => void (s.ops = { ...s.ops, watchers: false }))
    await turn(f, 'build the thing')
    read(f, 90, f.now() + 30 * H)
    expect(f.rt.planGate.pressure).toBe('parking')
    expect(planWatchers(f)).toEqual([])
    await f.advance(2000)
    expect(parkPrompts(f)).toEqual([])
    expect(f.kept.traces.some(t => t === 'plan gates: 7-day 90% calls for a park, but Watchers are off: nothing armed')).toBe(true)
  })

  test('the park survives a reload (the run keeps its watcher) and the first reading after it arms nothing more', async () => {
    const f = await started()
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 30 * H
    read(f, 88, resetsAt)
    await f.advance(2000)
    await turn(f, parkPrompts(f)[0]!, { own: true })
    f.rt.stopTimers()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const g: Started = { ...f, rt }
    read(g, 89, resetsAt)
    expect(planWatchers(g)).toHaveLength(1)
    await f.advance(2000)
    expect(parkPrompts(g)).toHaveLength(1)
  })

  test('the pressure gone before the reset (the gates turned off): the park ends and the run wakes here', async () => {
    const f = await started()
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 30 * H
    read(f, 88, resetsAt)
    await f.advance(2000)
    await turn(f, parkPrompts(f)[0]!, { own: true })
    expect(f.rt.ops.isSleeping()).toBe(true)
    f.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await f.advance(2000)
    expect(planWatchers(f)[0]!.status).not.toBe('armed')
    expect(f.rt.ops.isSleeping()).toBe(false)
    const wake = f.kept.submitted.find(t => t.startsWith('Project Sentinel watcher wake ('))
    expect(wake).toBeDefined()
  })
})

/** The park flow after a reading at or past parkAt: the notes prompt goes at the boundary and its turn runs, so the run sleeps. */
async function parked(f: Started): Promise<void> {
  await f.advance(2000)
  const prompt = parkPrompts(f).at(-1)
  if (prompt === undefined) throw new Error('no park prompt went')
  await turn(f, prompt, { own: true })
}

const clockOf = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('the plan hold', () => {
  test("queued work and a due watcher wait for the reset, not for the person; the person's prompt runs with one note per hold; the reset lifts it all", async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 20 * M
    read(f, 96, resetsAt)
    expect(f.rt.planGate.pressure).toBe('hold')
    expect(f.rt.planHold()).toEqual({ percent: 96, resetsAt })
    await parked(f)
    // The person's own prompt runs, with the note once; a second prompt carries no second note.
    const first = await turn(f, 'just answer this')
    expect(first.filter(t => t.startsWith('Project Sentinel · The 7-day plan window is at 96%'))).toHaveLength(1)
    expect(first.find(t => t.startsWith('Project Sentinel · The 7-day plan window'))).toContain("This message is the user's own and runs.")
    const second = await turn(f, 'and this')
    expect(second.filter(t => t.startsWith('Project Sentinel · The 7-day plan window'))).toEqual([])
    // A watcher of the person's, due in five minutes, and queued work: nothing of Control Room's own goes.
    const armed = f.rt.ops.armAt('the CI run', { kind: 'at', at: f.now() + 5 * M, words: '' }, 'warm')
    expect(armed.ok).toBe(true)
    f.rt.ops.queueAdd('next step', 'turn')
    const before = f.kept.submitted.length
    await f.advance(6 * M)
    expect(f.kept.submitted.length).toBe(before)
    const w = f.rt.ops.current().watchers.find(x => x.label === 'the CI run')!
    expect(w.status).toBe('due')
    expect(w.needs).toBe(`The 7-day plan window is at 96%: the wake waits for the reset at ${clockOf(resetsAt)}.`)
    expect(f.rt.ops.planHeld).toBe(`${w.id}'s wake`)
    expect(f.rt.ops.budgetHeld).toBeNull()
    expect(f.rt.ops.holdReason()?.kind).toBe('plan')
    // The reset passes with no response: the minute look lifts the hold; the held watcher is due again and wakes.
    await f.advance(15 * M)
    expect(f.rt.planGate.pressure).toBe('normal')
    expect(f.rt.ops.planHeld).toBeNull()
    expect(f.rt.ops.holdReason()).toBeNull()
    const woken = f.rt.ops.current().watchers.find(x => x.label === 'the CI run')!
    expect(woken.needs).toBeNull()
    expect(['waking', 'done']).toContain(woken.status)
    expect(f.kept.submitted.some(t => t.startsWith('Project Sentinel watcher wake ('))).toBe(true)
  })

  test('the hold reads the reset against the clock: at the reset nothing is held, even before a step is taken', async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 20 * M
    read(f, 97, resetsAt)
    expect(f.rt.planHold()).not.toBeNull()
    expect(f.rt.ops.holdReason()?.kind).toBe('plan')
    // No timer fires (the minute look is stopped): the model still says hold, yet at the reset it holds nothing.
    f.rt.stopTimers()
    await f.advance(20 * M + 500)
    expect(f.rt.planGate.pressure).toBe('hold')
    expect(f.rt.planHold()).toBeNull()
    expect(f.rt.ops.holdReason()).toBeNull()
  })

  test('the budget hold and the plan hold are told apart: the budget asks the person, the plan waits for the reset', async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    read(f, 97, f.now() + 20 * M)
    f.rt.ops.setBudget({ costUsd: 0.1, atLimit: 'ask' })
    expect(f.rt.ops.holdReason()?.kind).toBe('budget')
    expect(f.rt.ops.holdReason()?.needs).toBe('The run budget is reached: the wake waits for you.')
    f.rt.ops.setBudget(null)
    expect(f.rt.ops.holdReason()?.kind).toBe('plan')
    f.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    expect(f.rt.ops.holdReason()).toBeNull()
  })
})

describe('the plan park, hardened', () => {
  test("the person's own park prompt reads as before; the plan's names the plan", () => {
    expect(parkPrompt({ id: 'W-1', label: 'the CI run', wakeAt: Date.UTC(2026, 10, 9, 15, 0), handoffFile: 'NEXT_SESSION_PROMPT.md', planTool: null })).toBe(
      `Project Sentinel · park the run (W-1): the user is parking this run until ${clockOf(Date.UTC(2026, 10, 9, 15, 0))}, waiting for the CI run, and it will wake in a fresh context. Do not continue the work now. Before the park: update \`NEXT_SESSION_PROMPT.md\` at the project root with what the fresh context needs to check the CI run and carry on. Then end your turn with one line.`,
    )
    expect(parkPrompt({ id: 'W-1', label: 'x', wakeAt: 0, handoffFile: 'N.md', planTool: null, plan: { percent: 88 } })).toContain("Control Room is parking this run until")
  })

  test("the person's turns during a park leave the run parked where they end, each asked to keep the notes current; the wake at the reset goes fresh", async () => {
    const f = await started()
    clears(f)
    milestones(f)
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 30 * H
    read(f, 88, resetsAt)
    await parked(f)
    const w = () => planWatchers(f)[0]!
    expect(w().checkpoint?.turns).toBe(1)
    expect(w().notesAskedAt).not.toBeNull()
    const context = await turn(f, 'one more thing')
    const note = context.find(t => t.startsWith('Project Sentinel · This run is parked by the plan gates'))
    expect(context.filter(t => t.startsWith('Project Sentinel · This run is parked by the plan gates'))).toHaveLength(1)
    expect(note).toContain('If this turn changes the work or what comes next, update `NEXT_SESSION_PROMPT.md`')
    expect(note).toContain(`wakes it ${clockAhead(resetsAt, f.now())} in a fresh context`)
    expect(clockAhead(resetsAt, f.now())).not.toBe(clockOf(resetsAt))
    expect(w().checkpoint?.turns).toBe(2)
    expect(w().status).toBe('armed')
    // The reset: not stale; the fresh wake goes (/clear, then the fresh resume).
    await f.advance(30 * H + M)
    expect(w().status).toBe('done')
    expect(w().outcome).toContain('fresh')
    expect(f.kept.commands).toContain('clear')
  })

  test('a prompt typed before the notes boundary carries the ask itself: no second notes turn follows it', async () => {
    const f = await started()
    const resetsAt = f.now() + 30 * M
    await turn(f, 'build the thing', { during: () => read(f, 90, resetsAt) })
    const context = await turn(f, 'and this, right away')
    expect(context.some(t => t.startsWith('Project Sentinel · This run is parked by the plan gates'))).toBe(true)
    await f.advance(3000)
    expect(parkPrompts(f)).toEqual([])
    expect(planWatchers(f)[0]!.notesAskedAt).not.toBeNull()
  })

  test('a held watcher wakes once the hold is gone even after a reload (the hold text stands only while the hold does)', async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 20 * M
    read(f, 96, resetsAt)
    await parked(f)
    f.rt.ops.armAt('the CI run', { kind: 'at', at: f.now() + 5 * M, words: '' }, 'warm')
    await f.advance(6 * M)
    const held = () => f.rt.ops.current().watchers.find(x => x.label === 'the CI run')!
    expect(held().needs).toContain('The 7-day plan window is at 96%')
    expect(held().heldUntil).toBe(resetsAt)
    // A reload: the gate starts at normal, no step ever lifts the hold in memory. A boundary before the reset holds still.
    const g = await reloaded(f)
    expect(g.rt.planGate.pressure).toBe('normal')
    g.rt.ops.armAt('the deploy', { kind: 'at', at: g.now() + 2 * M, words: '' }, 'warm')
    await g.advance(3 * M)
    expect(held().status).toBe('due')
    expect(held().needs).toContain('The 7-day plan window is at 96%')
    expect(g.kept.submitted.filter(t => t.includes('the CI run'))).toEqual([])
    // Past the reset, with no reading of the new window yet: the tick gives the boundary and the held one wakes.
    await g.advance(12 * M)
    const w = g.rt.ops.current().watchers.find(x => x.label === 'the CI run')!
    expect(w.needs ?? '').not.toContain('The 7-day plan window')
    expect(['waking', 'done']).toContain(w.status)
    expect(g.kept.submitted.some(t => t.startsWith('Project Sentinel watcher wake (') && t.includes('the CI run'))).toBe(true)
  })

  test('a held watcher wakes at the reset after a reload even with the plan\'s own watcher gone; the gates off release it too', async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 20 * M
    read(f, 96, resetsAt)
    await parked(f)
    f.rt.ops.armAt('the CI run', { kind: 'at', at: f.now() + 5 * M, words: '' }, 'warm')
    await f.advance(6 * M)
    f.rt.ops.dismiss(planWatchers(f)[0]!.id)
    const g = await reloaded(f)
    await g.advance(16 * M)
    const w = g.rt.ops.current().watchers.find(x => x.label === 'the CI run')!
    expect(['waking', 'done']).toContain(w.status)
    // The gates off after a reload: a held watcher is released at the next boundary.
    const h = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(h, 'build the thing')
    read(h, 96, h.now() + 20 * M)
    await parked(h)
    h.rt.ops.armAt('the build', { kind: 'at', at: h.now() + 2 * M, words: '' }, 'warm')
    await h.advance(3 * M)
    expect(h.rt.ops.current().watchers.find(x => x.label === 'the build')!.needs).toContain('The 7-day plan window')
    const i = await reloaded(h)
    i.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await i.advance(3000)
    expect(['waking', 'done']).toContain(i.rt.ops.current().watchers.find(x => x.label === 'the build')!.status)
  })

  test('the gates off after a reload end the park: the run wakes here', async () => {
    const f = await started()
    await turn(f, 'build the thing')
    read(f, 88, f.now() + 30 * H)
    await parked(f)
    const g = await reloaded(f)
    expect(g.rt.ops.isSleeping()).toBe(true)
    g.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await g.advance(3000)
    expect(g.rt.ops.isSleeping()).toBe(false)
    expect(g.kept.submitted.some(t => t.startsWith('Project Sentinel watcher wake (') && t.includes('by the plan gates'))).toBe(true)
    const context = await turn(g, 'next')
    expect(context.some(t => t.startsWith('Project Sentinel · This run is parked'))).toBe(false)
  })

  test("an earlier window's park, overdue after Claude Code was closed through the reset, ends when the next window calls for one; a notes ask past the park's time is dropped", async () => {
    const f = await started()
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 30 * M
    read(f, 88, resetsAt)
    await parked(f)
    f.rt.stopTimers()
    await f.advance(3 * H)
    const g = await reloaded(f)
    const old = planWatchers(g)[0]!
    expect(old.status).toBe('due')
    read(g, 86, resetsAt + 7 * 24 * H)
    await g.advance(3000)
    expect(planWatchers(g).find(w => w.id === old.id)!.status).toBe('dismissed')
    const fresh = planWatchers(g).find(w => w.id !== old.id)!
    expect(fresh.status).toBe('armed')
    expect(fresh.wakeAt).toBe(resetsAt + 7 * 24 * H)
    expect(parkPrompts(g)).toHaveLength(2)
    // A dropped ask and no boundary until the reset: the wake goes, never a late park prompt.
    const h = await started()
    await turn(h, 'build the thing')
    h.live.submitDrop = 'busy'
    read(h, 90, h.now() + 5 * M)
    await h.advance(3000)
    h.live.submitDrop = null
    await h.advance(6 * M)
    // The fake records the dropped prompt too: one attempt, no second past the reset.
    expect(parkPrompts(h)).toHaveLength(1)
    expect(planWatchers(h)[0]!.status).not.toBe('armed')
  })

  test("Continue anyway under a budget hold frees the watchers the budget held; a plan hold still holds them in the plan's words", async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    f.rt.ops.setBudget({ costUsd: 0.1, atLimit: 'ask' })
    f.rt.ops.armAt('the deploy', { kind: 'at', at: f.now() + 2 * M, words: '' }, 'warm')
    await f.advance(3 * M)
    const w = () => f.rt.ops.current().watchers.find(x => x.label === 'the deploy')!
    expect(w().needs).toBe('The run budget is reached: the wake waits for you.')
    f.rt.ops.approveBudget()
    await f.advance(3000)
    expect(w().needs ?? '').not.toContain('run budget')
    expect(['waking', 'done']).toContain(w().status)
    // Both holds: Continue anyway leaves the plan's hold, in its words.
    const g = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(g, 'build the thing')
    g.rt.ops.setBudget({ costUsd: 0.1, atLimit: 'ask' })
    read(g, 97, g.now() + 20 * M)
    await parked(g)
    g.rt.ops.armAt('the deploy', { kind: 'at', at: g.now() + 2 * M, words: '' }, 'warm')
    await g.advance(3 * M)
    const v = () => g.rt.ops.current().watchers.find(x => x.label === 'the deploy')!
    expect(v().needs).toBe('The run budget is reached: the wake waits for you.')
    g.rt.ops.approveBudget()
    await g.advance(3000)
    expect(v().needs).toContain('The 7-day plan window is at 97%')
    expect(v().status).toBe('due')
    expect(g.kept.submitted.filter(t => t.includes('the deploy'))).toEqual([])
  })

  test('the gates off while the notes turn runs: the park is not stale, the run wakes here in the plan\'s words after that turn', async () => {
    const f = await started()
    await turn(f, 'build the thing')
    read(f, 88, f.now() + 30 * M)
    await f.advance(2000)
    const prompt = parkPrompts(f)[0]!
    await turn(f, prompt, {
      own: true,
      during: () => void f.rt.update(s => void (s.plan = { ...s.plan, gates: false })),
    })
    await f.advance(3000)
    const w = planWatchers(f)[0]!
    expect(w.status).not.toBe('stale')
    const wake = f.kept.submitted.find(t => t.startsWith('Project Sentinel watcher wake ('))
    expect(wake).toContain('by the plan gates')
    expect(wake).toContain('The 7-day pressure is gone, so continue the work')
    expect(wake).not.toContain('If it is not ready yet')
    expect(parkPrompts(f)).toHaveLength(1)
  })

  test('the gates off before the notes went: the park that never began is dismissed, nothing wakes', async () => {
    const f = await started()
    const resetsAt = f.now() + 30 * M
    await turn(f, 'build the thing', { during: () => read(f, 90, resetsAt) })
    // The watcher is armed; the notes wait for the boundary; the gates go off first.
    f.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await f.advance(3000)
    expect(planWatchers(f)[0]!.status).toBe('dismissed')
    expect(planWatchers(f)[0]!.outcome).toBe("The plan's park ended before it began")
    expect(parkPrompts(f)).toEqual([])
    expect(f.kept.submitted.filter(t => t.startsWith('Project Sentinel watcher wake ('))).toEqual([])
  })

  test('a reload that lost the ask for the notes: the next reading asks again; a prompt Claude Code did not take is asked once more and logged', async () => {
    const f = await started()
    const resetsAt = f.now() + 30 * M
    await turn(f, 'build the thing', { during: () => read(f, 90, resetsAt) })
    // Reload before the boundary: the ask lived in memory only.
    f.rt.stopTimers()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const g: Started = { ...f, rt }
    expect(parkPrompts(g)).toEqual([])
    read(g, 91, resetsAt)
    await f.advance(3000)
    expect(parkPrompts(g)).toHaveLength(1)
    expect(planWatchers(g)).toHaveLength(1)
    // Dropped: once more at the next boundary, then the log says it.
    const h = await started()
    await turn(h, 'build the thing')
    h.live.submitDrop = 'busy'
    read(h, 90, h.now() + 30 * M)
    await h.advance(3000)
    expect(h.rt.ops.current().log.some(l => l.text.includes('the notes could not be asked for (busy)'))).toBe(true)
    // The next boundary (an item queued) retries once; still dropped, the log says so and no third attempt follows.
    h.rt.ops.queueAdd('later', 'turn')
    await h.advance(3000)
    expect(parkPrompts(h)).toHaveLength(2)
    expect(h.rt.ops.current().log.some(l => l.text.includes('the notes were not asked for twice'))).toBe(true)
    h.rt.ops.queueAdd('later still', 'turn')
    await h.advance(3000)
    expect(parkPrompts(h)).toHaveLength(2)
    h.live.submitDrop = null
    await turn(h, 'again')
    await h.advance(3000)
    expect(parkPrompts(h)).toHaveLength(2)
  })

  test('Watchers turned on while the pressure already calls for a park: the park is armed then', async () => {
    const f = await started(s => void (s.ops = { ...s.ops, watchers: false }))
    await turn(f, 'build the thing')
    read(f, 97, f.now() + 30 * M)
    expect(planWatchers(f)).toEqual([])
    f.rt.update(s => void (s.ops = { ...s.ops, watchers: true }))
    expect(planWatchers(f)).toHaveLength(1)
    await f.advance(3000)
    expect(parkPrompts(f)).toHaveLength(1)
  })

  test("a held watcher whose hold ended while Claude Code was closed waits for the person, as the plan's own overdue park does", async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 20 * M
    read(f, 96, resetsAt)
    await parked(f)
    f.rt.ops.armAt('the CI run', { kind: 'at', at: f.now() + 5 * M, words: '' }, 'warm')
    await f.advance(6 * M)
    expect(f.rt.ops.current().watchers.find(x => x.label === 'the CI run')!.heldUntil).toBe(resetsAt)
    // Claude Code closed through the reset: three hours pass with no timer.
    f.rt.stopTimers()
    await f.advance(3 * H)
    const g = await reloaded(f)
    const w = () => g.rt.ops.current().watchers.find(x => x.label === 'the CI run')!
    expect(w().status).toBe('due')
    expect(w().heldUntil).toBeNull()
    expect(w().needs).toBe("Watcher was due 2 hours ago, when the plan's hold ended.")
    expect(planWatchers(g)[0]!.status).toBe('due')
    expect(planWatchers(g)[0]!.needs).toBe('Watcher was due 2 hours ago.')
    expect(g.kept.traces.some(t => t.includes("'s hold ended 2 hours ago (Claude Code was not running): it waits for you"))).toBe(true)
    // Neither wakes by itself; the person wakes the held one.
    await g.advance(5 * M)
    expect(g.kept.submitted.filter(t => t.startsWith('Project Sentinel watcher wake ('))).toEqual([])
    expect(w().status).toBe('due')
    await g.rt.ops.wakeNow(w().id)
    await g.advance(3000)
    expect(['waking', 'done']).toContain(w().status)
    expect(g.kept.submitted.some(t => t.startsWith('Project Sentinel watcher wake (') && t.includes('the CI run'))).toBe(true)
  })

  test("the gates off after a reload with the plan's own watcher gone: a held watcher is released on a boundary of its own", async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    read(f, 96, f.now() + 20 * M)
    await parked(f)
    f.rt.ops.armAt('the build', { kind: 'at', at: f.now() + 2 * M, words: '' }, 'warm')
    await f.advance(3 * M)
    f.rt.ops.dismiss(planWatchers(f)[0]!.id)
    const g = await reloaded(f)
    const w = () => g.rt.ops.current().watchers.find(x => x.label === 'the build')!
    expect(w().needs).toContain('The 7-day plan window is at 96%')
    g.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await g.advance(3000)
    expect(w().needs ?? '').not.toContain('The 7-day plan window')
    expect(['waking', 'done']).toContain(w().status)
    expect(g.kept.submitted.some(t => t.startsWith('Project Sentinel watcher wake (') && t.includes('the build'))).toBe(true)
  })

  test('a held watcher paused and resumed waits for the person: past the reset the tick runs no boundary for it', async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 20 * M
    read(f, 96, resetsAt)
    await parked(f)
    f.rt.ops.dismiss(planWatchers(f)[0]!.id)
    f.rt.ops.armAt('the CI run', { kind: 'at', at: f.now() + 5 * M, words: '' }, 'warm')
    await f.advance(6 * M)
    const w = () => f.rt.ops.current().watchers.find(x => x.label === 'the CI run')!
    expect(w().heldUntil).toBe(resetsAt)
    f.rt.ops.pause(w().id)
    f.rt.ops.resume(w().id)
    expect(w().status).toBe('due')
    expect(w().needs).toBe('Watcher was due 1 minute ago while paused.')
    expect(w().heldUntil).toBe(resetsAt)
    // The reset passes and the hold lifts; from then on the tick gives this watcher no boundary: it waits for the person.
    await f.advance(16 * M)
    expect(f.rt.planGate.pressure).toBe('normal')
    const boundaries: number[] = []
    const atBoundary = f.rt.ops.atBoundary.bind(f.rt.ops)
    f.rt.ops.atBoundary = () => {
      boundaries.push(f.now())
      atBoundary()
    }
    await f.advance(10 * M)
    expect(boundaries).toEqual([])
    expect(w().status).toBe('due')
    expect(w().needs).toBe('Watcher was due 1 minute ago while paused.')
    expect(f.kept.submitted.filter(t => t.startsWith('Project Sentinel watcher wake ('))).toEqual([])
  })

  test('the gates off after a reload that lost the ask for the notes: the park that never began is dismissed, not woken', async () => {
    const f = await started()
    await turn(f, 'build the thing', { during: () => read(f, 90, f.now() + 30 * M) })
    const g = await reloaded(f)
    expect(parkPrompts(g)).toEqual([])
    expect(planWatchers(g)[0]!.notesAskedAt).toBeNull()
    g.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await g.advance(3000)
    expect(planWatchers(g)[0]!.status).toBe('dismissed')
    expect(planWatchers(g)[0]!.outcome).toBe("The plan's park ended before it began")
    expect(g.kept.submitted.filter(t => t.startsWith('Project Sentinel watcher wake ('))).toEqual([])
  })

  test("an earlier window's park overdue in-process (its wake waited for the person) ends in the same words", async () => {
    const f = await started()
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 30 * M
    read(f, 88, resetsAt)
    await parked(f)
    // The person's own turn after the park with the notes untouched: at the reset the wake finds the run changed and waits.
    f.rt.ops.pause(planWatchers(f)[0]!.id)
    await f.advance(31 * M)
    f.rt.ops.resume(planWatchers(f)[0]!.id)
    const old = planWatchers(f)[0]!
    expect(old.status).toBe('due')
    read(f, 86, resetsAt + 7 * 24 * H)
    await f.advance(3000)
    const ended = planWatchers(f).find(w => w.id === old.id)!
    expect(ended.status).toBe('dismissed')
    expect(ended.outcome).toBe('Its 7-day window reset before it woke; a new park follows')
    expect(f.rt.ops.current().log.some(l => l.text === `${old.id} dismissed: its window reset before it woke`)).toBe(true)
    expect(planWatchers(f).find(w => w.id !== old.id)!.status).toBe('armed')
  })

  test("a plan park carried into the next run keeps its notes' ask: the first reading there asks for none", async () => {
    const f = await started()
    await turn(f, 'build the thing')
    const resetsAt = f.now() + 30 * M
    read(f, 88, resetsAt)
    await parked(f)
    const askedAt = planWatchers(f)[0]!.notesAskedAt
    expect(askedAt).not.toBeNull()
    await f.rt.onSessionEnd({ reason: 'prompt_input_exit' } as never)
    // A new session in the same project: a new run, offered the ended run's park.
    const fresh = new Runtime()
    const h = fakeHost({ handoffSize: () => 4000, handoffMtime: () => Date.now() })
    h.kept.store = f.kept.store
    h.live.sessionId = 'S9'
    await h.advance(f.now() - h.now())
    fresh.bind(h.host)
    await fresh.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await h.advance(200)
    const g: Started = { ...h, rt: fresh }
    expect(fresh.ops.foreign).toMatchObject({ watchers: 1 })
    await fresh.ops.bringForeign()
    const carried = planWatchers(g)[0]!
    expect(carried).toMatchObject({ source: 'plan', status: 'armed', notesAskedAt: askedAt })
    read(g, 89, resetsAt)
    await g.advance(3000)
    expect(parkPrompts(g)).toEqual([])
    expect(planWatchers(g)).toHaveLength(1)
  })

  test('the gates off while the notes prompt is on its way (submitted, not yet taken): the park stands and wakes here after the notes turn', async () => {
    const f = await started()
    await turn(f, 'build the thing')
    read(f, 88, f.now() + 30 * M)
    // The notes prompt's submit is held: Claude Code has it, nothing answered yet.
    const submit = f.host.submit
    let release: (() => void) | null = null
    f.host.submit = async text => {
      await new Promise<void>(r => {
        release = r
      })
      return submit(text)
    }
    await f.advance(2000)
    expect(release).not.toBeNull()
    const w = () => planWatchers(f)[0]!
    expect(w().notesAskedAt).toBeNull()
    f.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await f.advance(500)
    expect(w().status).not.toBe('dismissed')
    release!()
    await f.advance(10)
    f.host.submit = submit
    expect(w().notesAskedAt).not.toBeNull()
    // The notes turn runs on the prompt Claude Code took; then the run wakes here in the plan's words.
    await turn(f, parkPrompts(f)[0]!, { own: true })
    await f.advance(3000)
    expect(['waking', 'done']).toContain(w().status)
    expect(f.kept.submitted.some(t => t.startsWith('Project Sentinel watcher wake (') && t.includes('by the plan gates'))).toBe(true)
    expect(parkPrompts(f)).toHaveLength(1)
    // The same ask, dropped by Claude Code once released: the park never began and is dismissed, nothing wakes.
    const g = await started()
    await turn(g, 'build the thing')
    read(g, 88, g.now() + 30 * M)
    const submitG = g.host.submit
    let releaseG: (() => void) | null = null
    g.host.submit = async text => {
      await new Promise<void>(r => {
        releaseG = r
      })
      return submitG(text)
    }
    await g.advance(2000)
    g.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await g.advance(500)
    expect(planWatchers(g)[0]!.status).toBe('armed')
    g.live.submitDrop = 'busy'
    releaseG!()
    await g.advance(3000)
    expect(planWatchers(g)[0]!.status).toBe('dismissed')
    expect(planWatchers(g)[0]!.outcome).toBe("The plan's park ended before it began")
    expect(g.kept.submitted.filter(t => t.startsWith('Project Sentinel watcher wake ('))).toEqual([])
    // The pressure back before the ask was answered: the park stands, nothing is decided when the ask lands.
    const h = await started()
    await turn(h, 'build the thing')
    const resetsAt = h.now() + 30 * M
    read(h, 88, resetsAt)
    const submitH = h.host.submit
    let releaseH: (() => void) | null = null
    h.host.submit = async text => {
      await new Promise<void>(r => {
        releaseH = r
      })
      return submitH(text)
    }
    await h.advance(2000)
    h.rt.update(s => void (s.plan = { ...s.plan, gates: false }))
    await h.advance(500)
    h.rt.update(s => void (s.plan = { ...s.plan, gates: true }))
    await h.advance(500)
    releaseH!()
    await h.advance(10)
    h.host.submit = submitH
    await turn(h, parkPrompts(h)[0]!, { own: true })
    await h.advance(3000)
    expect(planWatchers(h)).toHaveLength(1)
    expect(planWatchers(h)[0]!.status).toBe('armed')
    expect(h.kept.submitted.filter(t => t.startsWith('Project Sentinel watcher wake ('))).toEqual([])
  })

  test('the gates off in the stored settings at load: a held watcher is released on a boundary of its own', async () => {
    const f = await started(s => void (s.plan = { ...s.plan, parkAt: 95, holdAt: 95 }))
    await turn(f, 'build the thing')
    read(f, 96, f.now() + 20 * M)
    await parked(f)
    f.rt.ops.armAt('the build', { kind: 'at', at: f.now() + 2 * M, words: '' }, 'warm')
    await f.advance(3 * M)
    expect(f.rt.ops.current().watchers.find(x => x.label === 'the build')!.needs).toContain('The 7-day plan window')
    const s = f.kept.store['settings.v1'] as Settings
    f.kept.store['settings.v1'] = { ...s, plan: { ...s.plan, gates: false } }
    const g = await reloaded(f)
    await g.advance(3000)
    const w = g.rt.ops.current().watchers.find(x => x.label === 'the build')!
    expect(w.needs ?? '').not.toContain('The 7-day plan window')
    expect(['waking', 'done']).toContain(w.status)
    expect(g.kept.submitted.some(t => t.startsWith('Project Sentinel watcher wake (') && t.includes('the build'))).toBe(true)
  })

  test("the person's own park prompt names the day of a wake past today; with the gates off from the start no park note rides their prompts", async () => {
    const f = await started()
    await turn(f, 'build the thing')
    const wakeAt = f.now() + 30 * H
    const armed = f.rt.ops.armAt('the CI run', { kind: 'at', at: wakeAt, words: '' }, 'fresh')
    expect(armed.ok).toBe(true)
    await f.rt.ops.prepareNotes(armed.ok ? armed.id : '')
    const prompt = parkPrompts(f).at(-1)!
    expect(prompt).toContain(`the user is parking this run until ${clockAhead(wakeAt, f.now())}, waiting for the CI run`)
    expect(clockAhead(wakeAt, f.now())).not.toBe(clockOf(wakeAt))
    // A park from before, the gates off in the stored settings at load: the watcher stands, the prompt carries no plan note.
    const g = await started()
    await turn(g, 'build the thing')
    read(g, 88, g.now() + 30 * M)
    await parked(g)
    const s = g.kept.store['settings.v1'] as Settings
    g.kept.store['settings.v1'] = { ...s, plan: { ...s.plan, gates: false } }
    const i = await reloaded(g)
    expect(planWatchers(i)[0]!.status).toBe('armed')
    const context = await turn(i, 'next')
    expect(context.filter(t => t.startsWith('Project Sentinel · This run is parked'))).toEqual([])
  })
})
