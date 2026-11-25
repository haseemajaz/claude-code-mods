// Small text helpers shared by the coach and the capsule.
// Pure functions only: no `$`, so the tests import them directly.

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

export function clip(text: string, max: number): string {
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

export function oneLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function slash(p: string): string {
  return String(p ?? '').replace(/\\/g, '/')
}

/** Folder keys compare case-insensitively with forward slashes and no trailing slash. */
export function pathKey(p: string): string {
  return slash(p).replace(/\/+$/, '').toLowerCase()
}

export function basename(p: string): string {
  const parts = slash(p).replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** A readable folder name for a project: the last path segment, lowercased, dashes. */
export function projectSlug(cwd: string): string {
  const base = basename(cwd) || 'session'
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session'
}

/** Claude Code's own folder name for a project's transcripts: every non-alphanumeric becomes '-'. */
export function transcriptSlug(cwd: string): string {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')
}

export function two(n: number): string {
  return String(n).padStart(2, '0')
}

export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

export function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function stamp(ms: number): string {
  return `${ymd(ms)} ${hhmm(ms)}`
}

export function ago(now: number, then: number): string {
  const d = Math.max(0, now - then)
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.round(d / MIN)} min ago`
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`
  return `${Math.round(d / DAY)} d ago`
}

export function tokens(n: number): string {
  const v = Math.max(0, Math.round(n || 0))
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M'
  if (v >= 1000) return Math.round(v / 1000) + 'k'
  return String(v)
}

/** A reset time as the person reads it: "15:00" today, "Tue 09:00" later. */
export function resetText(now: number, iso: string | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  if (ymd(t) === ymd(now)) return hhmm(t)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(t).getDay()]
  return `${day} ${hhmm(t)}`
}

/**
 * What the person typed, without the blocks the engine and the IDE wrap around
 * it (`<system-reminder>`, `<ide_selection>`, `<command-name>` ...).
 */
export function cleanPrompt(text: string): string {
  let s = String(text ?? '')
  s = s.replace(/<([a-zA-Z_][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
  s = s.replace(/<\/?[a-zA-Z_][\w-]*(\s[^>]*)?\/?>/g, ' ')
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** "capsules/shop/<id>.md": the path inside the mod's own folder. */
export function shortCapsulePath(path: string): string {
  const p = slash(path)
  const i = p.toLowerCase().indexOf('/capsules/')
  return i >= 0 ? p.slice(i + 1) : p
}

// ---------------------------------------------------------------- keywords

const STOP = new Set(
  'about above after again also always another because been before being below between both cannot could does doing done down each every from have having here into itself just like make more most much must need never only other over same should some such than that their them then there these they this those through under until very want what when where which while will with would your yours please thanks thank okay good great can just still sure lets let use using used now new add fix check make sure also file files code thing things work working right well know think need needs'.split(
    ' ',
  ),
)

export function keywords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of String(text ?? '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w)
  }
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / (a.size + b.size - both)
}
