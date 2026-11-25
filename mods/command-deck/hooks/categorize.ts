// Command Deck groups: every item gets a Project, a Kind and an Age, so a whole
// group can be ticked at once. Pure and deterministic: patterns over the item
// text and its chat, no model calls, no I/O.
//
// Project: a project from config.json that the item's words name; else the
// chat's project: a configured one its folder or words name, else the name of
// the folder the chat runs in.
// Kind: what you have to do (decide, sign in, run, test, read).
// Age: Today / This week / Older than a week, from when it was first raised.

export const OTHER = 'Other'
export const KINDS = ['Test / check', 'Decide', 'Sign in / keys', 'Run / do', 'Read / FYI', 'Other'] as const
export const AGES = ['Today', 'This week', 'Older than a week'] as const

export type Kind = (typeof KINDS)[number]
export type Age = (typeof AGES)[number]
export type Facet = 'project' | 'kind' | 'age'
export const FACETS: readonly Facet[] = ['project', 'kind', 'age']

export const DAY_MS = 24 * 60 * 60 * 1000

/** A project from config.json: the folders and the words that mean it. */
export type ProjectRule = { name: string; paths: string[]; words: RegExp[] }

let RULES: readonly ProjectRule[] = []

/** Reads config.json's `projects` list: [{ "name": "Shop", "folders": ["code/shop"], "words": ["checkout"] }]. */
export function readProjects(value: unknown): ProjectRule[] {
  const out: ProjectRule[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    const p = raw as { name?: unknown; folders?: unknown; words?: unknown }
    if (!p || typeof p.name !== 'string' || !p.name.trim()) continue
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])
    const words: RegExp[] = []
    for (const w of list(p.words)) {
      const esc = w.trim().replace(/[-.*+?^${}()|[\]\\]/g, (c) => '\\' + c)
      words.push(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu'))
    }
    out.push({ name: p.name.trim(), paths: list(p.folders).map((f) => f.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()), words })
  }
  return out
}

export function setProjects(rules: readonly ProjectRule[]): void {
  RULES = rules
}

/** How many of each project's words the text has. */
export function projectScores(text: string): Map<string, number> {
  const out = new Map<string, number>()
  const t = String(text || '')
  for (const r of RULES) {
    const n = r.words.filter((w) => w.test(t)).length
    if (n) out.set(r.name, n)
  }
  return out
}

/** The configured project a folder belongs to; undefined when none matches. */
export function projectOfPath(cwd: string): string | undefined {
  const p = String(cwd || '').replace(/\\/g, '/').toLowerCase()
  if (!p) return undefined
  return RULES.find((r) => r.paths.some((x) => p.includes(x)))?.name
}

function folderName(cwd: string): string {
  const parts = String(cwd || '').split(/[\\/]+/).filter((x) => x && !/^[A-Za-z]:$/.test(x))
  return parts[parts.length - 1] ?? ''
}

export type ChatFacts = { cwd?: string; title?: string; texts?: readonly string[] }

/** A chat's project: a configured one its folder says, else one its words name most, else its folder's name. */
export function chatProject(c: ChatFacts): string {
  const byPath = projectOfPath(c.cwd || '')
  if (byPath) return byPath
  const votes = new Map<string, number>()
  for (const t of [c.title || '', ...(c.texts || [])]) {
    for (const [p, n] of projectScores(t)) votes.set(p, (votes.get(p) || 0) + n)
  }
  return best(votes) ?? (folderName(c.cwd || '') || OTHER)
}

function best(scores: ReadonlyMap<string, number>, prefer?: string): string | undefined {
  let top: string | undefined
  for (const [p, n] of scores) {
    const most = top === undefined ? 0 : scores.get(top)!
    if (n > most || (n === most && p === prefer)) top = p
  }
  return top
}

/** An item's project: one its own words name (a tie goes to the chat's), else the chat's. */
export function itemProject(text: string, chat: string = OTHER): string {
  return best(projectScores(text), chat) ?? chat
}

// ---------------- kind ----------------

