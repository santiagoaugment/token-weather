import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, RenderPropsOf, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { isPast, parseThreshold } from '../hooks/register'

tier('user')

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const run = (command: string, args = ''): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 },
})

let turns = 0
const turn = (): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
})

const band: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

// The world beneath the mod: a context window whose fill the test sets, and
// a record of what the mod asked the engine for.
function world(on: On, opts: { store?: Record<string, unknown>; fork?: ModelForkResult; clearFails?: boolean; below?: string } = {}) {
  mock.store(on, opts.store ?? {})
  const live = { tokens: 0, window: 200_000 }
  const seen = { toasts: [] as string[], suggested: [] as string[], filled: [] as string[], cleared: 0, forks: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: live.window, tokens: live.tokens, percent: (live.tokens / live.window) * 100 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', { command: 'clear' }, () => {
    if (opts.clearFails) throw new Error('busy')
    seen.cleared++
    return {}
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  // The engine beneath draws nothing above the prompt unless a test puts another plugin's band there.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => opts.below === undefined ? $.ui.resolve(e).Box({ children: [] }) : $.ui.resolve(e).Text({ children: [opts.below] }))
  on('turn.complete', ($, e) => ({ text: 'answer' in e ? e.answer : '' }))
  on('ui.toast', ($, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('prompt.suggest', ($, e) => { seen.suggested.push(e.text); return { isShown: true } })
  on('prompt.fill', ($, e) => { seen.filled.push(e.text); return { isFilled: true } })
  on('model.fork', ($, e) => {
    seen.forks.push(e.prompt)
    return { value: opts.fork ?? { isAnswered: true, text: 'GOAL: ship it. NEXT: run the tests.', usage: { input_tokens: 1, output_tokens: 200, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 } } }
  })
  return { live, seen }
}

describe('parseThreshold', () => {
  test('reads a percent, a token count or off', async () => {
    expect(parseThreshold('60')).toEqual({ kind: 'percent', value: 60 })
    expect(parseThreshold('45%')).toEqual({ kind: 'percent', value: 45 })
    expect(parseThreshold('200k')).toEqual({ kind: 'tokens', value: 200_000 })
    expect(parseThreshold('1.5M')).toEqual({ kind: 'tokens', value: 1_500_000 })
    expect(parseThreshold('150000')).toEqual({ kind: 'tokens', value: 150_000 })
    expect(parseThreshold('off')).toEqual({ kind: 'off' })
  })

  test('refuses what is not a threshold', async () => {
    for (const bad of ['', '0', '0%', '100%', '150', 'soon', '-5', '10x']) expect(parseThreshold(bad)).toBe(undefined)
  })

  test('isPast compares the matching unit', async () => {
    expect(isPast({ kind: 'percent', value: 60 }, { tokens: 130_000, percent: 65 })).toBe(true)
    expect(isPast({ kind: 'percent', value: 60 }, { tokens: 110_000, percent: 55 })).toBe(false)
    expect(isPast({ kind: 'tokens', value: 100_000 }, { tokens: 120_000, percent: 12 })).toBe(true)
    expect(isPast({ kind: 'off' }, { tokens: 999_000, percent: 99 })).toBe(false)
  })
})

describe('handoff threshold', () => {
  test('defaults to 60% and warns once when the window crosses it', async ($, on) => {
    const { live, seen } = world(on)
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'AbovePrompt', props: band })
    live.tokens = 100_000
    await $.turn.complete(turn())
    expect(seen.toasts).toEqual([])
    expect((await ui.find({ type: 'Text', text: /handoff at 60%/ }))).toBeDefined()
    live.tokens = 130_000
    await $.turn.complete(turn())
    live.tokens = 140_000
    await $.turn.complete(turn())
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/65%.*60%.*\/handoff/)
    expect(seen.suggested).toEqual(['/handoff'])
    expect(await ui.find({ type: 'Text', text: /Time to hand off/ })).toBeDefined()
  })

  test('/handoff at sets a token threshold that later sessions keep', async ($, on) => {
    const store: Record<string, unknown> = {}
    const { live, seen } = world(on, { store })
    await $.session.start(session)
    expect((await $.command.run(run('handoff', 'at 100k'))).text).toMatch(/100k/)
    live.tokens = 90_000
    await $.turn.complete(turn())
    expect(seen.toasts).toEqual([])
    await $.session.start(session)
    expect((await $.command.run(run('handoff', 'status'))).text).toMatch(/100k/)
    live.tokens = 120_000
    await $.turn.complete(turn())
    expect(seen.toasts.length).toBe(1)
  })

  test('/handoff at off stops the warning, and a bad value changes nothing', async ($, on) => {
    const { live, seen } = world(on)
    await $.session.start(session)
    expect((await $.command.run(run('handoff', 'at soon'))).text).toMatch(/60%/)
    await $.command.run(run('handoff', 'at off'))
    live.tokens = 190_000
    await $.turn.complete(turn())
    expect(seen.toasts).toEqual([])
  })
})

