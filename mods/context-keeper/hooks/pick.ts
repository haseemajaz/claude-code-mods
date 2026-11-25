// The capsule index (one per project folder) and the choice of which capsule
// a new chat loads.

import { pathKey } from './text'

export type IndexEntry = {
  sid: string
  title: string
  cwd: string
  slug: string
  updatedAt: number
  turns: number
  ctxPct: number
  topic?: string
  /** the capsule .md, absolute, forward slashes */
  path: string
  /** the chat's transcript JSONL */
  transcript: string
}

export type ProjectIndex = {
  v: 1
  project: string
  slug: string
  updatedAt: number
  chats: Record<string, IndexEntry>
}

const KEEP = 60

export function isIndexEntry(x: unknown): x is IndexEntry {
  if (!x || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  return typeof e.sid === 'string' && typeof e.path === 'string' && typeof e.updatedAt === 'number' && typeof e.cwd === 'string'
}

export function reviveIndex(raw: unknown, cwd: string, slug: string): ProjectIndex {
  const base: ProjectIndex = { v: 1, project: cwd, slug, updatedAt: 0, chats: {} }
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<ProjectIndex>
  const chats: Record<string, IndexEntry> = {}
  for (const [k, v] of Object.entries(r.chats ?? {})) if (isIndexEntry(v)) chats[k] = { ...v, turns: Number(v.turns) || 0, ctxPct: Number(v.ctxPct) || 0, title: String(v.title ?? '') }
  return { ...base, updatedAt: Number(r.updatedAt) || 0, chats }
}

/** The index with this chat's entry put in (or refreshed), the newest KEEP chats kept. */
export function upsertIndex(idx: ProjectIndex, entry: IndexEntry): ProjectIndex {
  const chats = { ...idx.chats, [entry.sid]: entry }
  const sorted = Object.values(chats).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, KEEP)
  return { ...idx, updatedAt: Math.max(idx.updatedAt, entry.updatedAt), chats: Object.fromEntries(sorted.map((e) => [e.sid, e])) }
}

export type PickOptions = {
  cwd: string
  currentSid: string
  /** the chat this process was just in (a /clear): preferred when it has a capsule */
  previousSid?: string
  now: number
  maxAgeMs: number
}

/**
 * The capsule a new chat loads: the chat just cleared if it has one; else the
 * newest capsule of the same project folder. Never the current chat's own,
 * never an empty one, never one older than `maxAgeMs`, never another project's.
 */
export function pickForNewChat(entries: readonly IndexEntry[], o: PickOptions): IndexEntry | undefined {
  const usable = entries.filter((e) => e.sid !== o.currentSid && e.turns > 0 && o.now - e.updatedAt <= o.maxAgeMs)
  if (o.previousSid) {
    const prev = usable.find((e) => e.sid === o.previousSid)
    if (prev) return prev
  }
  const here = pathKey(o.cwd)
  return usable.filter((e) => pathKey(e.cwd) === here).sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Recent capsules across every project, newest first: what /restore numbers. */
export function recentBackups(entries: readonly IndexEntry[], excludeSid: string, limit = 9): IndexEntry[] {
  const seen = new Set<string>()
  return [...entries]
    .filter((e) => e.sid !== excludeSid && e.turns > 0 && !seen.has(e.sid) && (seen.add(e.sid), true))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}
