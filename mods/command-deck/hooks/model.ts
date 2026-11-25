// Command Deck data model. Pure: no `$`, no I/O.
//
// Storage (under <claude folder>/zed-mods/command-deck/):
//   chats/<sessionId>.json  one file per chat, written only by that chat
//   marks/<sessionId>.json  the Done ticks made FROM that chat (any item)
// No two chats ever write the same file, so there is nothing to lock. A reader
// merges every file; a half-written file fails JSON.parse and the reader keeps
// the copy it read last time.

import type { DeckBoard, DeckNeed, DeckPromptRow, DeckWaiting, DeckStatus } from '../types'
import { chatTitle, cleanPrompt, clip, isNearDuplicate, ymd, hhmm, since, whenShort } from './text'
import { FACETS, OTHER, ageOf, chatProject, facetNames, groupOf, groupSlug, itemKind, itemProject } from './categorize'
import type { Facet } from './categorize'

export const DAY = 24 * 60 * 60 * 1000
export const KEEP_PROMPTS_MS = 14 * DAY
export const KEEP_DONE_MS = 7 * DAY
export const KEEP_MARKS_MS = 60 * DAY
export const WAITING_STALE_MS = 3 * 60 * 1000
export const NO_RESULT_AFTER_MS = 6 * 60 * 60 * 1000
export const MAX_BOARD_PROMPTS = 300

export type ResultRec = {
  at: number
  status: 'done' | 'error' | 'stopped'
  summary: string[]
  files: number
}

export type PromptRec = {
  id: string
  at: number
  text: string
  turnId?: string
  result?: ResultRec
}

export type NeedRec = {
  id: string
  /** first time this chat raised it */
  at: number
  /** last time this chat raised it (a raise after a Done tick reopens it) */
  seen: number
  text: string
  promptId?: string
}

export type ChatFile = {
  v: 1
  sid: string
  folder: string
  title: string
  cwd: string
  updatedAt: number
  waiting?: { since: number; what: string; aliveAt: number } | null
  prompts: PromptRec[]
  needs: NeedRec[]
}

export type Mark = { done: boolean; at: number; hidden?: boolean }

/** The last tick made from a marks file (one item or a whole group): what "undo last" puts back. */
export type TickAction = { at: number; ids: string[]; label: string; count: number }

export type MarksFile = {
  v: 1
  sid: string
  updatedAt: number
  marks: Record<string, Mark>
  /** the last tick made from this file */
  last?: TickAction
  /** the last ticks made from this file, oldest first (at most 10): undo last can go back step by step */
  ticks?: TickAction[]
  /** `<sid>:<at>` of the ticks (from any file) this file put back */
  undid?: string[]
}

/** The newest tick, across every marks file, that no file has put back yet. */
export const MAX_TICKS = 10

/** Records a tick as a file's last one, keeping the 10 before it. */
export function recordTick(file: MarksFile, action: TickAction): void {
  file.last = action
  file.ticks = [...(file.ticks ?? []).filter((t) => t.at !== action.at), action].slice(-MAX_TICKS)
}

export function latestAction(files: readonly MarksFile[]): (TickAction & { key: string }) | undefined {
  const undone = new Set(files.flatMap((f) => (Array.isArray(f.undid) ? f.undid : [])))
  let best: (TickAction & { key: string }) | undefined
  for (const f of files) {
    const list = [...(Array.isArray(f.ticks) ? f.ticks : []), ...(f.last ? [f.last] : [])]
    for (const l of list) {
      if (!l || typeof l.at !== 'number' || !Array.isArray(l.ids)) continue
      const key = `${f.sid}:${l.at}`
      if (undone.has(key)) continue
      if (!best || l.at > best.at) best = { ...l, key }
    }
  }
  return best
}

/** The ids of a tick that still stand as that tick left them (nothing newer touched them). */
export function undoTargets(action: TickAction, marks: Record<string, Mark>): string[] {
  return action.ids.filter((id) => {
    const m = marks[id]
    return !!m && m.done && m.at === action.at
  })
}

export function emptyChat(sid: string, folder: string, cwd: string, now: number): ChatFile {
  return { v: 1, sid, folder, title: '', cwd, updatedAt: now, waiting: null, prompts: [], needs: [] }
}

export function isChatFile(v: unknown): v is ChatFile {
  const c = v as ChatFile
  return !!c && typeof c === 'object' && c.v === 1 && typeof c.sid === 'string' && Array.isArray(c.prompts) && Array.isArray(c.needs)
}