const DECIDE: readonly RegExp[] = [
  /\bpick (?:one|your|an?|which)\b/i,
  /\bchoose (?:one|between)\b/i,
  /\boption [ab]\b/i,
  /^\(?[AB]\)[\s.:]|^[AB][.:]\s|^[AB] \(/,
  /— [AB][.)]\s/,
  /\(\s*[AB]\s*\)/,
  /\byes\s*\/\s*(?:no|change)/i,
  /\bmy (?:pick|advice|suggestion)\b/i,
  /\bi (?:suggest|recommend)\b/i,
  /\bdo you (?:want|keep)\b/i,
  /\bshould i\b/i,
  /\bis (?:that|this) (?:right|fine|ok|correct)\b/i,
  /\btell me (?:which|if|whether|what|the right|when)\b/i,
  /\bwhich\b[^.]*\?/i,
  /\bdecide\b|\bdecision\b|\byour (?:choice|call)\b/i,
  /\bor (?:keep|change|remove)\b/i,
  /\?\s*(?:\([^)]*\))?\s*$/,
  /^approve\b/i,
]

const SIGN_IN: readonly RegExp[] = [
  /\bsign(?:ed)?[ -]?in\b/i,
  /\blog ?in\b(?!\s+as\b)/i,
  /\blogin\b(?!\s+(?:as|emails?)\b)/i,
  /\bauthori[sz]/i,
  /\bconnectors?\b/i,
  /\btokens?\b/i,
  /\bpasswords?\b/i,
  /\b(?:api )?keys?\b/i,
  /\bsecrets?\b/i,
  /\/mcp\b/i,
  /\boauth\b/i,
  /\bcredentials?\b/i,
  /google cloud|console\.cloud/i,
  /\binvite\b/i,
]

const RUN_FIRST: readonly RegExp[] = [/\btick\b/i, /\bnew chat\b/i, /\bopen a terminal\b/i, /\brestart\b/i, /\binstall\b/i, /\bupload\b/i, /\bdelete\b/i, /\bdownload\b/i, /^run\b/i, /\btype\b/i]

const TEST: readonly RegExp[] = [
  /\btry\b/i,
  /\btests?\b/i,
  /\bcheck\b/i,
  /\bverify\b/i,
  /\bglance\b/i,
  /\blisten\b/i,
  /\blook at\b/i,
  /\bhover\b/i,
  /\blog in as\b/i,
  /\bmake sure\b/i,
  /\byou should see\b/i,
  /\bto see\b/i,
  /^(?:see|open|read)\b/i,
  /\bread (?:the|it|them|once)\b/i,
]

const RUN: readonly RegExp[] = [
  /^(?:run|press|tap|click|send|post|print|share|fill|create|make|add|set|go|drag|buy|email|tell|put|move|copy|save|follow|find|ask|give|reply|mark|account|keep|use|stop|start|wait|turn|in the|on the|on your|open)\b/i,
  /→/,
  /\bsteps?\b/i,
  /\byou must\b/i,
  /\bopen (?:the|your)\b/i,
  /\b(?:get|drop|put) it\b/i,
  /\b(?:press|click|tap|resubmit|publish)\b/i,
  /^[^.]{0,40}:\s*(?:steps?|follow|go|open|create|upload|press|send|give|tell|put|post|share|fill|make|type|choose)\b/i,
]

