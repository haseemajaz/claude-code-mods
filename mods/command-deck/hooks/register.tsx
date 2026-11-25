// Command Deck: what you asked (MY PROMPTS), what the AI did (AI RESULTS) and
// what needs you (NEEDS ME), across every Claude Code chat on this computer.
// /deck opens a pane; where none can be drawn it answers with text.
//
// Every item has a Project, a Kind and an Age (hooks/categorize.ts), so a whole
// group can be ticked: /deck done group shop, /deck done older, /deck undo last.
//
// Sharing between chats: each chat writes only its own files under
// <claude folder>/zed-mods/command-deck/ (chats/<session>.json for its prompts,
// results, needs and "waiting on you" flag; marks/<session>.json for the Done
// ticks made from it). Every chat re-reads the folder every 8 seconds (only
// files whose time moved) and merges. No file has two writers, so no locks.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeckBoard, DeckNeed, DeckPromptRow, DeckScope } from '../types'
import {
  buildBoard,
  boardText,
  deckMarkdown,
  emptyChat,
  exportMarkdown,
  groupListText,
  groupsText,
  isChatFile,
  latestAction,
  recordTick,
  needsInGroup,
  undoTargets,
  isDone,
  isMarksFile,
  mergeMarks,
  needsIn,
  projectsOf,
  promptsIn,
  pruneChat,
  pruneMarks,
  resultLine,
  sanitizeChat,
  scopeName,
  statusGlyph,
  DAY,
} from './model'
import type { ChatFile, MarksFile, NeedRec, PromptRec } from './model'
import { groupSlug, matchGroup, parseNumbers, readProjects, setProjects } from './categorize'
import { modFolder, readJson, readSettings } from './home'
import { redact } from './redact'
import { since, basename, chatTitle, cleanPrompt, clip, extractNeeds, hashId, hhmm, isDeckPrompt, isNearDuplicate, normKey, summarize, ymd } from './text'

type $T = EngineInterface

const PANE = 'command-deck'
const POLL_MS = 8000
/** DECK.md waits this long after a prompt or an answer, so a burst writes once */
const DECK_DEBOUNCE_MS = 2000
/** and is rewritten at least this often while a chat is open (the "2h ago" texts age) */
const DECK_REFRESH_MS = 5 * 60 * 1000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Prompts the person typed (or sent from the phone/IDE); not task notices, peers or loops
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified', 'channel', 'slack-ping'])

const boardRef = atom({ plugin: 'command-deck', key: 'board' } as const, null)
const scopeRef = atom({ plugin: 'command-deck', key: 'scope' } as const, 'day')
const selfRef = atom({ plugin: 'command-deck', key: 'selfSid' } as const, '')

type Cached<T> = { mtime: number; data: T }

const S = {
  started: false,
  sid: '',
  cwd: '',
  dir: '',
  chat: null as ChatFile | null,
  marks: null as MarksFile | null,
  turnFiles: new Set<string>(),
  chatCache: new Map<string, Cached<ChatFile>>(),
  markCache: new Map<string, Cached<MarksFile>>(),
  lastBoardKey: '',
  lastBoardAt: 0,
  knownOpen: null as Set<string> | null,
  knownWaiting: new Set<string>(),
  lastCompact: 0,
  /** nothing here draws the footer (VS Code, a phone): the count goes in the status line */
  noFooter: false,
  status: undefined as string | undefined,
  deckTimer: null as { cancel(): void } | null,
  deckKey: '',
  lastDeckAt: 0,
}

// ---------------- files ----------------

const chatPath = (sid: string) => `${S.dir}/chats/${sid}.json`
const marksPath = (sid: string) => `${S.dir}/marks/${sid}.json`

async function saveChat($: $T): Promise<void> {
  if (!S.chat || !S.sid) return
  const now = await $.clock.now()
  const marks = mergeMarks(allMarks())
  S.chat = pruneChat({ ...S.chat, updatedAt: now }, now, marks)
  try {
    await $.fs.write(chatPath(S.sid), JSON.stringify(S.chat))
  } catch {
    // locked or full: the next event writes it again
  }
}

