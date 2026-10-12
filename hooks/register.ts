// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by Santiago Boxiga, 2026: the handoff threshold, its warning and
// the /handoff command.
//
// Token Weather: a live forecast of the context window, above the prompt.
//
// turn.complete: after each main-loop turn, read the context window's fill
// from $.session.usage() (the same figures the status line shows) and keep
// the last HISTORY readings.
// session.start: take a first reading, so the band shows before any turn.
// ui.render (AbovePrompt): one line: icon, forecast word, percent, tokens
// used of the window, and a block-character chart of the recent turns.
//
// Handoff: past the threshold the person set (/handoff at 60% or 200k, kept
// across sessions) the band says so and a toast fires once per conversation.
// /handoff asks a fork of the cached conversation for a handoff note, runs
// /clear, and puts the note in the fresh conversation's prompt box.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

const HISTORY = 12
const BARS = '▁▂▃▄▅▆▇█'

// Forecast bands, by percent of the window used.
const FORECAST = [
  // Single-width text symbols, not emoji: they line up in every terminal font.
  { upTo: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { upTo: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { upTo: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: 'red' },
] as const

const KEY_THRESHOLD = 'threshold'
const DEFAULT_THRESHOLD = '60%'

const HANDOFF_PROMPT = `Write a handoff note for a fresh session that has none of this conversation. It will be that session's first message, so it must stand on its own.

Cover, in this order:
- Goal: what we are trying to achieve and why.
- State: what is done and verified, what is half-done; name files, branches, commands.
- Decisions: what was decided and the reason, so it is not reopened.
- Dead ends: what was tried and failed, so it is not retried.
- Open questions, if any.
- Next step: the exact next action.

Be specific and brief, under 400 words. Plain markdown, addressed to the next session, no preamble.`

export type Threshold = { kind: 'percent'; value: number } | { kind: 'tokens'; value: number } | { kind: 'off' }
type Reading = { tokens: number; window: number; percent: number }

// Readings, oldest first.
let readings: Reading[] = []
let threshold: Threshold = parseThreshold(DEFAULT_THRESHOLD)!
// The warning fires once per conversation.
let warned = false
// The note /handoff wrote, waiting for the conversation after /clear.
let pending: string | undefined

/** "60" or "60%" is a percent of the window; "200k", "1.5m" or a count of 1000 up is tokens. */
export function parseThreshold(text: string): Threshold | undefined {
  const t = text.trim().toLowerCase()
  if (t === 'off') return { kind: 'off' }
  const m = /^(\d+(?:\.\d+)?)\s*(%|k|m)?$/.exec(t)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2]
  if (unit === '%' || (!unit && n < 1000)) {
    return n >= 1 && n <= 99 ? { kind: 'percent', value: n } : undefined
  }
  const tokens = Math.round(unit === 'k' ? n * 1_000 : unit === 'm' ? n * 1_000_000 : n)
  return tokens >= 1000 ? { kind: 'tokens', value: tokens } : undefined
}

export function isPast(t: Threshold, r: { tokens: number; percent: number }): boolean {
  if (t.kind === 'percent') return r.percent >= t.value
  if (t.kind === 'tokens') return r.tokens >= t.value
  return false
}

function thresholdText(t: Threshold): string {
  if (t.kind === 'percent') return `${t.value}%`
  if (t.kind === 'tokens') return short(t.value)
  return 'off'
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    readings = []
    warned = false
    const saved = await $.store.get(KEY_THRESHOLD)
    threshold = (typeof saved === 'string' && parseThreshold(saved)) || parseThreshold(DEFAULT_THRESHOLD)!
    await $.command.register({
      name: 'handoff',
      description: 'Hand off to a fresh conversation with a note; "at 60%" or "at 200k" sets when token-weather warns, "at off" stops it',
      argumentHint: '[at 60% | at 200k | at off | status]',
    })
    await takeReading($)
    return result
  })

  // /clear starts a new conversation in the same process; session.start does not fire for it.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'clear') return result
    readings = []
    warned = false
    await takeReading($)
    if (pending) {
      const note = pending
      pending = undefined
      await deliver($, note)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      return result
    }
    await takeReading($)
    return result
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (words[0] === 'at') return { text: await setThreshold($, words.slice(1).join(' ')) }
    if (words[0] === 'status') return { text: statusText() }
    if (words.length > 0) return { text: `Unknown option "${words.join(' ')}". Use /handoff, /handoff at <60% | 200k | off>, or /handoff status.` }
    return { text: await handoff($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.hasSurvey || readings.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    return renderBand(Box, Text, e.bodyColumns ?? 80)
  })
}