const READ: readonly RegExp[] = [
  /heads-up/i,
  /\bnote\b/i,
  /good to know/i,
  /\bfyi\b/i,
  /^i (?:removed|fixed|kept|also|could not|couldn't|will not|won't|added|made|built|already|split|used)\b/i,
  /\balready\b/i,
  /\bwhat it does\b|\bwhy it\b|\bhow to use\b/i,
  /\bnot counted\b/i,
  /\b(?:is|are) still\b/i,
  /\bsays?\b/i,
  /^know\b/i,
  /^(?:do not|don't)\b/i,
]

const KIND_RULES: readonly [Kind, readonly RegExp[]][] = [
  ['Decide', DECIDE],
  ['Sign in / keys', SIGN_IN],
  ['Run / do', RUN_FIRST],
  ['Test / check', TEST],
  ['Run / do', RUN],
  ['Read / FYI', READ],
]

/** What you have to do with an item; the first rule set that hits wins. */
export function itemKind(text: string): Kind {
  const t = String(text || '').trim()
  for (const [kind, rules] of KIND_RULES) if (rules.some((r) => r.test(t))) return kind
  return 'Other'
}

// ---------------- age ----------------

function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** Today (same calendar day), This week (within 7 days), else Older than a week. */
export function ageOf(at: number, now: number): Age {
  if (sameDay(at, now) || at > now) return 'Today'
  if (now - at <= 7 * DAY_MS) return 'This week'
  return 'Older than a week'
}

// ---------------- group names ----------------

export type GroupRef = { facet: Facet; name: string }

/** A facet's group names; projects come from the board. */
export function facetNames(f: Facet, projects: readonly string[]): readonly string[] {
  return f === 'project' ? projects : f === 'kind' ? KINDS : AGES
}

export function allGroups(projects: readonly string[]): GroupRef[] {
  return FACETS.flatMap((facet) => facetNames(facet, projects).map((name) => ({ facet, name })))
}

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const wordsOf = (s: string) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const FACET_WORDS: Readonly<Record<string, Facet>> = { project: 'project', p: 'project', kind: 'kind', k: 'kind', age: 'age', a: 'age' }

export type GroupMatch = { ok: true; group: GroupRef } | { ok: false; error: string; matches: GroupRef[] }

export function groupLabel(g: GroupRef): string {
  return `${g.facet}:${g.name}`
}

/**
 * A group as typed ("shop", "older", "sign", "kind:other"), matched
 * against every group name: an exact name first, then a name that starts with
 * it, then a word in a name that starts with it. Two matches at the first level
 * that has any is an error listing them. `project:`/`kind:`/`age:` narrows.
 */
export function matchGroup(query: string, projects: readonly string[]): GroupMatch {
  let q = String(query || '').trim()
  let only: Facet | undefined
  const m = q.match(/^([a-z]+)\s*:\s*(.*)$/i)
  if (m && FACET_WORDS[m[1]!.toLowerCase()]) {
    only = FACET_WORDS[m[1]!.toLowerCase()]
    q = m[2] ?? ''
  }
  const nq = norm(q)
  if (!nq) return { ok: false, error: 'Type a group name, like older or decide. /deck groups lists them.', matches: [] }
  const pool = allGroups(projects).filter((g) => !only || g.facet === only)
  const qWords = wordsOf(q)
  const levels: ((g: GroupRef) => boolean)[] = [
    (g) => norm(g.name) === nq,
    (g) => norm(g.name).startsWith(nq),
    (g) => qWords.length > 0 && qWords.every((w) => wordsOf(g.name).some((x) => x.startsWith(w))),
  ]
  for (const test of levels) {
    const hits = pool.filter(test)
    if (hits.length === 1) return { ok: true, group: hits[0]! }
    if (hits.length > 1) {
      return {
        ok: false,
        error: `"${q}" matches ${hits.length} groups: ${hits.map(groupLabel).join(', ')}. Type one of those, like ${hits[0]!.facet}:${wordsOf(hits[0]!.name)[0] ?? ''}.`,
        matches: hits,
      }
    }
  }
  return { ok: false, error: `No group "${q}". /deck groups lists them.`, matches: [] }
}

/** The shortest thing to type for a group: its first word when that is unique, else facet:word. */
export function groupSlug(g: GroupRef, projects: readonly string[]): string {
  const first = wordsOf(g.name)[0] ?? norm(g.name)
  const r = matchGroup(first, projects)
  if (r.ok && r.group.facet === g.facet && r.group.name === g.name) return first
  // two names may share their first word: then the whole name, its words joined
  const narrowed = matchGroup(`${g.facet}:${first}`, projects)
  return narrowed.ok && narrowed.group.name === g.name ? `${g.facet}:${first}` : `${g.facet}:${norm(g.name)}`
}

/** The group an item is in for a facet. */
export function groupOf(item: { project?: string; kind?: string; at: number }, facet: Facet, now: number): string {
  if (facet === 'project') return item.project || OTHER
  if (facet === 'kind') return item.kind || OTHER
  return ageOf(item.at, now)
}

// ---------------- numbers ----------------

/** "3 7 12", "3-9", "3,7", "3–9" → [3, 7, 12] / [3..9]; anything else is returned in `bad`. */
export function parseNumbers(args: readonly string[]): { nums: number[]; bad: string[] } {
  const nums: number[] = []
  const bad: string[] = []
  for (const raw of args) {
    for (const part of String(raw).split(/[,\s]+/).filter(Boolean)) {
      const r = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/)
      if (r) {
        let a = Number(r[1])
        let b = Number(r[2])
        if (a > b) [a, b] = [b, a]
        if (b - a > 2000) {
          bad.push(part)
          continue
        }
        for (let i = a; i <= b; i++) if (i > 0) nums.push(i)
      } else if (/^\d+$/.test(part) && Number(part) > 0) {
        nums.push(Number(part))
      } else {
        bad.push(part)
      }
    }
  }
  return { nums: [...new Set(nums)], bad }
}