async function saveMarks($: $T): Promise<void> {
  if (!S.marks || !S.sid) return
  const now = await $.clock.now()
  S.marks = pruneMarks({ ...S.marks, updatedAt: now }, now)
  try {
    await $.fs.write(marksPath(S.sid), JSON.stringify(S.marks))
  } catch {
    // the next tick writes it again
  }
}

function allMarks(): MarksFile[] {
  const out: MarksFile[] = []
  for (const [name, c] of S.markCache) if (name !== `${S.sid}.json`) out.push(c.data)
  if (S.marks) out.push(S.marks)
  return out
}

function allChats(): ChatFile[] {
  const out: ChatFile[] = []
  for (const [name, c] of S.chatCache) if (name !== `${S.sid}.json`) out.push(c.data)
  if (S.chat) out.push(S.chat)
  return out
}

/** Re-reads the files other chats changed since the last look. */
async function scan($: $T): Promise<void> {
  for (const [sub, cache, check] of [
    ['chats', S.chatCache, isChatFile],
    ['marks', S.markCache, isMarksFile],
  ] as const) {
    let entries: { name: string; kind: string; mtimeMs: number }[] = []
    try {
      // no folder yet (nothing ticked anywhere): skip it without a failed list
      if (!(await $.fs.exists(`${S.dir}/${sub}`))) continue
      entries = await $.fs.list(`${S.dir}/${sub}`)
    } catch {
      continue
    }
    const names = new Set<string>()
    for (const entry of entries) {
      if (!entry.name.endsWith('.json') || entry.name === `${S.sid}.json`) continue
      names.add(entry.name)
      const had = cache.get(entry.name)
      if (had && had.mtime === entry.mtimeMs) continue
      const v = await readJson($, `${S.dir}/${sub}/${entry.name}`)
      // half-written: keep what we read last time
      if (check(v)) (cache as Map<string, Cached<unknown>>).set(entry.name, { mtime: entry.mtimeMs, data: sub === 'chats' ? sanitizeChat(v as ChatFile) : v })
    }
    for (const name of [...cache.keys()]) if (!names.has(name)) cache.delete(name)
  }
}

/** Once an hour: prune the files of chats that have been quiet for a day. */
async function compactStale($: $T, now: number): Promise<void> {
  if (now - S.lastCompact < 60 * 60 * 1000) return
  S.lastCompact = now
  const marks = mergeMarks(allMarks())
  for (const [name, c] of S.chatCache) {
    if (now - (c.data.updatedAt || 0) < DAY) continue
    const pruned = pruneChat(c.data, now, marks)
    if (pruned.prompts.length === c.data.prompts.length && pruned.needs.length === c.data.needs.length && !c.data.waiting) continue
    try {
      await $.fs.write(`${S.dir}/chats/${name}`, JSON.stringify({ ...pruned, waiting: null }))
    } catch {
      // try again next hour
    }
  }
}

// ---------------- board ----------------

async function refresh($: $T, opts: { scan?: boolean; toast?: boolean } = {}): Promise<DeckBoard> {
  const now = await $.clock.now()
  if (opts.scan) await scan($)
  const board = buildBoard(allChats(), allMarks(), now, S.sid)
  const key = JSON.stringify({ ...board, builtAt: 0 })
  if (key !== S.lastBoardKey || now - S.lastBoardAt > 60000) {
    S.lastBoardKey = key
    S.lastBoardAt = now
    await update($, boardRef, () => board)
  }
  if (opts.toast) announce($, board)
  setStatus($, board)
  return board
}

// ---------------- DECK.md ----------------

/** Writes DECK.md about 2 s after the last call. */
function scheduleDeck($: $T): void {
  if (!S.dir) return
  S.deckTimer?.cancel()
  S.deckTimer = $.clock.after(DECK_DEBOUNCE_MS, () => {
    S.deckTimer = null
    void writeDeck($).catch(() => {})
  })
}

/**
 * Every chat writes the same merged board, so two chats writing at once is
 * harmless: the last one wins and both say the same.
 */
async function writeDeck($: $T): Promise<void> {
  const board = await refresh($, { scan: true })
  S.deckKey = S.lastBoardKey
  S.lastDeckAt = board.builtAt
  try {
    await $.fs.write(`${S.dir}/DECK.md`, deckMarkdown(board, board.builtAt))
  } catch {
    // locked (open in an editor that holds it): the next change writes it again
  }
}

