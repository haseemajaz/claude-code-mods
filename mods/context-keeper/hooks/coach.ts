// The coach: one recommendation at a time, from the chat's real signals.
// Pure: `advise` and `coachStep` take plain data, so every rule is tested.

import { clip, jaccard, keywords, resetText, tokens } from './text'

export type AdviceKind = 'keep' | 'compact' | 'new-chat' | 'clear' | 'break' | 'loop' | 'cold'
export type Tone = 'ok' | 'warn' | 'bad' | 'info'

export type CoachConfig = {
  /** % of the context window (or of the quality budget) where compacting pays off */
  compactPct: number
  /** % where a fresh chat (with the backup) beats compacting again */
  newChatPct: number
  /** a topic switch at or above this % → new chat / clear */
  driftNewChatPct: number
  /** below this % a clear is not worth suggesting even on a topic switch */
  clearMinPct: number
  /** once advice is up, it stays until the figure drops this far below its threshold */
  hysteresisPct: number
  /** compact early when the growth per turn reaches newChatPct within this many turns */
  growthLookaheadTurns: number
  /** past this many compactions in one chat, a new chat keeps quality up */
  maxCompactions: number
  /** tokens past which long-context quality drops even on a 1M window */
  qualityBudgetTokens: number
  /** 5-hour plan window: take a break at this % */
  fiveHourBreakPct: number
  /** 5-hour window at this % with a big context → compact to stretch it */
  fiveHourSqueezePct: number
  /** weekly window warning */
  weekWarnPct: number
  /** the same error this many times → stuck in a loop */
  loopRepeats: number
  /** cache window on a subscription, in minutes */
  cacheTtlMin: number
  /** a cold cache matters when context pressure is at least this % */
  coldBigPct: number
  /** advice kinds that may raise a toast when the advice changes to them */
  toastOn: AdviceKind[]
  /** the same kind is never toasted twice within this many minutes */
  toastCooldownMin: number
  /** named topics: label → words that identify it (empty by default) */
  topics: Record<string, string[]>
}

export const DEFAULT_COACH: CoachConfig = {
  compactPct: 70,
  newChatPct: 85,
  driftNewChatPct: 45,
  clearMinPct: 15,
  hysteresisPct: 5,
  growthLookaheadTurns: 3,
  maxCompactions: 2,
  qualityBudgetTokens: 500_000,
  fiveHourBreakPct: 90,
  fiveHourSqueezePct: 75,
  weekWarnPct: 90,
  loopRepeats: 3,
  cacheTtlMin: 60,
  coldBigPct: 50,
  toastOn: ['compact', 'new-chat', 'clear', 'loop', 'break'],
  toastCooldownMin: 30,
  topics: {},
}

export type LimitWindow = { pct: number; resetsAt?: string }

export type Drift = {
  isDrift: boolean
  /** the chat's topic, from its first prompts and folders */
  from?: string
  /** what the latest prompts and folders are about */
  to?: string
  why: string
}

export type Signals = {
  now: number
  ctxTokens: number
  ctxWindow: number
  /** tokens added per turn lately (0 when shrinking or unknown) */
  growthPerTurn: number
  turns: number
  compactions: number
  /** last request that touched the prompt cache; 0 = none yet */
  lastActivityAt: number
  isWorking: boolean
  fiveHour?: LimitWindow
  sevenDay?: LimitWindow
  drift: Drift
  /** the last answer reads as a finished task */
  lastAnswerDone: boolean
  /** the most repeated recent error, and how often */
  loop: { repeats: number; sample: string }
  bigOutputs: number
  startedAt: number
  /** this chat's own capsule exists */
  hasBackup: boolean
  /** the title of the previous chat's capsule this chat was given, if any */
  loadedBackup?: string
}

export type Advice = {
  kind: AdviceKind
  tone: Tone
  /** the badge: "Keep going", "Compact now" */
  label: string
  /** the one-line recommendation with its reason */
  text: string
  /** why, in numbers */
  reason: string
  /** ≤ 40 characters for the status line */
  status: string
  /** the other rules that fired, weaker than this one */
  also: string[]
}

/** Context pressure: % of the window, or of the quality budget on a huge window, whichever is higher. */
export function pressure(sig: Pick<Signals, 'ctxTokens' | 'ctxWindow'>, cfg: CoachConfig): number {
  const t = Math.max(0, sig.ctxTokens || 0)
  const ofWindow = sig.ctxWindow > 0 ? (100 * t) / sig.ctxWindow : 0
  const ofBudget = cfg.qualityBudgetTokens > 0 ? (100 * t) / cfg.qualityBudgetTokens : 0
  return Math.round(Math.max(ofWindow, ofBudget))
}

