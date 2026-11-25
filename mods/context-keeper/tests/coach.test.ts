import { describe, expect, test } from 'claude-code/testing'

import type { Signals } from '../hooks/coach'
import { advise, coachStep, DEFAULT_COACH, detectDrift, findLoop, FRESH_COACH, looksDone, pressure } from '../hooks/coach'

const T0 = Date.parse('2026-10-16T10:00:00')
const cfg = { ...DEFAULT_COACH, topics: { 'Shop app': ['shop', 'shop-app'], Blog: ['blog'] } }
const W = 200_000

function sig(over: Partial<Signals> = {}): Signals {
  return {
    now: T0,
    ctxTokens: 0.38 * W,
    ctxWindow: W,
    growthPerTurn: 0,
    turns: 6,
    compactions: 0,
    lastActivityAt: T0 - 2 * 60_000,
    isWorking: false,
    drift: { isDrift: false, from: 'Shop app', to: 'Shop app', why: 'still on Shop app' },
    lastAnswerDone: false,
    loop: { repeats: 0, sample: '' },
    bigOutputs: 0,
    startedAt: T0 - 3_600_000,
    hasBackup: true,
    ...over,
  }
}

const at = (pct: number) => ({ ctxTokens: (pct / 100) * W })
const switched = { isDrift: true, from: 'Shop app', to: 'Blog', why: 'you started on Shop app and the latest request is about Blog' }

describe('one recommendation per situation', () => {
  test('keep going: 38%, same task, cache warm', () => {
    const a = advise(sig(), cfg)
    expect(a.kind).toBe('keep')
    expect(a.text).toBe('Keep going · 38% context, same task (Shop app), cache warm.')
    expect(a.status.length <= 40).toBe(true)
  })

  test('compact now: 72%, task not finished', () => {
    const a = advise(sig(at(72)), cfg)
    expect(a.kind).toBe('compact')
    expect(a.text).toContain("Compact now (/compact) · 72% context, but the task isn't finished")
    expect(a.status).toBe('Coach: /compact · 72%')
  })

  test('compact soon: 60% and growing fast', () => {
    const a = advise(sig({ ...at(60), growthPerTurn: 0.1 * W }), cfg)
    expect(a.kind).toBe('compact')
    expect(a.label).toBe('Compact soon')
    expect(a.text).toContain('~3 turns')
  })

  test('new chat: 85% context and switched from shop to blog', () => {
    const a = advise(sig({ ...at(86), drift: switched }), cfg)
    expect(a.kind).toBe('new-chat')
    expect(a.text).toContain('Start a new chat · 86% context')
    expect(a.text).toContain("you've switched to Blog")
    expect(a.text).toContain('your backup is ready, the new chat loads it')
  })

  test('new chat mid-task on a topic switch at 50%', () => {
    const a = advise(sig({ ...at(50), drift: switched, lastAnswerDone: false }), cfg)
    expect(a.kind).toBe('new-chat')
    expect(a.text).toContain('switched from Shop app to Blog')
  })

  test('clear: task done, next request unrelated', () => {
    const a = advise(sig({ ...at(30), drift: switched, lastAnswerDone: true }), cfg)
    expect(a.kind).toBe('clear')
    expect(a.text).toContain('Clear (/clear) · task done, next request is unrelated (Blog)')
  })

  test('no clear on a tiny context', () => {
    expect(advise(sig({ ...at(8), drift: switched, lastAnswerDone: true }), cfg).kind).toBe('keep')
  })

  test('take a break: 5-hour window at 92%, resets 15:00', () => {
    const a = advise(sig({ fiveHour: { pct: 92, resetsAt: '2026-10-16T15:00:00' } }), cfg)
    expect(a.kind).toBe('break')
    expect(a.text).toBe('Take a break: 5-hour window at 92%, resets 15:00.')
    expect(a.status.length <= 40).toBe(true)
  })

  test('stuck in a loop: same error 3 times', () => {
    const a = advise(sig({ loop: { repeats: 3, sample: 'Bash: npm ERR! code ERESOLVE' } }), cfg)
    expect(a.kind).toBe('loop')
    expect(a.text).toBe('Stuck in a loop: same error 3 times · new chat with a fresh look.')
  })

  test('compacted twice and filling again → new chat', () => {
    expect(advise(sig({ ...at(62), compactions: 2 }), cfg).kind).toBe('new-chat')
  })

  test('5-hour window 80% with a big context → compact to stretch the plan', () => {
    const a = advise(sig({ ...at(55), fiveHour: { pct: 80 } }), cfg)
    expect(a.kind).toBe('compact')
    expect(a.label).toBe('Compact to save plan')
  })

  test('cache cold with a big context → info only', () => {
    const a = advise(sig({ ...at(55), lastActivityAt: T0 - 90 * 60_000 }), cfg)
    expect(a.kind).toBe('cold')
    expect(a.tone).toBe('info')
  })

  test('a 1M window still feels pressure past the quality budget', () => {
    expect(pressure({ ctxTokens: 400_000, ctxWindow: 1_000_000 }, cfg)).toBe(80)
    expect(advise(sig({ ctxTokens: 400_000, ctxWindow: 1_000_000 }), cfg).kind).toBe('compact')
  })

  test('the strongest rule wins and the rest are listed', () => {
    const a = advise(sig({ ...at(90), fiveHour: { pct: 95 }, loop: { repeats: 4, sample: 'x' } }), cfg)
    expect(a.kind).toBe('break')
    expect(a.also.some((t) => t.startsWith('Stuck in a loop'))).toBe(true)
    expect(a.also.some((t) => t.startsWith('Start a new chat'))).toBe(true)
  })

  test('every status fits in 40 characters', () => {
    const cases = [sig(), sig(at(72)), sig({ ...at(90), drift: switched }), sig({ fiveHour: { pct: 99, resetsAt: '2026-10-20T09:00:00' } }), sig({ loop: { repeats: 12, sample: 'x' } }), sig({ ...at(30), drift: switched, lastAnswerDone: true })]
    for (const c of cases) expect(advise(c, cfg).status.length <= 40).toBe(true)
  })
})