export function isMarksFile(v: unknown): v is MarksFile {
  const m = v as MarksFile
  return !!m && typeof m === 'object' && m.v === 1 && typeof m.marks === 'object' && m.marks !== null
}

/**
 * Takes harness blocks out of a chat saved before prompts were cleaned (or by
 * an older copy of the mod): cleans each prompt, drops the ones that were
 * nothing but injected text, and rebuilds a title that starts with a tag.
 */
export function sanitizeChat(c: ChatFile): ChatFile {
  let changed = false
  const prompts: PromptRec[] = []
  for (const p of c.prompts) {
    const text = /</.test(p.text) ? cleanPrompt(p.text) : p.text
    if (text !== p.text) changed = true
    if (!text) continue
    prompts.push(text === p.text ? p : { ...p, text })
  }
  let title = c.title
  if (!title || /^\s*</.test(title)) {
    const first = prompts[0]
    const next = first ? chatTitle(first.text) : ''
    if (next !== title) {
      title = next
      changed = true
    }
  }
  return changed ? { ...c, title, prompts } : c
}

export function chatLabel(c: Pick<ChatFile, 'folder' | 'title' | 'sid'>): string {
  const folder = c.folder || 'chat'
  return c.title ? `${folder} · ${c.title}` : `${folder} · ${c.sid.slice(0, 6)}`
}

/** Latest tick wins, across every marks file. */
export function mergeMarks(files: readonly MarksFile[]): Record<string, Mark> {
  const out: Record<string, Mark> = {}
  for (const f of files) {
    for (const [id, m] of Object.entries(f.marks || {})) {
      if (!m || typeof m.at !== 'number') continue
      const cur = out[id]
      if (!cur || m.at > cur.at) out[id] = { ...m }
    }
  }
  return out
}

/**
 * Done when the latest tick on any of the ids says done. A tick is final: the
 * AI repeating the same item in a later reply does not reopen it (Undo does).
 */
export function isDone(ids: readonly string[], marks: Record<string, Mark>): Mark | undefined {
  let best: Mark | undefined
  for (const id of ids) {
    const m = marks[id]
    if (m && (!best || m.at > best.at)) best = m
  }
  return best && best.done ? best : undefined
}

/** Drops prompts past 14 days and needs ticked done more than 7 days ago. */
export function pruneChat(chat: ChatFile, now: number, marks: Record<string, Mark>): ChatFile {
  const prompts = chat.prompts.filter((p) => now - p.at <= KEEP_PROMPTS_MS)
  const needs = chat.needs.filter((n) => {
    const m = isDone([n.id], marks)
    return !(m && now - m.at > KEEP_DONE_MS)
  })
  return { ...chat, prompts, needs }
}

export function pruneMarks(file: MarksFile, now: number): MarksFile {
  const marks: Record<string, Mark> = {}
  for (const [id, m] of Object.entries(file.marks)) if (now - m.at <= KEEP_MARKS_MS) marks[id] = m
  return { ...file, marks }
}

function statusOf(p: PromptRec, chat: ChatFile, now: number): DeckStatus {
  if (p.result) return p.result.status
  const quiet = now - Math.max(p.at, chat.updatedAt || 0)
  return quiet > NO_RESULT_AFTER_MS ? 'none' : 'running'
}

const chatProjects = new Map<string, { key: string; project: string }>()

/** A chat's project (its folder, else what its title, prompts and items talk about), cached per file version. */
export function projectOfChat(c: ChatFile): string {
  const key = `${c.updatedAt}:${c.prompts.length}:${c.needs.length}:${c.title}`
  const had = chatProjects.get(c.sid)
  if (had && had.key === key) return had.project
  const project = chatProject({ cwd: c.cwd, title: c.title, texts: [...c.prompts.map((p) => p.text), ...c.needs.map((n) => n.text)] })
  chatProjects.set(c.sid, { key, project })
  return project
}