function groupKey(n: DeckNeed): string {
  return n.ids[0] ?? n.text
}

/** Toasts what other chats just added, and chats that started waiting on you. */
function announce($: $T, board: DeckBoard): void {
  const open = new Set(board.open.map(groupKey))
  if (S.knownOpen) {
    const fresh = board.open.filter((n) => !S.knownOpen!.has(groupKey(n)) && !n.sids.includes(S.sid))
    if (fresh.length) {
      const first = fresh[0]!
      $.ui.toast(`📌 ${clip(first.chat, 30)}: ${clip(first.text, 90)}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''} · /deck`, { timeoutMs: 10000 })
    }
  }
  S.knownOpen = open
  const waiting = new Set(board.waiting.map((w) => `${w.sid}:${w.since}`))
  for (const w of board.waiting) {
    const k = `${w.sid}:${w.since}`
    if (!w.self && !S.knownWaiting.has(k)) $.ui.toast(`⏳ ${clip(w.chat, 40)} is waiting for your answer (${w.what})`, { timeoutMs: 10000 })
  }
  S.knownWaiting = waiting
}

/** What the pane's NEEDS ME (n) counts for a scope. */
function shownCount(board: DeckBoard, scope: DeckScope): number {
  const waiting = scope === 'here' ? 0 : board.waiting.filter((w) => !w.self).length
  return needsIn(board.open, scope, S.sid).length + waiting
}

function todoCount(board: DeckBoard | null): number {
  return board ? board.open.length + board.waiting.filter((w) => !w.self).length : 0
}

/** Where no footer is drawn, the count shows as a status entry instead. */
function setStatus($: $T, board: DeckBoard): void {
  const n = todoCount(board)
  const text = S.noFooter && n ? `deck ${n} to do` : undefined
  if (text === S.status) return
  S.status = text
  $.ui.status(text)
}

// ---------------- capture ----------------

async function ensure($: $T): Promise<void> {
  if (S.started) return
  S.started = true
  try {
    S.dir = await modFolder($, 'command-deck')
    if (!S.dir) return
    setProjects(readProjects((await readSettings($, S.dir)).projects))
    S.cwd = await $.session.cwd()
    await adopt($, await $.session.id())
    await detectSurface($)
    try {
      await $.command.register({
        name: 'deck',
        description: 'Your prompts, the AI results and what needs YOU, across every chat',
        argumentHint: '[list | groups | done <n|3-9|group name|older> | undo <n|last> | here | all | clear-done | export]',
        immediate: true,
      })
    } catch {
      // already there
    }
    // the marks folder exists from the start, so the 8 s scan always finds it
    try {
      if (!(await $.fs.exists(`${S.dir}/marks`))) await saveMarks($)
    } catch {
      // made on the first tick instead
    }
    $.clock.every(POLL_MS, () => {
      void tick($).catch(() => {})
    })
  } catch (err) {
    // a failed start is retried by the next hook instead of leaving the mod silent all session
    S.started = false
    throw err
  }
  await refresh($, { scan: true, toast: true })
  scheduleDeck($)
}

/** Makes `sid` this chat's id: loads its file (a resumed chat) or starts one. */
async function adopt($: $T, sid: string): Promise<void> {
  const now = await $.clock.now()
  S.sid = sid
  const own = await readJson($, chatPath(sid))
  S.chat = isChatFile(own) ? sanitizeChat({ ...own, waiting: null }) : emptyChat(sid, basename(S.cwd), S.cwd, now)
  const marks = await readJson($, marksPath(sid))
  S.marks = isMarksFile(marks) ? marks : { v: 1, sid, updatedAt: now, marks: {} }
  S.turnFiles = new Set()
  await update($, selfRef, () => sid)
}

/** Asks where this session draws; a surface can attach or leave at any time, so every tick asks again. */
async function detectSurface($: $T): Promise<readonly string[]> {
  let surfaces: readonly string[] = []
  try {
    surfaces = await $.session.surfaces()
  } catch {
    surfaces = []
  }
  S.noFooter = surfaces.length > 0 && !surfaces.some((s) => s === 'terminal' || s === 'desktop')
  return surfaces
}

