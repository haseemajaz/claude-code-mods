// context-keeper: a coach that says when to keep going, compact, clear or
// start a new chat, and a running backup ("capsule") of every chat that the
// next chat in the same project receives automatically.
//
//  - footer: the one recommendation (40 characters at most); a toast only
//    when it CHANGES to compact / new chat / clear / loop / break, at most once
//    per 30 minutes for each kind
//  - capsules: <claude folder>/zed-mods/context-keeper/capsules/<project>/<session>.md
//    (+ .json ledger, + index.json per project), refreshed after every answer
//    from the transcript alone; with useModel on, also summarised by a small
//    model every N prompts, at 60/80% context, before a compaction and on /backup
//  - a new chat (startup or /clear, not resume) gets the newest capsule of
//    the same folder as a session section of the system prompt, set once
//  - /coach explains the advice; /backup refreshes now; /restore [n] loads one

import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Msg } from './capsule'
import { addPrompt, areas, emptyLedger, ingestMessages, injectionText, modelPrompt, parseModelSections, renderCapsule, reviveLedger, titleOf, transcriptExcerpt } from './capsule'
import type { Advice, CoachState, Signals } from './coach'
import { advise, coachStep, detectDrift, findLoop, FRESH_COACH, looksDone, pressure, windowPct, cacheState } from './coach'
import type { Config } from './config'
import { configFileText, DEFAULT_CONFIG, mergeConfig } from './config'
import type { IndexEntry } from './pick'
import { isIndexEntry, pickForNewChat, recentBackups, reviveIndex, upsertIndex } from './pick'
import { lookForFooter, setFooter, watchFooter } from './footer'
import { claudeFolder, homeFolder, modFolder, readJson, tilde } from './home'
import { ago, clip, HOUR, projectSlug, resetText, shortCapsulePath, slash, stamp, tokens, transcriptSlug, ymd } from './text'

type $T = EngineInterface

const TICK_MS = 60_000
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified', 'channel', 'slack-ping'])

const S = {
  home: '',
  claude: '',
  dir: '',
  sid: '',
  cwd: '',
  root: '',
  slug: '',
  transcript: '',
  startedAt: 0,
  ledger: null as Ledger | null,
  ctxTokens: 0,
  ctxWindow: 0,
  rateLimits: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
  lastActivityAt: 0,
  isWorking: false,
  lastDone: false,
  loop: { repeats: 0, sample: '' },
  coach: FRESH_COACH as CoachState,
  advice: null as Advice | null,
  injected: null as null | { text: string; title: string; updatedAt: number; path: string },
  capsuleAt: 0,
  capsuleBy: '',
  refreshing: false,
  pendingRefresh: '',
  lastModelNote: '',
  entriesAt: 0,
  entries: [] as IndexEntry[],
  previousSid: '',
  names: { coach: 'coach', backup: 'backup', restore: 'restore' },
}

let cfg: Config = DEFAULT_CONFIG
let now = 0

// ---------------------------------------------------------------- paths

function capsulesDir(): string {
  return `${S.dir}/capsules`
}
function capsulePath(l: Ledger): string {
  return `${capsulesDir()}/${l.slug}/${l.sid}.md`
}
function ledgerPath(l: Ledger): string {
  return `${capsulesDir()}/${l.slug}/${l.sid}.json`
}
function indexPath(slug: string): string {
  return `${capsulesDir()}/${slug}/index.json`
}
/** A path as the person reads it. */
function shown(path: string): string {
  return tilde(path, S.home)
}
function configPath(): string {
  return `${S.dir}/config.json`
}
function guessTranscript(sid: string): string {
  return `${S.claude}/projects/${transcriptSlug(S.cwd)}/${sid}.jsonl`
}

// ---------------------------------------------------------------- small io