/** Everything the pane and the footer draw, merged across all chats. */
export function buildBoard(chats: readonly ChatFile[], markFiles: readonly MarksFile[], now: number, selfSid: string): DeckBoard {
  const marks = mergeMarks(markFiles)
  const prompts: DeckPromptRow[] = []
  const waiting: DeckWaiting[] = []
  type Raw = { id: string; text: string; at: number; seen: number; chat: string; sid: string; chatProject: string }
  const raws: Raw[] = []

  for (const c of chats) {
    const label = chatLabel(c)
    const cp = projectOfChat(c)
    for (const p of c.prompts) {
      if (now - p.at > KEEP_PROMPTS_MS) continue
      const status = statusOf(p, c, now)
      prompts.push({
        key: `${c.sid}:${p.id}`,
        chat: label,
        sid: c.sid,
        at: p.at,
        // the whole prompt on one line: every view clips it to its own width
        text: String(p.text || '').replace(/\s+/g, ' ').trim(),
        status,
        summary: p.result ? p.result.summary : [],
        files: p.result ? p.result.files : 0,
        self: c.sid === selfSid,
      })
    }
    for (const n of c.needs) raws.push({ id: n.id, text: n.text, at: n.at, seen: n.seen || n.at, chat: label, sid: c.sid, chatProject: cp })
    const w = c.waiting
    if (w && now - (w.aliveAt || w.since) <= WAITING_STALE_MS) {
      waiting.push({ sid: c.sid, chat: label, since: w.since, what: w.what, self: c.sid === selfSid })
    }
  }

  // group near-duplicates (across chats too); the oldest raise names the group
  raws.sort((a, b) => a.at - b.at)
  type Group = { ids: string[]; text: string; at: number; seen: number; chat: string; sid: string; sids: Set<string>; chatProject: string }
  const groups: Group[] = []
  for (const r of raws) {
    const g = groups.find((x) => x.ids.includes(r.id) || isNearDuplicate(x.text, r.text))
    if (g) {
      if (!g.ids.includes(r.id)) g.ids.push(r.id)
      g.seen = Math.max(g.seen, r.seen)
      g.sids.add(r.sid)
      continue
    }
    groups.push({ ids: [r.id], text: r.text, at: r.at, seen: r.seen, chat: r.chat, sid: r.sid, sids: new Set([r.sid]), chatProject: r.chatProject })
  }

  const open: DeckNeed[] = []
  const done: DeckNeed[] = []
  const order = new Map<DeckNeed, number>()
  groups.forEach((g, i) => {
    const m = isDone(g.ids, marks)
    const base = {
      ids: g.ids,
      text: g.text,
      chat: g.chat,
      sid: g.sid,
      sids: [...g.sids],
      at: g.at,
      seen: g.seen,
      self: g.sids.has(selfSid),
      project: itemProject(g.text, g.chatProject),
      kind: itemKind(g.text),
      age: ageOf(g.at, now),
    }
    let need: DeckNeed
    if (m) {
      if (m.hidden || now - m.at > KEEP_DONE_MS) return
      need = { ...base, n: 0, done: true, doneAt: m.at }
      done.push(need)
    } else {
      need = { ...base, n: 0, done: false }
      open.push(need)
    }
    order.set(need, i)
  })
  // Stable numbers: open items AND items ticked in the last 24 h share one
  // oldest-first count, so ticking item 2 leaves item 3 as 3 (DECK.md and
  // /deck done use these). New items take the next numbers.
  const byAge = (a: DeckNeed, b: DeckNeed) => a.at - b.at || (order.get(a) ?? 0) - (order.get(b) ?? 0)
  const numbered = [...open, ...done.filter((d) => now - (d.doneAt || 0) <= DAY)].sort(byAge)
  numbered.forEach((x, i) => (x.n = i + 1))
  open.sort(byAge)
  done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
  prompts.sort((a, b) => b.at - a.at)
  waiting.sort((a, b) => a.since - b.since)

  // every numbered done item stays (undo by number), plus older ones up to 30
  const recentDone = done.filter((d) => d.n > 0)
  const olderDone = done.filter((d) => d.n === 0).slice(0, Math.max(0, 30 - recentDone.length))
  return {
    builtAt: now,
    prompts: prompts.slice(0, MAX_BOARD_PROMPTS),
    open,
    done: [...recentDone, ...olderDone],
    waiting,
    chats: chats.length,
  }
}

export type Scope = 'day' | 'here' | 'all'

export function scopeName(scope: Scope): string {
  return scope === 'here' ? 'this chat' : scope === 'all' ? 'last 14 days' : 'last 24h'
}

export function promptsIn(board: DeckBoard, scope: Scope, selfSid: string, now: number): DeckPromptRow[] {
  if (scope === 'here') return board.prompts.filter((p) => p.sid === selfSid)
  if (scope === 'day') return board.prompts.filter((p) => now - p.at <= DAY)
  return board.prompts
}

export function needsIn(list: readonly DeckNeed[], scope: Scope, selfSid: string): DeckNeed[] {
  return scope === 'here' ? list.filter((n) => n.sids.includes(selfSid)) : [...list]
}