async function tick($: $T): Promise<void> {
  await detectSurface($)
  const now = await $.clock.now()
  // keep a waiting flag alive so other chats trust it
  const w = S.chat?.waiting
  if (w && now - w.aliveAt > 60000) {
    w.aliveAt = now
    await saveChat($)
  }
  await refresh($, { scan: true, toast: true })
  // another chat changed something (or the file is getting old): rewrite DECK.md
  if (!S.deckTimer && (S.lastBoardKey !== S.deckKey || now - S.lastDeckAt >= DECK_REFRESH_MS)) await writeDeck($)
  await compactStale($, now)
}

async function setWaiting($: $T, what: string | null): Promise<void> {
  if (!S.chat) return
  const now = await $.clock.now()
  if (what === null) {
    if (!S.chat.waiting) return
    S.chat.waiting = null
  } else {
    S.chat.waiting = { since: S.chat.waiting?.since ?? now, what, aliveAt: now }
  }
  await saveChat($)
  await refresh($)
}

function newId(now: number, text: string): string {
  return `${now.toString(36)}${hashId(S.sid + text).slice(0, 4)}`
}

// ---------------- ticking ----------------

async function setDone($: $T, need: DeckNeed, done: boolean): Promise<void> {
  await setDoneMany($, [need], done, clip(need.text, 60))
}

/**
 * Ticks (or reopens) several items with one timestamp. A tick is remembered
 * as this file's `last` action, so `/deck undo last` can put it back.
 */
async function setDoneMany($: $T, needs: readonly DeckNeed[], done: boolean, label: string): Promise<void> {
  if (!S.marks || needs.length === 0) return
  const now = await $.clock.now()
  const ids: string[] = []
  for (const need of needs) {
    for (const id of need.ids) {
      S.marks.marks[id] = { done, at: now }
      ids.push(id)
    }
    if (done) S.knownOpen?.delete(groupKey(need))
  }
  if (done) recordTick(S.marks, { at: now, ids, label, count: needs.length })
  await saveMarks($)
  await refresh($)
  scheduleDeck($)
}

/** Puts back the newest tick made anywhere (this chat or another). */
async function undoLast($: $T): Promise<string> {
  if (!S.marks) return 'Nothing to undo.'
  await scan($)
  const files = allMarks()
  const action = latestAction(files)
  if (!action) return 'Nothing to undo: no tick found in the last 60 days.'
  const now = await $.clock.now()
  const ids = undoTargets(action, mergeMarks(files))
  for (const id of ids) S.marks.marks[id] = { done: false, at: now }
  S.marks.undid = [...(S.marks.undid ?? []), action.key].slice(-20)
  await saveMarks($)
  const board = await refresh($)
  scheduleDeck($)
  if (!ids.length) return `The last tick (${action.label}) was already put back or changed since.`
  const items = action.count === 1 ? '1 item' : `${action.count} items`
  return `Put back ${items} (${action.label}). ${board.open.length} need you now.`
}

async function clearDone($: $T): Promise<number> {
  if (!S.marks) return 0
  const now = await $.clock.now()
  const board = buildBoard(allChats(), allMarks(), now, S.sid)
  for (const n of board.done) for (const id of n.ids) S.marks.marks[id] = { done: true, at: n.doneAt ?? now, hidden: true }
  await saveMarks($)
  await refresh($)
  scheduleDeck($)
  return board.done.length
}

async function exportNow($: $T, scope: DeckScope = 'day'): Promise<string> {
  const now = await $.clock.now()
  const board = await refresh($, { scan: true })
  const path = `${S.dir}/exports/${ymd(now)}.md`
  await $.fs.write(path, exportMarkdown(board, now, scope, S.sid))
  return path
}