async function takeReading($: $) {
  try {
    const { context } = await $.session.usage()
    if (!context || !context.window) {
      return
    }
    const tokens = context.tokens ?? 0
    const percent = Math.round(context.percent ?? (tokens / context.window) * 100)
    // The session.start reading is 0 before any response; drop it once real readings arrive.
    readings = readings.filter((r) => r.tokens > 0)
    readings.push({ tokens, window: context.window, percent })
    if (readings.length > HISTORY) {
      readings = readings.slice(-HISTORY)
    }
    // Compacting can bring the window back under the line; crossing it again warns again.
    if (!isPast(threshold, { tokens, percent })) warned = false
    else if (!warned) {
      warned = true
      $.ui.toast(`Context at ${percent}% (${short(tokens)}), past your ${thresholdText(threshold)} handoff point. Run /handoff to carry on in a fresh conversation.`)
      void $.prompt.suggest({ text: '/handoff' })
    }
    $.ui.invalidate('ui.render')
  } catch {
    // No reading this turn; the band keeps the last one.
  }
}

async function setThreshold($: $, text: string) {
  const t = parseThreshold(text)
  if (!t) return `"${text}" is not a threshold. Use a percent of the window (60%), a token count (200k), or off. Still ${thresholdText(threshold)}.`
  threshold = t
  await $.store.set(KEY_THRESHOLD, thresholdText(t))
  const now = readings[readings.length - 1]
  warned = now ? isPast(t, now) : false
  $.ui.invalidate('ui.render')
  return t.kind === 'off' ? 'Handoff warning off.' : `token-weather will suggest /handoff from ${thresholdText(t)} of context, in every session.`
}

function statusText() {
  const now = readings[readings.length - 1]
  const fill = now ? `${now.percent}% (${short(now.tokens)} / ${short(now.window)})` : 'no reading yet'
  return `Handoff at ${thresholdText(threshold)}. Context now ${fill}.`
}

async function handoff($: $) {
  // The fork replays the conversation as last sent, so its prefix is read from the prompt cache.
  const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `api-error ${reply.status ?? ''}`.trim() : reply.reason
    return `Could not write the handoff note (${why}). Nothing was cleared.`
  }
  pending = reply.text.trim()
  // A command.run hook cannot run another command while it holds the turn; a timer runs it after.
  $.clock.after(0, () => clearForHandoff($))
  return `Handoff note written (${reply.text.trim().split(/\s+/).length} words). Starting a fresh conversation; the note will be in the prompt box, ready to send or edit.`
}

async function clearForHandoff($: $) {
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (err) {
    $.ui.toast(`token-weather: /clear did not run (${String(err)}). Run /clear yourself and the handoff note will be put in the prompt box.`)
  }
}

async function deliver($: $, note: string) {
  const text = `Continuing from an earlier session. Its handoff note:\n\n${note}`
  try {
    const filled = await $.prompt.fill({ text })
    if (!filled.isFilled) await $.prompt.submit({ text })
  } catch (err) {
    $.ui.toast(`token-weather: could not hand the note to the new conversation (${String(err)}).`)
  }
}

type El = (props: Record<string, unknown>) => unknown

function renderBand(Box: El, Text: El, columns: number) {
  const now = readings[readings.length - 1]
  const f = forecastFor(now.percent)
  const past = isPast(threshold, now)
  const trend = trendWord()
  const parts = [
    past
      ? Text({ color: 'red', bold: true, children: '↪  Time to hand off' })
      : Text({ color: f.color, bold: true, children: `${f.icon}  ${f.word}` }),
    Text({ children: `  ${now.percent}% of context` }),
    Text({ dimColor: true, children: `  ${short(now.tokens)} / ${short(now.window)}` }),
  ]
  if (columns >= 60) {
    parts.push(Text({ dimColor: true, children: '   last turns ' }))
    parts.push(Text({ color: f.color, children: chart() }))
    if (trend) {
      parts.push(Text({ dimColor: true, children: `  ${trend}` }))
    }
  }
  if (past) parts.push(Text({ color: 'red', children: '   /handoff' }))
  else if (threshold.kind !== 'off' && columns >= 80) parts.push(Text({ dimColor: true, children: `   handoff at ${thresholdText(threshold)}` }))
  return Box({ flexDirection: 'row', paddingX: 1, children: parts })
}

function forecastFor(percent: number) {
  return FORECAST.find((band) => percent < band.upTo) ?? FORECAST[FORECAST.length - 1]
}

// Bars scale to the busiest reading shown, so growth shows at any fill level.
function chart() {
  const top = Math.max(...readings.map((r) => r.tokens), 1)
  const bars = readings.map((r) => BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))])
  return bars.join('')
}

function trendWord() {
  if (readings.length < 2) {
    return ''
  }
  const delta = readings[readings.length - 1].tokens - readings[readings.length - 2].tokens
  if (delta > 0) return `▲ +${short(delta)} last turn`
  if (delta < 0) return `▼ ${short(-delta)} last turn`
  return 'steady'
}

function short(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}