export function statusGlyph(s: DeckStatus): string {
  return s === 'done' ? '✓' : s === 'error' ? '✗' : s === 'stopped' ? '■' : s === 'running' ? '…' : '–'
}

export function statusWord(s: DeckStatus): string {
  return s === 'done' ? 'done' : s === 'error' ? 'error' : s === 'stopped' ? 'stopped' : s === 'running' ? 'running' : 'no result'
}

/** One-line result text for a prompt row. */
export function resultLine(p: DeckPromptRow): string {
  if (p.status === 'running') return 'running…'
  if (p.status === 'none') return 'no result saved'
  const first = p.summary[0] || statusWord(p.status)
  return p.files > 0 ? `${first} · ${p.files} file${p.files === 1 ? '' : 's'}` : first
}

// ---------------- groups ----------------

/** The projects of the open items, the busiest first; Other last. */
export function projectsOf(list: readonly Categorized[]): string[] {
  const counts = new Map<string, number>()
  for (const n of list) counts.set(n.project || OTHER, (counts.get(n.project || OTHER) ?? 0) + 1)
  return [...counts].sort((a, b) => Number(a[0] === OTHER) - Number(b[0] === OTHER) || b[1] - a[1]).map(([name]) => name)
}

export type Categorized = { project?: string; kind?: string; at: number }
export type NeedGroup<T> = { facet: Facet; name: string; slug: string; items: T[] }

/**
 * Items in groups for one facet, newest first inside each group. Projects are
 * ordered by their newest item (Other last); kinds and ages keep their fixed order.
 */
export function groupNeeds<T extends Categorized>(list: readonly T[], facet: Facet, now: number): NeedGroup<T>[] {
  const by = new Map<string, T[]>()
  for (const n of list) {
    const g = groupOf(n, facet, now)
    const arr = by.get(g)
    if (arr) arr.push(n)
    else by.set(g, [n])
  }
  const projects = projectsOf(list)
  const names = facetNames(facet, projects)
  const out: NeedGroup<T>[] = []
  for (const [name, items] of by) {
    items.sort((a, b) => b.at - a.at)
    out.push({ facet, name, slug: groupSlug({ facet, name }, projects), items })
  }
  const rank = (name: string) => {
    const i = names.indexOf(name)
    return i < 0 ? names.length : i
  }
  if (facet === 'project') {
    out.sort((a, b) => Number(a.name === OTHER) - Number(b.name === OTHER) || (b.items[0]?.at ?? 0) - (a.items[0]?.at ?? 0) || rank(a.name) - rank(b.name))
  } else {
    out.sort((a, b) => rank(a.name) - rank(b.name))
  }
  return out
}

/** What `/deck done group <name>` ticks: the open items in that group. */
export function needsInGroup(list: readonly DeckNeed[], facet: Facet, name: string, now: number): DeckNeed[] {
  return list.filter((n) => groupOf(n, facet, now) === name)
}

/** Every group of every facet, with its slug and how many open items it has. */
export function groupIndex(board: DeckBoard): Record<Facet, { name: string; slug: string; count: number }[]> {
  const now = board.builtAt
  const projects = projectsOf(board.open)
  const out = {} as Record<Facet, { name: string; slug: string; count: number }[]>
  for (const facet of FACETS) {
    out[facet] = facetNames(facet, projects).map((name) => ({ name, slug: groupSlug({ facet, name }, projects), count: needsInGroup(board.open, facet, name, now).length }))
  }
  return out
}

/** `/deck groups`: the counts per project, kind and age, with what to type. */
export function groupsText(board: DeckBoard): string {
  const idx = groupIndex(board)
  const lines = [`NEEDS ME by group (${board.open.length} open). Tick a whole group: /deck done group <name>`]
  for (const facet of FACETS) {
    const rows = idx[facet].filter((g) => g.count > 0)
    if (facet === 'project') rows.sort((a, b) => b.count - a.count)
    lines.push('', facet.toUpperCase())
    if (!rows.length) lines.push('  nothing open')
    const w = Math.max(...rows.map((r) => r.name.length), 4)
    for (const g of rows) lines.push(`  ${String(g.count).padStart(3)}  ${g.name.padEnd(w)}  → /deck done group ${g.slug}`)
  }
  lines.push('', 'Also: /deck list <group> · /deck done 3-9 · /deck done older · /deck undo last')
  return lines.join('\n')
}