// ---------------- hooks ----------------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await ensure($)
    } catch {
      // never block a session over the deck
    }
    return next(e)
  })

  // /clear and friends go on under a new session id
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await ensure($)
      const sid = await $.session.id()
      if (sid && sid !== S.sid) {
        await setWaiting($, null)
        await adopt($, sid)
        await refresh($)
      }
    } catch {
      // keep the old id
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await setWaiting($, null)
    } catch {
      // nothing to clear
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await ensure($)
      const raw = String(e.text || '')
      // only what the person typed: harness/IDE blocks out; nothing left = nothing saved
      const text = isDeckPrompt(raw) ? '' : cleanPrompt(raw)
      const fromPerson = PERSON_ORIGINS.has(e.origin.kind) || (e.origin.kind === 'plugin' && e.origin.asUser === true)
      if (S.chat && fromPerson && text) {
        const now = await $.clock.now()
        const clean = redact(text).slice(0, 500)
        const rec: PromptRec = { id: newId(now, text), at: now, text: clean }
        if (e.turnId) rec.turnId = e.turnId
        S.chat.prompts.push(rec)
        if (!S.chat.title || /^\s*</.test(S.chat.title)) S.chat.title = chatTitle(clean)
        await saveChat($)
        await refresh($)
        scheduleDeck($)
      }
    } catch {
      // the prompt goes through regardless
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      await ensure($)
      S.turnFiles = new Set()
      if (S.chat) for (const p of S.chat.prompts) if (!p.result && !p.turnId) p.turnId = e.turnId
    } catch {
      // nothing
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as { file_path?: string; notebook_path?: string }
    if (EDIT_TOOLS.has(tool)) {
      const path = input.file_path || input.notebook_path
      if (path) S.turnFiles.add(String(path).replace(/\\/g, '/').toLowerCase())
    }
    const asks = tool === 'AskUserQuestion' && !e.agentId
    if (asks) await setWaiting($, 'a question').catch(() => {})
    try {
      return await next(e)
    } finally {
      if (asks || S.chat?.waiting?.what.startsWith('permission')) await setWaiting($, null).catch(() => {})
    }
  })

  // A permission dialog is about to show: this chat now waits on the person
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      await ensure($)
      await setWaiting($, `permission for ${clip(String(e.tool_name || 'a tool'), 30)}`)
    } catch {
      // not fatal
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    try {
      await ensure($)
      if (!S.chat) return r
      const now = await $.clock.now()
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'error'
      const answer = String(e.answer || '')
      let summary = answer ? summarize(answer) : []
      if (summary.length === 0) summary = [status === 'stopped' ? 'You stopped it.' : status === 'error' ? 'Ended with an error.' : 'Finished (no text).']
      const result = { at: now, status, summary, files: S.turnFiles.size } as const
      for (const p of S.chat.prompts) if (!p.result && (p.turnId === e.turnId || !p.turnId)) p.result = { ...result, summary: [...summary] }
      const promptId = [...S.chat.prompts].reverse().find((p) => p.turnId === e.turnId)?.id
      S.chat.waiting = null

      const added: string[] = []
      for (const text of answer ? extractNeeds(answer) : []) {
        const id = hashId(normKey(text))
        const had = S.chat.needs.find((n) => n.id === id || isNearDuplicate(n.text, text))
        if (had) {
          had.seen = now
          continue
        }
        const rec: NeedRec = { id, at: now, seen: now, text }
        if (promptId) rec.promptId = promptId
        S.chat.needs.push(rec)
        // ticked before (here or in another chat)? then it is not news
        if (!isDone([id], mergeMarks(allMarks()))) added.push(text)
      }
      S.turnFiles = new Set()
      await saveChat($)
      scheduleDeck($)
      const board = await refresh($)
      for (const n of board.open) if (n.sids.includes(S.sid)) S.knownOpen?.add(groupKey(n))
      if (added.length) {
        $.ui.toast(`📌 New for you: ${clip(added[0]!, 100)}${added.length > 1 ? ` (+${added.length - 1} more)` : ''} · /deck`, { timeoutMs: 10000 })
      }
    } catch {
      // the turn's answer stands whatever happens here
    }
    return r
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    await ensure($)
    const args = String(e.args || '').trim()
    const [verb = '', ...rest] = args.split(/\s+/)
    const v = verb.toLowerCase()
    const now = await $.clock.now()

    if (v === 'undo' && (rest[0] ?? '').toLowerCase() === 'last') {
      return { text: await undoLast($) }
    }
    if (v === 'groups' || (v === 'group' && !rest.length)) {
      const board = await refresh($, { scan: true })
      return { text: groupsText(board) }
    }
    if ((v === 'list' || v === 'group') && rest.length) {
      const board = await refresh($, { scan: true })
      const projects = projectsOf(board.open)
      const m = matchGroup(rest.join(' '), projects)
      if (!m.ok) return { text: m.error }
      return { text: groupListText(needsInGroup(board.open, m.group.facet, m.group.name, now), m.group.name, groupSlug(m.group, projects), now) }
    }
    if (v === 'done' || v === 'undo') {
      const board = await refresh($, { scan: true })
      const done = v === 'done'
      if (rest.length === 0) return { text: `Type /deck ${v} <number>, like /deck ${v} 2, or a range (/deck ${v} 3-9)${done ? ', or a group (/deck done group shop, /deck done older)' : ', or /deck undo last'}.` }
      // "done group shop", or a word that is not a number: "done older", "done shop"
      const { nums, bad } = parseNumbers(rest[0]!.toLowerCase() === 'group' ? [] : rest)
      if (rest[0]!.toLowerCase() === 'group' || nums.length === 0) {
        if (!done) return { text: 'Undo takes numbers (/deck undo 2, /deck undo 3-9) or last (/deck undo last).' }
        const query = (rest[0]!.toLowerCase() === 'group' ? rest.slice(1) : rest).join(' ')
        const m = matchGroup(query, projectsOf(board.open))
        if (!m.ok) return { text: m.error }
        const items = needsInGroup(board.open, m.group.facet, m.group.name, now)
        if (!items.length) return { text: `Nothing open in ${m.group.name}.` }
        await setDoneMany($, items, true, m.group.name)
        const left = (await refresh($)).open.length
        return { text: `Ticked ${items.length} in ${m.group.name}. ${left ? `${left} still need you.` : 'Nothing left.'} Undo: /deck undo last` }
      }
      if (bad.length) return { text: `Not a number or a range: ${bad.join(', ')}. Use /deck ${v} 3 7 12 or /deck ${v} 3-9.` }
      const lines: string[] = []
      const picked: DeckNeed[] = []
      for (const n of nums) {
        const need = done ? board.open.find((x) => x.n === n) : board.done.find((x) => x.n === n)
        if (!need) {
          const other = done ? board.done.find((x) => x.n === n) : board.open.find((x) => x.n === n)
          lines.push(other ? `Item ${n} is already ${done ? 'done' : 'open'}.` : `No item ${n}.`)
          continue
        }
        picked.push(need)
        if (picked.length <= 10) lines.push(`${done ? 'Done' : 'Reopened'}: ${clip(need.text, 80)}`)
      }
      if (picked.length > 10) lines.push(`…and ${picked.length - 10} more.`)
      const label = picked.length === 1 ? clip(picked[0]!.text, 60) : `items ${nums.length > 6 ? `${nums[0]}–${nums[nums.length - 1]}` : picked.map((x) => x.n).join(', ')}`
      await setDoneMany($, picked, done, label)
      const left = (await refresh($)).open.length
      lines.push(left ? `${left} still need you.` : 'Nothing left.')
      if (done && picked.length) lines.push('Undo: /deck undo last')
      return { text: lines.join('\n') }
    }
    if (v === 'clear-done' || v === 'cleardone') {
      const n = await clearDone($)
      return { text: n ? `Hid ${n} done item${n === 1 ? '' : 's'}.` : 'No done items to hide.' }
    }
    if (v === 'export') {
      try {
        const sub = (rest[0] ?? '').toLowerCase()
        const scope: DeckScope = sub === 'all' ? 'all' : sub === 'here' ? 'here' : 'day'
        const path = await exportNow($, scope)
        const board = await refresh($)
        return { text: `Saved (${scopeName(scope)}, ${board.open.length} to do): ${path}
/deck export all = 14 days.` }
      } catch (err) {
        return { text: `Could not save the export: ${clip(String((err as Error)?.message ?? err), 120)}` }
      }
    }

    const scope: DeckScope = v === 'here' ? 'here' : v === 'all' ? 'all' : 'day'
    await update($, scopeRef, () => scope)
    const board = await refresh($, { scan: true })
    const surfaces = await detectSurface($)
    setStatus($, board)
    if (surfaces.length === 0) return { text: boardText(board, scope, S.sid, now) }
    // the three sections as text: the fallback wherever no pane shows
    if (v === 'list' || v === 'text') return { text: exportMarkdown(board, now, scope, S.sid, 15) }
    const opened = await $.ui.open({ id: PANE, title: 'Command Deck' })
    if (!opened.isPlaced) return { text: `${exportMarkdown(board, now, scope, S.sid, 15)}\n(As text: ${opened.reason})` }
    return { text: `Deck open · ${scopeName(scope)} · ${shownCount(board, scope)} to do` }
  })

  // ---------------- drawing ----------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const board = await read($, boardRef)
    const scope = await read($, scopeRef)
    const self = await read($, selfRef)
    const width = Math.max(30, e.props.bodyColumns || 80)
    return drawDeck($, e, board, scope, self, width)
  })

  // the count rides the footer
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const board = await read($, boardRef)
    const n = todoCount(board)
    if (n === 0) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `deck ${n} to do`] } })
  })
}