async function readText($: $T, path: string): Promise<string> {
  try {
    const t = await $.fs.read(path)
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}

async function loadConfig($: $T): Promise<void> {
  cfg = mergeConfig(await readJson($, configPath()))
}

async function readMessages($: $T): Promise<Msg[]> {
  try {
    const m = await $.session.messages()
    return Array.isArray(m) ? (m as Msg[]) : []
  } catch {
    return []
  }
}

function setStatus($: $T, advice: Advice): void {
  setFooter($, advice.status, advice.kind !== 'keep' && advice.kind !== 'cold')
}

function toast($: $T, text: string, timeoutMs = 12_000): void {
  $.ui.toast(text, { timeoutMs })
}

// ---------------------------------------------------------------- ledger

async function openLedger($: $T, sid: string): Promise<Ledger> {
  const fresh = emptyLedger(sid, S.cwd, S.root, S.slug, now, S.transcript || guessTranscript(sid))
  const raw = await readJson($, `${capsulesDir()}/${S.slug}/${sid}.json`)
  const l = reviveLedger(raw, fresh)
  l.sid = sid
  l.transcript = S.transcript || l.transcript || guessTranscript(sid)
  return l
}

async function switchTo($: $T, sid: string): Promise<void> {
  S.sid = sid
  S.ledger = await openLedger($, sid)
  S.capsuleAt = S.ledger.turns ? S.ledger.updatedAt : 0
  S.capsuleBy = S.ledger.model ? 'model summary' : 'automatic extract'
  S.loop = { repeats: 0, sample: '' }
  S.lastDone = false
  S.lastActivityAt = 0
  const saved = await $.store.get('coach:' + sid)
  S.coach = saved && typeof saved === 'object' && typeof (saved as CoachState).kind === 'string' ? (saved as CoachState) : FRESH_COACH
}

// ---------------------------------------------------------------- signals + advice

function growthPerTurn(l: Ledger): number {
  const h = l.ctxHistory.slice(-4)
  const deltas: number[] = []
  for (let i = 1; i < h.length; i++) {
    const d = h[i]!.tokens - h[i - 1]!.tokens
    if (d > 0) deltas.push(d)
  }
  return deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0
}

function limit(kind: string): { pct: number; resetsAt?: string } | undefined {
  const l = S.rateLimits.find((r) => r.kind === kind)
  return l ? (l.resetsAt ? { pct: l.percentUsed, resetsAt: l.resetsAt } : { pct: l.percentUsed }) : undefined
}

function signals(): Signals {
  const l = S.ledger ?? emptyLedger(S.sid, S.cwd, S.root, S.slug, now, '')
  const ar = areas(l)
  const drift = detectDrift(
    { firstPrompts: l.firstPrompts, recentPrompts: l.prompts.slice(-2).map((p) => p.text), firstAreas: ar.first, recentAreas: ar.recent, turns: l.turns },
    cfg.topics,
  )
  const five = limit('five_hour')
  const week = limit('seven_day')
  const sig: Signals = {
    now,
    ctxTokens: S.ctxTokens,
    ctxWindow: S.ctxWindow,
    growthPerTurn: growthPerTurn(l),
    turns: l.turns,
    compactions: l.compactions,
    lastActivityAt: S.lastActivityAt,
    isWorking: S.isWorking,
    drift,
    lastAnswerDone: S.lastDone,
    loop: S.loop,
    bigOutputs: l.bigOutputs,
    startedAt: S.startedAt || l.startedAt,
    hasBackup: S.capsuleAt > 0,
  }
  if (five) sig.fiveHour = five
  if (week) sig.sevenDay = week
  if (S.injected) sig.loadedBackup = S.injected.title
  return sig
}

/** Recompute the advice; toast only on a change the coach allows; status always. */
async function coachNow($: $T): Promise<Advice> {
  const sig = signals()
  const step = coachStep(S.coach, sig, cfg)
  const changed = step.state.kind !== S.coach.kind || step.toast !== undefined
  S.coach = step.state
  S.advice = step.advice
  if (S.ledger && sig.drift.from) S.ledger.topic = sig.drift.from
  if (changed && S.sid) await $.store.set('coach:' + S.sid, S.coach)
  if (step.toast) toast($, step.toast, 15_000)
  setStatus($, step.advice)
  return step.advice
}

// ---------------------------------------------------------------- capsules

async function allEntries($: $T, fresh: boolean): Promise<IndexEntry[]> {
  if (!fresh && now - S.entriesAt < TICK_MS) return S.entries
  const out: IndexEntry[] = []
  let dirs: { name: string; kind: string }[] = []
  try {
    dirs = await $.fs.list(capsulesDir())
  } catch {
    dirs = []
  }
  for (const d of dirs) {
    if (d.kind !== 'dir') continue
    const raw = await readJson($, indexPath(d.name))
    const idx = reviveIndex(raw, '', d.name)
    for (const e of Object.values(idx.chats)) if (isIndexEntry(e)) out.push(e)
  }
  S.entries = out
  S.entriesAt = now
  return out
}

/** Writes the capsule, its ledger and the project index; copies it when `copyTo` is set. */
async function writeCapsule($: $T, l: Ledger, by: string): Promise<string> {
  l.title = titleOf(l)
  l.updatedAt = now
  const md = renderCapsule(l, now, cfg.capsuleMaxChars)
  const path = capsulePath(l)
  await $.fs.write(path, md)
  await $.fs.write(ledgerPath(l), JSON.stringify(l))
  const idx = reviveIndex(await readJson($, indexPath(l.slug)), l.cwd, l.slug)
  const entry: IndexEntry = { sid: l.sid, title: l.title, cwd: l.cwd, slug: l.slug, updatedAt: l.updatedAt, turns: l.turns, ctxPct: l.ctx.pct, path, transcript: l.transcript }
  if (l.topic) entry.topic = l.topic
  await $.fs.write(indexPath(l.slug), JSON.stringify(upsertIndex(idx, entry), null, 1))
  S.entriesAt = 0
  if (cfg.copyTo) {
    try {
      await $.fs.write(`${slash(cfg.copyTo).replace(/^~(?=$|\/)/, S.home)}/${ymd(now)}/${l.slug}--${l.sid}.md`, md)
    } catch {
      // the copy is best effort
    }
  }
  if (l === S.ledger) {
    S.capsuleAt = now
    S.capsuleBy = l.model ? `model summary ${ago(now, l.model.at)}` : 'automatic extract'
    if (by) S.capsuleBy += ` · ${by}`
  }
  return path
}

/** The model's summary for this ledger; the capsule keeps the extract when it fails. */
async function modelRefresh($: $T, why: string, excerpt?: string): Promise<string> {
  const l = S.ledger
  if (!l || !cfg.useModel || l.turns === 0) return cfg.useModel ? 'nothing to summarise yet' : 'model summaries are off (useModel: false)'
  if (S.refreshing) {
    S.pendingRefresh = why
    return 'a summary is already being written'
  }
  S.refreshing = true
  let note = ''
  try {
    const text = excerpt ?? transcriptExcerpt(await readMessages($))
    const r = await $.model.complete({ model: cfg.summaryModel, prompt: modelPrompt(l, text), maxTokens: 1500, effort: 'low', timeoutMs: 90_000 })
    now = await $.clock.now()
    if (r.isAnswered) {
      const sections = parseModelSections(r.text)
      if (sections) {
        l.model = { at: now, model: cfg.summaryModel, sections }
        note = `summary by ${cfg.summaryModel}`
      } else note = `${cfg.summaryModel} answered in the wrong shape; kept the extract`
    } else note = `${cfg.summaryModel} gave no summary (${r.reason}); kept the extract`
    l.modelTurn = l.turns
    await writeCapsule($, l, why)
  } catch (err) {
    note = `summary failed (${clip(String((err as Error)?.message ?? err), 80)}); kept the extract`
  } finally {
    S.refreshing = false
    S.lastModelNote = note
  }
  if (S.pendingRefresh) {
    const next = S.pendingRefresh
    S.pendingRefresh = ''
    $.clock.after(1000, () => {
      modelRefresh($, next).catch(() => {})
    })
  }
  return note
}

/** After every main-loop turn: fold the transcript in, measure, advise, save, maybe summarise. */
async function afterTurn($: $T, answer: string): Promise<void> {
  now = await $.clock.now()
  const l = S.ledger
  if (!l) return
  const msgs = await readMessages($)
  ingestMessages(l, msgs, now, cfg.bigToolOutputChars)
  const calls: { tool: string; isError: boolean; text: string }[] = []
  for (const m of msgs) for (const t of m.toolUses ?? []) calls.push({ tool: t.tool, isError: !!t.isError, text: String(t.text ?? '') })
  S.loop = findLoop(calls)
  S.lastDone = looksDone(answer)
  try {
    const u = await $.session.usage()
    if (u.context.tokens) S.ctxTokens = u.context.tokens
    if (u.context.window) S.ctxWindow = u.context.window
    if (Array.isArray(u.rateLimits) && u.rateLimits.length) S.rateLimits = u.rateLimits
    if (u.startedAt) S.startedAt = u.startedAt
  } catch {
    // keep the last figures
  }
  l.ctx = { tokens: S.ctxTokens, window: S.ctxWindow, pct: pressure({ ctxTokens: S.ctxTokens, ctxWindow: S.ctxWindow }, cfg) }
  const last = l.ctxHistory[l.ctxHistory.length - 1]
  if (!last || last.turn !== l.turns) l.ctxHistory = [...l.ctxHistory, { turn: l.turns, tokens: S.ctxTokens }].slice(-10)
  await coachNow($)
  await writeCapsule($, l, '')
  const due = cfg.useModel && (l.turns - l.modelTurn >= cfg.capsuleEveryTurns || (!l.model && l.turns >= 2 && l.modelTurn === 0))
  if (due) await modelRefresh($, `every ${cfg.capsuleEveryTurns} prompts`)
}

// ---------------------------------------------------------------- the new chat's memory

async function pickAndInject($: $T, previousSid: string): Promise<void> {
  S.injected = null
  if (!cfg.autoLoad) return
  const entries = await allEntries($, true)
  const pick = pickForNewChat(entries, { cwd: S.cwd, currentSid: S.sid, previousSid, now, maxAgeMs: cfg.autoLoadMaxAgeHours * HOUR })
  if (!pick) return
  const md = await readText($, pick.path)
  if (!md.trim()) return
  S.injected = { text: injectionText(md, pick.title, pick.updatedAt, pick.transcript, cfg.injectMaxChars), title: pick.title, updatedAt: pick.updatedAt, path: pick.path }
}

async function tick($: $T): Promise<void> {
  now = await $.clock.now()
  if (!S.ledger) return
  await coachNow($)
}

// ---------------------------------------------------------------- commands

async function registerCommands($: $T): Promise<void> {
  const coach = { description: 'context-keeper: why the coach says keep going / compact / clear / new chat, with the numbers', argumentHint: '[config|reload]' }
  const backup = { description: "context-keeper: refresh this chat's backup capsule now and show where it is" }
  const restore = { description: 'context-keeper: list recent chat backups, or load one into this chat (/restore 2)', argumentHint: '[n]' }
  try {
    await $.command.register({ name: 'coach', ...coach })
  } catch {
    S.names.coach = 'cx-coach'
    await $.command.register({ name: 'cx-coach', ...coach }).catch(() => undefined)
  }
  try {
    await $.command.register({ name: 'backup', ...backup })
  } catch {
    S.names.backup = 'cx-backup'
    await $.command.register({ name: 'cx-backup', ...backup }).catch(() => undefined)
  }
  try {
    await $.command.register({ name: 'restore', ...restore })
  } catch {
    S.names.restore = 'cx-restore'
    await $.command.register({ name: 'cx-restore', ...restore }).catch(() => undefined)
  }
}

function coachText(): string {
  const a = S.advice
  const sig = signals()
  const l = S.ledger
  const p = pressure(sig, cfg)
  const w = windowPct(sig)
  const cache = cacheState(sig, cfg)
  const lines: string[] = []
  lines.push(`**Coach: ${a ? a.text : 'no reading yet'}**`)
  if (a) lines.push(`Why: ${a.reason}`)
  if (a && a.also.length) lines.push('', 'Also:', ...a.also.map((x) => `- ${x}`))
  lines.push('', 'The numbers:')
  lines.push(`- Context: ${tokens(sig.ctxTokens)} tokens${sig.ctxWindow ? ` of ${tokens(sig.ctxWindow)} (${w}% of the window)` : ''}; pressure ${p}% (the higher of window % and ${tokens(cfg.qualityBudgetTokens)} quality budget)`)
  lines.push(`- Growth: ${sig.growthPerTurn ? `+${tokens(sig.growthPerTurn)} per prompt lately` : 'flat or unknown'} · prompts ${sig.turns} · compactions ${sig.compactions} · long tool outputs ${sig.bigOutputs}`)
  lines.push(`- Cache: ${cache.kind === 'none' ? 'no request yet' : `${cache.kind}${cache.idleMin ? `, idle ${cache.idleMin} min` : ''}`} (lasts ~${cfg.cacheTtlMin} min)`)
  const five = sig.fiveHour
  const week = sig.sevenDay
  lines.push(`- Plan: ${five ? `5-hour ${Math.round(five.pct)}%${five.resetsAt ? ` (resets ${resetText(now, five.resetsAt)})` : ''}` : '5-hour n/a'} · ${week ? `week ${Math.round(week.pct)}%${week.resetsAt ? ` (resets ${resetText(now, week.resetsAt)})` : ''}` : 'week n/a'}`)
  lines.push(`- Topic: ${sig.drift.isDrift ? `switched ${sig.drift.from ?? '?'} → ${sig.drift.to ?? '?'}` : sig.drift.from ?? 'one task'} (${sig.drift.why})`)
  lines.push(`- Repeated error: ${sig.loop.repeats >= 2 ? `×${sig.loop.repeats} · ${sig.loop.sample}` : 'none'} · last answer reads ${sig.lastAnswerDone ? 'done' : 'unfinished'}`)
  lines.push(`- Chat started ${ago(now, sig.startedAt)}`)
  lines.push('', `Thresholds: compact ${cfg.compactPct}% · new chat ${cfg.newChatPct}% · topic-switch new chat ${cfg.driftNewChatPct}% · 5h break ${cfg.fiveHourBreakPct}% · loop ×${cfg.loopRepeats} · toasts on ${cfg.toastOn.join('/')} (once per ${cfg.toastCooldownMin} min).`)
  lines.push(`Backup: ${l && S.capsuleAt ? `${shown(capsulePath(l))} (${S.capsuleBy}, ${ago(now, S.capsuleAt)})` : 'not written yet (after the first answer)'}${S.injected ? ` · this chat started with "${S.injected.title}"` : ''}`)
  lines.push(`Settings: ${shown(configPath())} (/${S.names.coach} config makes it, /${S.names.coach} reload re-reads it).`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on) => {
  watchFooter(on)

  on('session.start', async ($, e, next) => {
    // one failed call here must not take the whole mod down for the session
    try {
      await lookForFooter($)
      now = await $.clock.now()
      S.home = await homeFolder($)
      S.claude = await claudeFolder($)
      S.dir = await modFolder($, 'context-keeper')
      if (!S.dir) return next(e)
      S.cwd = slash(e.cwd)
      try {
        S.root = slash(await $.session.root())
      } catch {
        S.root = S.cwd
      }
      S.slug = projectSlug(S.cwd)
      S.startedAt = now
      await loadConfig($)
      const sid = await $.session.id()
      S.transcript = guessTranscript(sid)
      await switchTo($, sid)
      await registerCommands($)
      let turns = 0
      try {
        turns = await $.session.turns()
      } catch {
        turns = 0
      }
      // a fresh chat (not a resume) gets the previous chat's backup
      if (turns === 0 && (S.ledger?.turns ?? 0) === 0) await pickAndInject($, '')
      await coachNow($)
      $.clock.every(TICK_MS, () => {
        tick($).catch(() => {})
      })
    } catch {
      // the chat goes on without the coach until the next start
    }
    return next(e)
  })

  // The transcript path, and the chat switches that fire no session.start
  on('classic.SessionStart', async ($, e, next) => {
    try {
      now = await $.clock.now()
      if (e.transcript_path) S.transcript = slash(e.transcript_path)
      const sid = e.session_id || S.sid
      if (e.source === 'clear' && sid && sid !== S.sid) {
        const previous = S.previousSid || S.sid
        S.previousSid = ''
        await switchTo($, sid)
        await pickAndInject($, previous)
        await coachNow($)
      } else if ((e.source === 'resume' || e.source === 'fork') && sid && sid !== S.sid) {
        await switchTo($, sid)
        S.injected = null
        await coachNow($)
      } else if (S.ledger && e.transcript_path) {
        S.ledger.transcript = slash(e.transcript_path)
      }
    } catch {
      // a failed switch must not block the chat; the next tick carries on
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      now = await $.clock.now()
      const l = S.ledger
      if (l && l.sid === e.sessionId && l.turns > 0) {
        l.endedAt = now
        await writeCapsule($, l, e.reason === 'clear' ? 'final, /clear' : 'final')
      }
      if (e.reason === 'clear') S.previousSid = e.sessionId
    } catch {
      // the last per-turn capsule stands
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      // a /clear whose SessionStart this module did not hear: switch here, before the first request
      if (S.previousSid) {
        const sid = await $.session.id()
        if (sid && sid !== S.sid) {
          now = await $.clock.now()
          const previous = S.previousSid
          S.previousSid = ''
          await switchTo($, sid)
          await pickAndInject($, previous)
        }
      }
      const person = e.origin && PERSON_ORIGINS.has(e.origin.kind) && !e.command && !e.isMeta
      if (person && S.ledger && addPrompt(S.ledger, e.text, (now = await $.clock.now()), true)) {
        await coachNow($)
      }
    } catch {
      // the prompt goes on regardless
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) S.isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    now = await $.clock.now()
    S.isWorking = false
    S.lastActivityAt = now
    const answer = e.answer
    // off the hook: reading the transcript and the model call must not hold the turn
    $.clock.after(10, () => {
      afterTurn($, answer).catch(() => {})
    })
    return r
  })

  on('session.measure', async ($, e, next) => {
    try {
      if (e.context.tokens) S.ctxTokens = e.context.tokens
      if (e.context.window) S.ctxWindow = e.context.window
      if (e.rateLimits.length) S.rateLimits = e.rateLimits
      const l = S.ledger
      if (l && e.changed.includes('context')) {
        now = await $.clock.now()
        const p = pressure({ ctxTokens: S.ctxTokens, ctxWindow: S.ctxWindow }, cfg)
        l.ctx = { tokens: S.ctxTokens, window: S.ctxWindow, pct: p }
        const crossed = cfg.capsuleAtPct.filter((t) => p >= t && !l.capturedPct.includes(t))
        if (crossed.length) {
          l.capturedPct = [...l.capturedPct, ...crossed]
          $.clock.after(10, () => {
            modelRefresh($, `context passed ${Math.max(...crossed)}%`).catch(() => {})
          })
        }
      }
      if (e.changed.includes('context') || e.changed.includes('rateLimits')) await coachNow($)
    } catch {
      // measurement only
    }
    return next(e)
  })

  // Before any compaction: save what the transcript still holds, then summarise it
  on('classic.PreCompact', async ($, e, next) => {
    try {
      now = await $.clock.now()
      if (e.transcript_path) S.transcript = slash(e.transcript_path)
      const l = S.ledger
      if (l) {
        const msgs = await readMessages($)
        ingestMessages(l, msgs, now, cfg.bigToolOutputChars)
        l.compactions += 1
        await writeCapsule($, l, `before ${e.trigger} compaction`)
        const excerpt = transcriptExcerpt(msgs)
        $.clock.after(10, () => {
          modelRefresh($, `before ${e.trigger} compaction`, excerpt).catch(() => {})
        })
      }
    } catch {
      // never hold up a compaction
    }
    return next(e)
  })

  // The new chat's memory: one session section, set when the chat began, never changed per turn
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const inj = S.injected
    if (!inj || e.traits.includes('teammate')) return r
    return { sections: [...r.sections, { id: 'context-keeper:backup', text: inj.text, scope: 'session' as const }] }
  })

  on('command.run', { command: ['coach', 'cx-coach'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'config') {
      const exists = await $.fs.exists(configPath())
      if (!exists) await $.fs.write(configPath(), configFileText(cfg))
      return { text: `${exists ? 'Settings file' : 'Made the settings file'}: ${shown(configPath())}\nEdit the thresholds there, then type /${S.names.coach} reload.` }
    }
    if (arg === 'reload') {
      await loadConfig($)
      await coachNow($)
      return { text: `Settings re-read from ${shown(configPath())}.\n\n${coachText()}` }
    }
    await coachNow($)
    return { text: coachText() }
  })

  on('command.run', { command: ['backup', 'cx-backup'] }, async ($) => {
    now = await $.clock.now()
    const l = S.ledger
    if (!l) return { text: 'No chat to back up yet.' }
    const msgs = await readMessages($)
    ingestMessages(l, msgs, now, cfg.bigToolOutputChars)
    await writeCapsule($, l, 'by /backup')
    const note = cfg.useModel ? await modelRefresh($, 'by /backup') : ''
    const path = capsulePath(l)
    const md = await readText($, path)
    return {
      text: [
        `Backup saved: ${shown(path)}`,
        `- ${md.length} characters (~${tokens(md.length / 4)} tokens) · ${l.turns} prompts · ${note || S.capsuleBy}`,
        `- Ledger: ${shown(ledgerPath(l))}`,
        `- Transcript: ${shown(l.transcript)}`,
        `- A new chat in this folder loads it automatically; from anywhere: /${S.names.restore}.`,
      ].join('\n'),
    }
  })

  on('command.run', { command: ['restore', 'cx-restore'] }, async ($, e) => {
    now = await $.clock.now()
    const list = recentBackups(await allEntries($, true), S.sid, 9)
    const arg = String(e.args ?? '').trim()
    if (!arg) {
      if (!list.length) return { text: `No backups yet in ${shown(capsulesDir())}.` }
      const rows = list.map((b, i) => `${i + 1}. ${b.title || b.slug} · ${ago(now, b.updatedAt)} · ${b.turns} prompts · ${b.cwd ? b.cwd.split('/').pop() : b.slug}\n   ${shortCapsulePath(b.path)}`)
      return { text: ['Recent chat backups (newest first):', ...rows, '', `Type /${S.names.restore} <n> to load one into this chat.`].join('\n') }
    }
    const n = Number(arg)
    const pick = Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined
    if (!pick) return { text: `No backup number ${arg}. Type /${S.names.restore} to see the list (1-${list.length}).` }
    const md = await readText($, pick.path)
    if (!md.trim()) return { text: `The backup file is missing or empty: ${shown(pick.path)}` }
    const ctx = injectionText(md, pick.title, pick.updatedAt, pick.transcript, cfg.injectMaxChars)
    return {
      text: `Loaded "${pick.title}" (${stamp(pick.updatedAt)}, ~${tokens(ctx.length / 4)} tokens) into this chat. Claude now has its goal, decisions, state, files and open tasks.`,
      context: [ctx],
    }
  })
}