/** `/deck list <group>`: that group's open items, newest first. */
export function groupListText(items: readonly DeckNeed[], name: string, slug: string, now: number): string {
  const lines = [`${name} (${items.length} open), newest first:`]
  for (const n of [...items].sort((a, b) => b.at - a.at)) lines.push(`  ${n.n}. ${clip(n.text, 160)}  — ${clip(n.chat, 40)}, ${since(now - n.at)}`)
  if (!items.length) lines.push('  Nothing open here.')
  else lines.push('', `Tick all ${items.length}: /deck done group ${slug} · or some: /deck done ${items.slice(0, 2).map((n) => n.n).join(' ')}`)
  return lines.join('\n')
}

// ---------------- text answers ----------------

/** Plain text for /deck where nothing draws a pane (claude -p). */
export function boardText(board: DeckBoard, scope: Scope, selfSid: string, now: number): string {
  const out: string[] = []
  const open = needsIn(board.open, scope, selfSid)
  out.push(`NEEDS ME (${open.length + board.waiting.length})`)
  for (const w of board.waiting) out.push(`  ⏳ ${w.chat} is waiting for your answer (${w.what})`)
  for (const g of groupNeeds(open, 'project', now)) {
    out.push(`  ${g.name.toUpperCase()} (${g.items.length}) · tick all: /deck done group ${g.slug}`)
    for (const n of g.items) out.push(`    ${n.n}. ${n.text}  — ${n.chat}, ${since(now - n.at)}`)
  }
  if (open.length === 0 && board.waiting.length === 0) out.push('  Nothing. You are on top of it.')
  out.push('', `MY PROMPTS → AI RESULTS (${scopeName(scope)})`)
  const rows = promptsIn(board, scope, selfSid, now).slice(0, 20)
  for (const p of rows) out.push(`  ${hhmm(p.at)} ${clip(p.text, 70)}  [${p.chat}]`, `     ${statusGlyph(p.status)} ${clip(resultLine(p), 90)}`)
  if (rows.length === 0) out.push('  No prompts yet.')
  out.push('', 'Tick: /deck done <n> · /deck done 3-9 · /deck done group <name> · /deck groups · /deck undo last')
  return out.join('\n')
}

/**
 * The three sections as markdown: what /deck export writes, and what /deck
 * answers where no pane is drawn. `maxRows` caps the prompt list for the
 * inline answer; the file gets them all.
 */
export function exportMarkdown(board: DeckBoard, now: number, scope: Scope = 'day', selfSid = '', maxRows = Infinity): string {
  const lines: string[] = []
  const open = needsIn(board.open, scope, selfSid)
  const waiting = scope === 'here' ? board.waiting.filter((w) => w.sid === selfSid) : board.waiting
  lines.push(`# Command Deck — ${ymd(now)} ${hhmm(now)} (${scopeName(scope)})`, '')
  lines.push(`## 📌 Needs me (${open.length} open)`, '')
  for (const w of waiting) lines.push(`- ⏳ **${w.chat}** is waiting for your answer (${w.what})`)
  for (const g of groupNeeds(open, 'project', now)) {
    lines.push('', `### ${g.name} (${g.items.length})`, `Tick all: \`/deck done group ${g.slug}\``, '')
    for (const n of g.items) lines.push(`- **${n.n}.** ${n.text} — _${n.chat}, ${since(now - n.at)}_`)
  }
  if (open.length === 0 && waiting.length === 0) lines.push('Nothing open. You are on top of it.')
  const done = needsIn(board.done, scope, selfSid)
  if (done.length) {
    lines.push('', '**Done lately**', '')
    for (const n of done.slice(0, 30)) lines.push(`- [x] ${n.text} — _${n.chat}_`)
    if (done.length > 30) lines.push(`- …and ${done.length - 30} more`)
  }
  const all = promptsIn(board, scope, selfSid, now)
  const rows = all.slice(0, maxRows)
  lines.push('', `## 💬 My prompts (${all.length})`, '')
  rows.forEach((p, i) => lines.push(`${i + 1}. \`${hhmm(p.at)}\` **${p.chat}** — ${clip(p.text, 200)}`))
  if (rows.length === 0) lines.push('None.')
  lines.push('', '## AI results', '')
  rows.forEach((p, i) => {
    lines.push(`${i + 1}. ${statusGlyph(p.status)} ${statusWord(p.status)}${p.files ? ` · ${p.files} file${p.files === 1 ? '' : 's'}` : ''}`)
    for (const s of p.summary) lines.push(`   - ${s}`)
  })
  if (rows.length === 0) lines.push('None.')
  if (rows.length < all.length) lines.push('', `…and ${all.length - rows.length} older. /deck export saves them all.`)
  lines.push('', 'Tick: `/deck done <n>` · `/deck done 3-9` · `/deck done group <name>` · `/deck groups` · `/deck undo last`')
  lines.push('')
  return lines.join('\n')
}