export function windowPct(sig: Pick<Signals, 'ctxTokens' | 'ctxWindow'>): number {
  return sig.ctxWindow > 0 ? Math.round((100 * Math.max(0, sig.ctxTokens || 0)) / sig.ctxWindow) : 0
}

export function cacheState(sig: Pick<Signals, 'now' | 'lastActivityAt' | 'isWorking'>, cfg: CoachConfig): { kind: 'none' | 'warm' | 'cold'; idleMin: number } {
  if (!sig.lastActivityAt) return { kind: 'none', idleMin: 0 }
  const idleMin = Math.max(0, Math.round((sig.now - sig.lastActivityAt) / 60_000))
  if (sig.isWorking) return { kind: 'warm', idleMin: 0 }
  return { kind: idleMin >= cfg.cacheTtlMin ? 'cold' : 'warm', idleMin }
}

function status(text: string): string {
  return clip(text, 40)
}

type Candidate = Omit<Advice, 'also'>

/**
 * Every rule, strongest first. `sticky` is the advice already showing: its own
 * rule fires at a threshold lowered by `hysteresisPct`, so a figure hovering
 * at the line does not flip the advice back and forth.
 */
export function candidates(sig: Signals, cfg: CoachConfig, sticky?: AdviceKind): Candidate[] {
  const out: Candidate[] = []
  const h = (kind: AdviceKind) => (sticky === kind ? cfg.hysteresisPct : 0)
  const p = pressure(sig, cfg)
  const w = windowPct(sig)
  const ctxText = w === p ? `${p}% context` : `${tokens(sig.ctxTokens)} tokens (${w}% of the window)`
  const cache = cacheState(sig, cfg)
  const backup = sig.hasBackup ? 'your backup is ready, the new chat loads it' : 'type /backup first, the new chat loads it'
  const five = sig.fiveHour
  const week = sig.sevenDay

  // 1. plan limits: the 5-hour window nearly spent
  if (five && five.pct >= cfg.fiveHourBreakPct - h('break')) {
    const at = resetText(sig.now, five.resetsAt)
    out.push({
      kind: 'break',
      tone: 'bad',
      label: 'Take a break',
      text: `Take a break: 5-hour window at ${Math.round(five.pct)}%${at ? `, resets ${at}` : ''}.`,
      reason: `Your 5-hour plan window is ${Math.round(five.pct)}% used${at ? ` and resets at ${at}` : ''}. Heavy turns now may hit the limit mid-task.`,
      status: status(`Coach: break · 5h ${Math.round(five.pct)}%${at ? ' → ' + at : ''}`),
    })
  }

  // 2. the same error again and again
  if (sig.loop.repeats >= cfg.loopRepeats) {
    out.push({
      kind: 'loop',
      tone: 'bad',
      label: 'Stuck in a loop',
      text: `Stuck in a loop: same error ${sig.loop.repeats} times · new chat with a fresh look.`,
      reason: `The same failure came back ${sig.loop.repeats} times ("${clip(sig.loop.sample, 90)}"). A fresh chat with the backup sees it without the failed attempts in the way.`,
      status: status(`Coach: loop ×${sig.loop.repeats} · new chat`),
    })
  }

  // 3. context nearly full
  if (p >= cfg.newChatPct - h('new-chat')) {
    out.push({
      kind: 'new-chat',
      tone: 'bad',
      label: 'Start a new chat',
      text: `Start a new chat · ${ctxText}${sig.drift.isDrift && sig.drift.to ? ` and you've switched to ${sig.drift.to}` : ''}; ${backup}.`,
      reason: `Context pressure is ${p}% (new-chat line ${cfg.newChatPct}%). Past this, answers get slower and less sharp, and an automatic compaction may drop detail.`,
      status: status(`Coach: new chat · ${p}%`),
    })
  }

  // 4. task done and the next request is about something else
  if (sig.drift.isDrift && sig.lastAnswerDone && p >= cfg.clearMinPct && p < cfg.newChatPct) {
    out.push({
      kind: 'clear',
      tone: 'warn',
      label: 'Clear',
      text: `Clear (/clear) · task done, next request is unrelated${sig.drift.to ? ` (${sig.drift.to})` : ''}; the backup loads in.`,
      reason: `The last answer finished the task and the new request is about ${sig.drift.to ?? 'something else'} (${sig.drift.why}). Carrying ${tokens(sig.ctxTokens)} tokens of ${sig.drift.from ?? 'the old task'} slows every turn.`,
      status: status(`Coach: /clear · new topic`),
    })
  }

  // 5. topic switched mid-task, with a fair amount of context
  if (sig.drift.isDrift && !sig.lastAnswerDone && p >= cfg.driftNewChatPct - h('new-chat')) {
    out.push({
      kind: 'new-chat',
      tone: 'warn',
      label: 'Start a new chat',
      text: `Start a new chat · ${ctxText} and you've switched${sig.drift.from ? ` from ${sig.drift.from}` : ''}${sig.drift.to ? ` to ${sig.drift.to}` : ''}; ${backup}.`,
      reason: `${sig.drift.why}. A new chat for the new topic keeps this one resumable for the unfinished work.`,
      status: status(`Coach: new chat · topic switch`),
    })
  }

  // 6. compacted too often already
  if (sig.compactions >= cfg.maxCompactions && p >= cfg.compactPct - 10 - h('new-chat')) {
    out.push({
      kind: 'new-chat',
      tone: 'warn',
      label: 'Start a new chat',
      text: `Start a new chat · compacted ${sig.compactions} times and back at ${p}%; ${backup}.`,
      reason: `Each compaction summarises the summary; after ${sig.compactions} the early decisions are blurry. The backup capsule keeps them word for word.`,
      status: status(`Coach: new chat · ${sig.compactions} compacts`),
    })
  }

  // 7. compact: past the line, or racing towards it
  const turnsLeft = sig.growthPerTurn > 0 && sig.ctxWindow > 0 ? (cfg.newChatPct - p) / ((100 * sig.growthPerTurn) / Math.min(sig.ctxWindow, cfg.qualityBudgetTokens || sig.ctxWindow)) : Infinity
  if (p >= cfg.compactPct - h('compact')) {
    out.push({
      kind: 'compact',
      tone: 'warn',
      label: 'Compact now',
      text: `Compact now (/compact) · ${ctxText}, but the task isn't finished; a compact keeps the thread.`,
      reason: `Context pressure is ${p}% (compact line ${cfg.compactPct}%, new-chat line ${cfg.newChatPct}%). Same task, so compacting keeps the working thread; the backup is refreshed first.`,
      status: status(`Coach: /compact · ${p}%`),
    })
  } else if (p >= cfg.compactPct - 15 && turnsLeft <= cfg.growthLookaheadTurns) {
    out.push({
      kind: 'compact',
      tone: 'warn',
      label: 'Compact soon',
      text: `Compact soon (/compact) · ${p}% and growing ${tokens(sig.growthPerTurn)} per turn; ${cfg.newChatPct}% in ~${Math.max(1, Math.ceil(turnsLeft))} turns.`,
      reason: `Each turn adds about ${tokens(sig.growthPerTurn)} tokens. At that pace the chat reaches ${cfg.newChatPct}% in about ${Math.max(1, Math.ceil(turnsLeft))} turns.`,
      status: status(`Coach: /compact soon · ${p}%`),
    })
  }

  // 8. the 5-hour window is getting spent fast by a big context
  if (five && five.pct >= cfg.fiveHourSqueezePct && p >= 50 && five.pct < cfg.fiveHourBreakPct) {
    const at = resetText(sig.now, five.resetsAt)
    out.push({
      kind: 'compact',
      tone: 'warn',
      label: 'Compact to save plan',
      text: `Compact (/compact) to stretch your plan · 5-hour window ${Math.round(five.pct)}%, every turn re-reads ${tokens(sig.ctxTokens)}.`,
      reason: `Every turn re-reads the whole context (${tokens(sig.ctxTokens)} tokens) against your 5-hour window, now ${Math.round(five.pct)}%${at ? ` (resets ${at})` : ''}. A smaller context makes the rest of the window last longer.`,
      status: status(`Coach: /compact · 5h ${Math.round(five.pct)}%`),
    })
  }

  // 9. idle long enough that the cache went cold, with a big context
  if (cache.kind === 'cold' && p >= cfg.coldBigPct) {
    out.push({
      kind: 'cold',
      tone: 'info',
      label: 'Cache cold',
      text: `Cache cold (idle ${cache.idleMin} min) · the next message re-reads ${tokens(sig.ctxTokens)}; compact or start fresh first if the task changed.`,
      reason: `The prompt cache lasts about ${cfg.cacheTtlMin} min on your plan; it went cold ${cache.idleMin - cfg.cacheTtlMin} min ago. The next send re-reads ${tokens(sig.ctxTokens)} tokens at full weight on your plan window.`,
      status: status(`Coach: cache cold · ${p}%`),
    })
  }

  // 10. the weekly window
  if (week && week.pct >= cfg.weekWarnPct) {
    const at = resetText(sig.now, week.resetsAt)
    out.push({
      kind: 'break',
      tone: 'warn',
      label: 'Weekly limit close',
      text: `Weekly limit at ${Math.round(week.pct)}%${at ? `, resets ${at}` : ''} · keep chats small and save big builds.`,
      reason: `Your 7-day plan window is ${Math.round(week.pct)}% used${at ? ` and resets ${at}` : ''}.`,
      status: status(`Coach: week ${Math.round(week.pct)}%${at ? ' → ' + at : ''}`),
    })
  }

  return out
}