describe('no flapping', () => {
  test('hysteresis: compact stays at 68% once shown, clears below 65%', () => {
    const shown = coachStep(FRESH_COACH, sig(at(71)), cfg)
    expect(shown.advice.kind).toBe('compact')
    const hover = coachStep(shown.state, sig(at(68)), cfg)
    expect(hover.advice.kind).toBe('compact')
    expect(hover.toast).toBe(undefined)
    const down = coachStep(hover.state, sig(at(60)), cfg)
    expect(down.advice.kind).toBe('keep')
  })

  test('a toast only when the advice changes, never twice in the cooldown', () => {
    const a = coachStep(FRESH_COACH, sig(at(72)), cfg)
    expect(a.toast).toContain('Compact now')
    const same = coachStep(a.state, sig({ ...at(74), now: T0 + 60_000 }), cfg)
    expect(same.toast).toBe(undefined)
    const back = coachStep(same.state, sig({ ...at(30), now: T0 + 120_000 }), cfg)
    expect(back.advice.kind).toBe('keep')
    expect(back.toast).toBe(undefined) // keep never toasts
    const again = coachStep(back.state, sig({ ...at(72), now: T0 + 10 * 60_000 }), cfg)
    expect(again.advice.kind).toBe('compact')
    expect(again.toast).toBe(undefined) // within 30 min of the last compact toast
    const later = coachStep({ ...again.state, kind: 'keep' }, sig({ ...at(72), now: T0 + 45 * 60_000 }), cfg)
    expect(later.toast).toContain('Compact now')
  })

  test('cold cache and keep-going never toast (human cadence)', () => {
    const cold = coachStep(FRESH_COACH, sig({ ...at(55), lastActivityAt: T0 - 90 * 60_000 }), cfg)
    expect(cold.advice.kind).toBe('cold')
    expect(cold.toast).toBe(undefined)
  })
})

describe('signals', () => {
  test('topic drift by named topics', () => {
    const d = detectDrift({ firstPrompts: ['fix the shop checkout rounding bug'], recentPrompts: ['now update the blog archive page'], firstAreas: [], recentAreas: [], turns: 5 }, cfg.topics)
    expect(d.isDrift).toBe(true)
    expect(d.from).toBe('Shop app')
    expect(d.to).toBe('Blog')
  })

  test('no drift on a short follow-up', () => {
    const d = detectDrift({ firstPrompts: ['fix the shop checkout rounding bug'], recentPrompts: ['go ahead'], firstAreas: ['shop-app/src'], recentAreas: ['shop-app/src'], turns: 5 }, cfg.topics)
    expect(d.isDrift).toBe(false)
  })

  test('drift by folders and words needs both', () => {
    const base = { firstPrompts: ['rewrite the invoice export module with currency rounding fixes'], recentPrompts: ['design landing hero section gradients typography spacing'], turns: 6 }
    expect(detectDrift({ ...base, firstAreas: ['billing/src'], recentAreas: ['site/pages'] }, {}).isDrift).toBe(true)
    expect(detectDrift({ ...base, firstAreas: ['billing/src'], recentAreas: ['billing/src'] }, {}).isDrift).toBe(false)
  })

  test('loop: the same error 3 times among the latest calls', () => {
    const err = (n: number) => ({ tool: 'Bash', isError: true, text: `Error: Cannot find module 'x' (attempt ${n})` })
    const ok = { tool: 'Read', isError: false, text: 'fine' }
    expect(findLoop([err(1), ok, err(2), ok, err(3)]).repeats).toBe(3)
    // solved long ago: does not count
    expect(findLoop([err(1), err(2), err(3), ...Array.from({ length: 10 }, () => ok)]).repeats).toBe(0)
  })

  test('looksDone reads a finished report', () => {
    expect(looksDone('## ✅ Done\n- shipped')).toBe(true)
    expect(looksDone('All tests pass and it is deployed.')).toBe(true)
    expect(looksDone('Let me now run the build.')).toBe(false)
    expect(looksDone('')).toBe(false)
  })
})