// ---------------- DECK.md: the board as a file ----------------

export const DECK_PROMPT_MAX = 120
export const DECK_RESULT_MAX = 160
export const DECK_MAX_ROWS = 60
export const DECK_MAX_DONE = 30

/** One table cell: one line, clipped, `|` escaped, `<` escaped so a preview never eats it as HTML. */
export function mdCell(s: string, max: number): string {
  return clip(String(s || '').replace(/[\r\n]+/g, ' '), max)
    .replace(/\|/g, '\\|')
    .replace(/</g, '\\<')
}

/** Text on a list line: one line, `<` escaped. */
function mdLine(s: string, max = 220): string {
  return clip(String(s || '').replace(/[\r\n]+/g, ' '), max).replace(/</g, '\\<')
}

/**
 * The all-chats board as plain markdown, for an editor tab or its Markdown
 * preview: NEEDS ME grouped by project (stable numbers, newest first inside,
 * a tick-all line per group), MY PROMPTS → AI RESULTS (last 24 h, newest
 * first), then the items ticked in the last 24 h, struck through.
 *
 * Item lines are `- [ ] **12.** text`: a list a preview never renumbers.
 */
export function deckMarkdown(board: DeckBoard, now: number): string {
  const out: string[] = []
  const recentDone = board.done.filter((n) => n.n > 0)
  const count = board.open.length + board.waiting.length
  out.push(`# Command Deck — updated ${hhmm(now)}`, '')
  out.push(`_All chats on this computer · ${board.chats} chat${board.chats === 1 ? '' : 's'} · tick one off: \`/deck done 2\` · a whole group: \`/deck done group <name>\` · \`/deck groups\`_`, '')
  out.push(`## 📌 NEEDS ME (${count})`, '')
  for (const w of board.waiting) out.push(`- ⏳ **${mdLine(w.chat, 60)}** is waiting for your answer (${mdLine(w.what, 60)}) · ${since(now - w.since)}`)
  for (const g of groupNeeds(board.open, 'project', now)) {
    out.push('', `### ${g.name} (${g.items.length})`, '', `Tick all: \`/deck done group ${g.slug}\``, '')
    for (const n of g.items) out.push(`- [ ] **${n.n}.** ${mdLine(n.text)} — ${mdLine(n.chat, 50)} · ${since(now - n.at)}`)
  }
  if (count === 0) out.push('Nothing. You are on top of it. ✅')

  const all = board.prompts.filter((p) => now - p.at <= DAY)
  const rows = all.slice(0, DECK_MAX_ROWS)
  out.push('', '## 💬 MY PROMPTS → AI RESULTS', '')
  if (rows.length === 0) {
    out.push('No prompts in the last 24 h.')
  } else {
    out.push('| Time | Chat | My prompt | AI result |', '|---|---|---|---|')
    for (const p of rows) {
      out.push(`| ${whenShort(p.at, now)} | ${mdCell(p.chat, 40)} | ${mdCell(p.text, DECK_PROMPT_MAX)} | ${mdCell(`${statusGlyph(p.status)} ${resultLine(p)}`, DECK_RESULT_MAX)} |`)
    }
    if (all.length > rows.length) out.push('', `_…and ${all.length - rows.length} older in the last 24 h._`)
  }

  if (recentDone.length) {
    const shown = [...recentDone].sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, DECK_MAX_DONE)
    out.push('', `## ✅ DONE (last 24 h, ${recentDone.length})`, '')
    for (const n of shown) out.push(`- ~~**${n.n}.** ${mdLine(n.text)}~~ — ${mdLine(n.chat, 50)} · done ${since(now - (n.doneAt || now))}`)
    if (recentDone.length > shown.length) out.push(`- …and ${recentDone.length - shown.length} more. \`/deck undo last\` puts the last tick back.`)
  }
  out.push('', '---', '_This file rewrites itself. `/deck done 2 5` or `/deck done 3-9` ticks items · `/deck done older` ticks everything older than a week · `/deck undo 2` or `/deck undo last` puts them back._', '')
  return out.join('\n')
}