export function keepGoing(sig: Signals, cfg: CoachConfig): Candidate {
  const p = pressure(sig, cfg)
  const cache = cacheState(sig, cfg)
  const parts = [`${p}% context`]
  parts.push(sig.drift.isDrift ? `new topic (${sig.drift.to ?? 'changed'}) but a small context` : sig.drift.from ? `same task (${sig.drift.from})` : 'same task')
  if (cache.kind === 'warm') parts.push('cache warm')
  else if (cache.kind === 'cold') parts.push('cache cold but small')
  const fresh = sig.turns === 0
  return {
    kind: 'keep',
    tone: 'ok',
    label: 'Keep going',
    text: fresh ? `Keep going · fresh chat${sig.loadedBackup ? `, backup of "${clip(sig.loadedBackup, 50)}" loaded` : ''}.` : `Keep going · ${parts.join(', ')}.`,
    reason: fresh
      ? sig.loadedBackup
        ? "This chat started with the previous chat's capsule in its context. /restore lists other backups."
        : 'Nothing to manage yet.'
      : `Context pressure ${p}% is under the compact line (${cfg.compactPct}%), no topic switch, no repeated errors, plan windows fine.`,
    status: status(fresh && sig.loadedBackup ? 'Coach: backup loaded · fresh chat' : `Coach: keep going · ${p}%`),
  }
}