async function setScope($: $T, scope: DeckScope): Promise<void> {
  await update($, scopeRef, () => scope)
}

// ---------------- the pane ----------------

type Els = ReturnType<$T['ui']['resolve']>

function drawDeck($: $T, e: Parameters<$T['ui']['resolve']>[0], board: DeckBoard | null, scope: DeckScope, self: string, width: number) {
  const { Box, Text, Button } = $.ui.resolve(e) as Els
  const now = board?.builtAt ?? 0
  const wide = width >= 110

  const toolbar = (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      <Text bold>COMMAND DECK</Text>
      <Text dimColor>
        {scopeName(scope)}
        {board ? ` · ${board.chats} chat${board.chats === 1 ? '' : 's'}` : ''}
      </Text>
      <Button key="scope-day" label="24h" plain={scope === 'day' ? undefined : true} variant={scope === 'day' ? 'primary' : undefined} onPress={() => setScope($, 'day')} />
      <Button key="scope-here" label="This chat" plain={scope === 'here' ? undefined : true} variant={scope === 'here' ? 'primary' : undefined} onPress={() => setScope($, 'here')} />
      <Button key="scope-all" label="14 days" plain={scope === 'all' ? undefined : true} variant={scope === 'all' ? 'primary' : undefined} onPress={() => setScope($, 'all')} />
      <Button
        key="export"
        label="Export"
        plain
        onPress={async () => {
          try {
            const path = await exportNow($, scope)
            $.ui.toast(`Saved ${path}`)
          } catch {
            $.ui.toast('Could not save the export.')
          }
        }}
      />
    </Box>
  )

  if (!board) {
    return (
      <Box flexDirection="column">
        {toolbar}
        <Text dimColor>Loading…</Text>
      </Box>
    )
  }

  // ----- NEEDS ME -----
  const open = needsIn(board.open, scope, self)
  const done = needsIn(board.done, scope, self).slice(0, 5)
  const waiting = scope === 'here' ? board.waiting.filter((w) => w.sid === self) : board.waiting
  const needsCount = open.length + waiting.filter((w) => !w.self).length
  const needsW = wide ? Math.max(32, Math.floor(width * 0.34)) : width

  const needsCol = (
    <Box flexDirection="column" width={wide ? needsW : undefined}>
      <Text bold color={needsCount ? 'yellow' : 'green'}>
        NEEDS ME ({needsCount})
      </Text>
      {waiting.map((w) => (
        <Box flexDirection="column" key={`w-${w.sid}`}>
          <Text color="magenta">⏳ {clip(w.chat, needsW - 4)}</Text>
          <Text dimColor>
            {'   '}waiting for your answer · {w.what} · {since(now - w.since)}
          </Text>
        </Box>
      ))}
      {open.length === 0 && waiting.length === 0 ? <Text color="green">Nothing. You are on top of it.</Text> : null}
      {open.map((n) => (
        <Box flexDirection="column" key={`n-${groupKey(n)}`}>
          <Box flexDirection="row" columnGap={1}>
            <Box flexShrink={0}>
              <Text bold>{`${n.n}.`}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">{n.text}</Text>
            </Box>
            <Button key={`done-${groupKey(n)}`} label="Done" hotkey={n.n <= 9 ? String(n.n) : undefined} onPress={() => setDone($, n, true)} />
          </Box>
          <Text dimColor>
            {'   '}
            {clip(n.chat, Math.max(10, needsW - 16))} · {since(now - n.at)}
          </Text>
        </Box>
      ))}
      {done.length ? <Text dimColor>Done lately</Text> : null}
      {done.map((n) => (
        <Box flexDirection="row" columnGap={1} key={`d-${groupKey(n)}`}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor strikethrough wrap="truncate-end">
              ✓ {n.text}
            </Text>
          </Box>
          <Button key={`undo-${groupKey(n)}`} label="Undo" plain dimColor onPress={() => setDone($, n, false)} />
        </Box>
      ))}
      {done.length ? (
        <Button
          key="clear-done"
          label="Hide done"
          plain
          dimColor
          onPress={async () => {
            await clearDone($)
          }}
        />
      ) : null}
    </Box>
  )

  // ----- MY PROMPTS → AI RESULTS -----
  const rows = promptsIn(board, scope, self, now).slice(0, 40)
  const tone = (p: DeckPromptRow) => (p.status === 'done' ? 'green' : p.status === 'error' ? 'red' : p.status === 'running' ? 'cyan' : 'gray')
  const glyphText = (p: DeckPromptRow, extra: string) =>
    tone(p) === 'gray' ? (
      <Text dimColor wrap="wrap">
        {statusGlyph(p.status)} {extra}
      </Text>
    ) : (
      <Text color={tone(p)} wrap="wrap">
        {statusGlyph(p.status)} {extra}
      </Text>
    )
  const empty = <Text dimColor>No prompts {scope === 'here' ? 'in this chat' : 'yet'}.</Text>

  if (wide) {
    const rest = width - needsW - 3
    const promptW = Math.floor(rest * 0.48)
    const resultW = rest - promptW - 1
    const table = (
      <Box flexDirection="column" width={rest}>
        <Box flexDirection="row" columnGap={1}>
          <Box width={promptW}>
            <Text bold color="cyan">
              MY PROMPTS ({rows.length})
            </Text>
          </Box>
          <Box width={resultW}>
            <Text bold color="cyan">
              AI RESULTS
            </Text>
          </Box>
        </Box>
        {rows.length === 0 ? empty : null}
        {rows.map((p) => (
          <Box flexDirection="row" columnGap={1} marginBottom={1} key={`p-${p.key}`}>
            <Box flexDirection="column" width={promptW}>
              <Text dimColor wrap="truncate-end">
                {hhmm(p.at)} · {p.self ? 'this chat' : p.chat}
              </Text>
              <Text wrap="wrap">{clip(p.text, promptW * 2)}</Text>
            </Box>
            <Box flexDirection="column" width={resultW}>
              {glyphText(p, clip(resultLine(p), resultW * 2))}
              {p.summary.slice(1, 3).map((s, i) => (
                <Text dimColor wrap="truncate-end" key={`s-${p.key}-${i}`}>
                  {'  '}
                  {s}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {toolbar}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          {table}
          {needsCol}
        </Box>
      </Box>
    )
  }

  // narrow: NEEDS ME first, then prompt → result pairs
  return (
    <Box flexDirection="column">
      {toolbar}
      <Box marginTop={1}>{needsCol}</Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">
          MY PROMPTS → AI RESULTS ({rows.length})
        </Text>
        {rows.length === 0 ? empty : null}
        {rows.map((p) => (
          <Box flexDirection="column" marginBottom={1} key={`p-${p.key}`}>
            <Text wrap="wrap">› {clip(p.text, width * 2)}</Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {hhmm(p.at)} · {p.self ? 'this chat' : chatLabelShort(p.chat)}
            </Text>
            {glyphText(p, clip(resultLine(p), width * 2))}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function chatLabelShort(label: string): string {
  return clip(label, 40)
}
