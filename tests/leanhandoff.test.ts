import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { LIMITS } from '../hooks/constants'
import { policySections } from '../hooks/core/policy'
import { defaultSettings, normalizeSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { resolveHandoffFile } from '../hooks/features/handoff'
import { continuationContext, freshResumePrompt } from '../hooks/features/prompts'
import { fakeHost } from './fixtures/fake-host'

// The lean handoff (1.8.2). Measured on 346 transcripts: a fresh context needed about 160k tokens before
// its first real edit (the shared notes file had grown to 855 KB, and the fresh context verified again
// what the handoff turn had just verified). Each run now keeps its own capped notes, the notes ride the
// fresh context's first message, and fresh notes are trusted as written.

const MIN = 60_000
const base = { runNumber: 7, sessionNumber: 3, handoffPath: '/work/.control-room/run-7.md', policies: [] }

describe('the notes file of a run', () => {
  test('{run} in the setting is the run number; without a placeholder the name is as set; no run reads as 0', () => {
    expect(resolveHandoffFile('.control-room/run-{run}.md', 264)).toBe('.control-room/run-264.md')
    expect(resolveHandoffFile('notes/{run}/{run}.md', 3)).toBe('notes/3/3.md')
    expect(resolveHandoffFile('NEXT_SESSION_PROMPT.md', 264)).toBe('NEXT_SESSION_PROMPT.md')
    expect(resolveHandoffFile('.control-room/run-{run}.md', null)).toBe('.control-room/run-0.md')
  })

  test('the setting keeps a {run} path through normalize, and still refuses an unsafe one', () => {
    const s = defaultSettings()
    expect(normalizeSettings({ ...s, autopilot: { ...s.autopilot, handoffFile: '.control-room/run-{run}.md' } }).autopilot.handoffFile).toBe('.control-room/run-{run}.md')
    expect(normalizeSettings({ ...s, autopilot: { ...s.autopilot, handoffFile: '../run-{run}.md' } }).autopilot.handoffFile).toBe(s.autopilot.handoffFile)
  })

  test('the policy section does not name the file, so it is the same text for every run', () => {
    const s = { ...defaultSettings(), autopilot: { ...defaultSettings().autopilot, enabled: true, handoffFile: '.control-room/run-{run}.md' } }
    const text = policySections(s, 300_000).find(p => p.name === 'Context Autopilot')?.text ?? ''
    expect(text).toContain('about 300k tokens')
    expect(text).not.toContain('{run}')
    expect(text).not.toContain('.control-room')
  })
})

describe('what the fresh context is told about its notes', () => {
  test('fresh notes that fit: the text rides the message between markers, is trusted, and is not read again', () => {
    const block = continuationContext({ ...base, notes: { text: 'NEXT: merge PR 12.\nState: gate 641/641 at abc123.\n', bytes: 52, ageMs: 2 * MIN } })
    expect(block).toContain('<handoff-notes>\nNEXT: merge PR 12.\nState: gate 641/641 at abc123.\n</handoff-notes>')
    expect(block).toContain('(/work/.control-room/run-7.md, written 2m 0s ago)')
    expect(block).toContain('do not read the file again')
    expect(block).toContain('trust that, do not check finished work again, and check only what your next step depends on')
    expect(block).not.toContain('old: before you change anything')
  })

  test('old notes (a park, a wake): included all the same, with a live check of what the next step touches', () => {
    const block = continuationContext({ ...base, cause: "for a watcher's fresh wake", notes: { text: 'NEXT: read the reply.', bytes: 21, ageMs: LIMITS.notesFreshMs + MIN } })
    expect(block).toContain('<handoff-notes>\nNEXT: read the reply.\n</handoff-notes>')
    expect(block).toContain('They are 1h 1m old: before you change anything, check the live state of what your next step touches, not the finished work.')
    expect(block).not.toContain('trust that, do not check finished work again')
  })

  test('the boundary: notes exactly at the fresh limit are still trusted', () => {
    expect(continuationContext({ ...base, notes: { text: 'x', bytes: 1, ageMs: LIMITS.notesFreshMs } })).toContain('trust that')
    expect(continuationContext({ ...base, notes: { text: 'x', bytes: 1, ageMs: LIMITS.notesFreshMs + 1 } })).toContain('old: before you change anything')
  })

  test('notes over the cap: named with their size, not included, and to be cut at the next handoff', () => {
    const block = continuationContext({ ...base, notes: { text: null, bytes: 855_000, ageMs: 3 * MIN } })
    expect(block).not.toContain('<handoff-notes>')
    expect(block).toContain('(855 KB, written 3m 0s ago): too large to include here, so read only the part your next step needs, not the whole file, and write them within 150 lines at your next handoff.')
    expect(block).toContain('trust that')
  })

  test('no notes read: the fresh context is pointed at the file, as before', () => {
    expect(continuationContext(base)).toContain('The handoff notes are in /work/.control-room/run-7.md. Read them before acting.')
    expect(continuationContext({ ...base, notes: null })).not.toContain('<handoff-notes>')
  })

  test('a fresh resume starts from the notes too, and is not told to verify the whole state', () => {
    const text = freshResumePrompt({ sessionNumber: 4, handoffPath: '/work/.control-room/run-7.md', why: 'a watcher fired.', then: 'Check the reply.' })
    expect(text).toContain('Start from the handoff notes')
    expect(text).not.toContain('verify the current state of the work')
  })
})

// ---------------------------------------------------------------------------
// The chain over a fake engine: a run whose notes file carries its number.

const NOTES = '/work/.control-room/run-1.md'

async function chain(notes: { content: string; ageMs?: number } | null) {
  const f = fakeHost({})
  const s: Settings = defaultSettings()
  s.autopilot.enabled = true
  s.autopilot.handoffFile = '.control-room/run-{run}.md'
  f.kept.store['settings.v1'] = s
  const rt = new Runtime()
  f.host.clearContext = async () => {
    f.kept.commands.push('clear')
    f.live.sessionId = 'C2'
    void rt.onClassicSessionStart({ source: 'clear', sessionId: 'C2' })
    return { text: '' }
  }
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  // A run begins with the first turn.
  rt.onPromptSubmit('Build the thing', { kind: 'composer' })
  await rt.onTurnStart({ turnId: 't1', text: 'Build the thing' })
  await rt.onStop({ stopHookActive: false, lastMessage: 'Done.', background: [], wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Done.' })
  await f.advance(10)
  expect(rt.run?.number).toBe(1)
  expect(rt.handoffFile()).toBe('.control-room/run-1.md')
  expect(rt.handoffPath()).toBe(NOTES)
  expect(await rt.requestHandoff()).toBe('Handing off: Claude is writing the handoff notes.')
  await f.advance(400)
  const prompt = f.kept.submitted.find(t => t.includes('final handoff')) ?? ''
  // The handoff turn writes the notes (or not).
  await rt.onTurnStart({ turnId: 't2', text: `The project-sentinel plugin sent a message:\n${prompt}` })
  if (notes !== null) f.live.workspace[NOTES] = { content: notes.content, mtimeMs: f.now() - (notes.ageMs ?? 0) }
  await rt.onStop({ stopHookActive: false, lastMessage: 'The handoff is written.', background: [], wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'The handoff is written.' })
  await f.advance(4000)
  return { f, rt, prompt }
}

describe('the chain with a per-run notes file', () => {
  test('the handoff prompt names the run file; the notes written there are verified, and ride the fresh context whole', async () => {
    const { f, rt, prompt } = await chain({ content: 'NEXT: open the PR.\nState: tests 12/12 at 9f3c2aa.\n' })
    expect(prompt).toContain('`.control-room/run-1.md` at the project root')
    expect(prompt).not.toContain('{run}')
    expect(f.kept.commands.filter(c => c === 'clear')).toEqual(['clear'])
    expect(f.kept.traces.filter(t => t.startsWith('autopilot: notes'))).toEqual([expect.stringContaining(`autopilot: notes ${NOTES} written (50 bytes`), `autopilot: notes ${NOTES} included (50 bytes, 1 s old)`])
    const block = rt.takeFreshContext() ?? ''
    expect(block).toContain('<handoff-notes>\nNEXT: open the PR.\nState: tests 12/12 at 9f3c2aa.\n</handoff-notes>')
    expect(block).toContain('trust that, do not check finished work again')
    // The continuation starts from the notes it was given, with no second verification.
    const continuation = f.kept.submitted.find(t => t.includes('Start from the handoff notes')) ?? ''
    expect(continuation).toContain(`read \`${NOTES}\` only if they are not there`)
    expect(continuation).not.toContain('verify the current state')
  })

  test('notes over the cap are named with their size and never put in the message', async () => {
    const big = 'line of history\n'.repeat(4000)
    const { f, rt } = await chain({ content: big })
    expect(big.length).toBeGreaterThan(LIMITS.notesInlineBytes)
    expect(f.kept.traces.some(t => t.startsWith(`autopilot: notes ${NOTES} over the cap, named only (64000 bytes`))).toBe(true)
    const block = rt.takeFreshContext() ?? ''
    expect(block).not.toContain('line of history')
    expect(block).toContain('(64 KB, written')
    expect(block).toContain('too large to include here')
  })

  test('no notes written at the run file: the handoff asks once more for that file, and the context is kept', async () => {
    const { f } = await chain(null)
    expect(f.kept.commands.filter(c => c === 'clear')).toEqual([])
    expect(f.kept.traces.some(t => t.startsWith(`autopilot: notes ${NOTES} not fresh (0 bytes`))).toBe(true)
    expect(f.kept.submitted.some(t => t.includes('`.control-room/run-1.md` at the project root') && !t.includes('final handoff'))).toBe(true)
  })
})