/** The one recommendation, plus what else fired (for /coach). */
export function advise(sig: Signals, cfg: CoachConfig, sticky?: AdviceKind): Advice {
  const list = candidates(sig, cfg, sticky)
  const first = list[0]
  if (!first) return { ...keepGoing(sig, cfg), also: [] }
  const seen = new Set<string>([first.text])
  const also = list.slice(1).filter((c) => !seen.has(c.text) && seen.add(c.text)).map((c) => c.text)
  return { ...first, also }
}

export type CoachState = {
  kind: AdviceKind
  /** when each kind was last toasted */
  toastedAt: Partial<Record<AdviceKind, number>>
}

export const FRESH_COACH: CoachState = { kind: 'keep', toastedAt: {} }

/**
 * One step: the advice now, and a toast only when the advice CHANGED to a
 * kind that toasts and that kind was not toasted within the cooldown.
 */
export function coachStep(prev: CoachState, sig: Signals, cfg: CoachConfig): { advice: Advice; toast?: string; state: CoachState } {
  const advice = advise(sig, cfg, prev.kind)
  const state: CoachState = { kind: advice.kind, toastedAt: { ...prev.toastedAt } }
  if (advice.kind === prev.kind) return { advice, state }
  if (!cfg.toastOn.includes(advice.kind)) return { advice, state }
  const last = prev.toastedAt[advice.kind] ?? -Infinity
  if (sig.now - last < cfg.toastCooldownMin * 60_000) return { advice, state }
  state.toastedAt[advice.kind] = sig.now
  return { advice, toast: `Coach: ${advice.text}`, state }
}

// ---------------------------------------------------------------- topic drift

function topicOf(text: string, topics: Record<string, string[]>): string | undefined {
  const s = ' ' + String(text ?? '').toLowerCase() + ' '
  let best: string | undefined
  let bestHits = 0
  for (const [label, words] of Object.entries(topics)) {
    let hits = 0
    for (const w of words) {
      const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'g')
      hits += (s.match(re) ?? []).length
    }
    if (hits > bestHits) {
      best = label
      bestHits = hits
    }
  }
  return best
}