describe('/handoff', () => {
  test('writes a note from the cached conversation, clears, and puts it in the new prompt box', async ($, on) => {
    const clock = mock.clock(on)
    const { live, seen } = world(on)
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'AbovePrompt', props: band })
    live.tokens = 150_000
    await $.turn.complete(turn())
    const out = await $.command.run(run('handoff'))
    expect(seen.forks.length).toBe(1)
    expect(out.text).toMatch(/fresh conversation/)
    // The /clear waits until the command has answered.
    expect(seen.cleared).toBe(0)
    await clock.advance(1000)
    expect(seen.cleared).toBe(1)
    expect(seen.filled.length).toBe(1)
    expect(seen.filled[0]).toMatch(/GOAL: ship it\. NEXT: run the tests\./)
    // The fresh conversation starts the band over, though usage still reports the last response.
    expect(await ui.find({ type: 'Text', text: /^\s*0% of context/ })).toBeDefined()
    // A later /clear does not bring the same note back.
    await $.session.end({ reason: 'clear', sessionId: 'S2', resume: { id: 'S2' } })
    await clock.advance(1000)
    expect(seen.filled.length).toBe(1)
  })

  test('when its own /clear is refused, a /clear the person runs delivers the note', async ($, on) => {
    const clock = mock.clock(on)
    const { seen } = world(on, { clearFails: true })
    await $.session.start(session)
    await $.command.run(run('handoff'))
    await clock.advance(1000)
    expect(seen.toasts.some(t => /Run \/clear yourself/.test(t))).toBe(true)
    expect(seen.filled).toEqual([])
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    await clock.advance(1000)
    expect(seen.filled.length).toBe(1)
  })

  test('a failed note leaves the conversation alone', async ($, on) => {
    const { seen } = world(on, { fork: { isAnswered: false, reason: 'nothing-to-fork' } })
    await $.session.start(session)
    const out = await $.command.run(run('handoff'))
    expect(out.text).toMatch(/nothing-to-fork/)
    expect(seen.cleared).toBe(0)
  })

  test('the warning fires again in the conversation after a handoff', async ($, on) => {
    const clock = mock.clock(on)
    const { live, seen } = world(on)
    await $.session.start(session)
    live.tokens = 130_000
    await $.turn.complete(turn())
    await $.command.run(run('handoff'))
    await clock.advance(1000)
    live.tokens = 125_000
    await $.turn.complete(turn())
    expect(seen.toasts.length).toBe(2)
  })
})

describe('band', () => {
  test('stacks above the band of a plugin beneath it', async ($, on) => {
    const { live } = world(on, { below: 'cache-tax · warm' })
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'AbovePrompt', props: band })
    live.tokens = 20_000
    await $.turn.complete(turn())
    expect(await ui.find({ type: 'Text', text: /10% of context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cache-tax · warm' })).toBeDefined()
  })

  test('drops the chart before it wraps on a narrow terminal', async ($, on) => {
    const { live } = world(on)
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns: 60 } })
    live.tokens = 150_000
    await $.turn.complete(turn())
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    expect(text).toMatch(/\/handoff/)
    expect(text.length).toBeLessThanOrEqual(58)
  })
})