export type DriftInput = {
  /** the chat's first prompts (up to 3) */
  firstPrompts: string[]
  /** the newest prompt(s) */
  recentPrompts: string[]
  /** folders touched in the chat's first turns */
  firstAreas: string[]
  /** folders touched in the latest turns */
  recentAreas: string[]
  /** how many prompts the chat has */
  turns: number
}

/**
 * A cheap topic-switch test. Never on keywords alone:
 *  - a named topic (from the settings) in the first prompts and a different one now, or
 *  - the folders touched lately share nothing with the first ones AND the words barely overlap.
 */
export function detectDrift(d: DriftInput, topics: Record<string, string[]>): Drift {
  const firstText = d.firstPrompts.join('\n') + '\n' + d.firstAreas.join(' ')
  if (d.turns < 2 || d.firstPrompts.length === 0 || d.recentPrompts.length === 0) {
    const early = topicOf(firstText, topics)
    return early ? { isDrift: false, from: early, to: early, why: `on ${early}` } : { isDrift: false, why: 'too early to tell' }
  }
  const recentText = d.recentPrompts.join('\n') + '\n' + d.recentAreas.join(' ')
  const from = topicOf(firstText, topics)
  const to = topicOf(d.recentPrompts.join('\n'), topics) ?? topicOf(recentText, topics)
  if (from && to && from !== to) return { isDrift: true, from, to, why: `you started on ${from} and the latest request is about ${to}` }
  const areasDisjoint = d.firstAreas.length > 0 && d.recentAreas.length > 0 && !d.recentAreas.some((a) => d.firstAreas.includes(a))
  const a = keywords(d.firstPrompts.join(' '))
  const b = keywords(d.recentPrompts.join(' '))
  const overlap = jaccard(a, b)
  if (areasDisjoint && a.size >= 5 && b.size >= 5 && overlap < 0.1) {
    return {
      isDrift: true,
      from: from ?? d.firstAreas[0],
      to: to ?? d.recentAreas[0],
      why: `new folders (${d.recentAreas.slice(0, 2).join(', ')}) and only ${Math.round(overlap * 100)}% word overlap with the first requests`,
    }
  }
  return { isDrift: false, from, to: to ?? from, why: from ? `still on ${from}` : 'same folders and words' }
}

/** Does the last answer read as a finished task? */
export function looksDone(answer: string): boolean {
  const s = String(answer ?? '')
  if (!s.trim()) return false
  if (/✅\s*\**\s*done/i.test(s)) return true
  const head = s.slice(0, 600)
  if (/\b(still running|in progress now|continuing|next I(?:'| wi)ll|let me (?:now|next))\b/i.test(head)) return false
  return /\b(all (?:tests )?(?:pass|green)|shipped|deployed|is live|done\b|finished|complete(?:d)?\b)/i.test(head)
}

/** Error signature: the first meaningful line, numbers and hex stripped. */
export function errorSignature(tool: string, text: string): string {
  const line =
    String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /error|failed|cannot|not found|denied|exception|refused|invalid|unexpected/i.test(l)) ??
    String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ??
    ''
  const norm = line
    .toLowerCase()
    .replace(/[0-9a-f]{7,}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/(["'`]).*?\1/g, '"…"')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
  return `${tool}: ${norm}`
}

/**
 * Repeated failures among the latest tool calls: the most repeated error
 * signature in the last `window` calls, counted only if it also showed up in
 * the last `fresh` calls (an old loop that was solved does not count).
 */
export function findLoop(calls: { tool: string; isError: boolean; text: string }[], window = 25, fresh = 8): { repeats: number; sample: string } {
  const recent = calls.slice(-window)
  const counts = new Map<string, { n: number; lastIdx: number; sample: string }>()
  recent.forEach((c, i) => {
    if (!c.isError) return
    const sig = errorSignature(c.tool, c.text)
    const prev = counts.get(sig)
    counts.set(sig, { n: (prev?.n ?? 0) + 1, lastIdx: i, sample: prev?.sample ?? `${c.tool}: ${clip(String(c.text ?? '').split('\n').find((l) => l.trim()) ?? '', 120)}` })
  })
  let best = { repeats: 0, sample: '' }
  for (const v of counts.values()) {
    if (recent.length - v.lastIdx > fresh) continue
    if (v.n > best.repeats) best = { repeats: v.n, sample: v.sample }
  }
  return best
}
