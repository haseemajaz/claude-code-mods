// Pure text helpers for Command Deck: summaries, needs-me extraction,
// de-duplication. No `$`, no I/O, so tests can import it directly.

import { redact } from './redact'

// ---------- small text tools ----------

export function clip(s: string, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, Math.max(1, n - 1)).trimEnd() + '…'
}

/** Strips inline markdown (bold, code, links, headings, list markers, quotes). */
export function stripMd(line: string): string {
  return String(line || '')
    .replace(/^\s*>+\s?/, '') // quote
    .replace(/^\s*#{1,6}\s+/, '') // heading
    .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, '') // list marker
    .replace(/^\s*\[[ xX]\]\s+/, '') // checkbox
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** FNV-1a 32-bit, base36: a short stable id. */
export function hashId(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** Lower-case words only: for de-duplication. */
export function normKey(s: string): string {
  return stripMd(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(the|a|an|to|and|then|please|now|just)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function words(s: string): Set<string> {
  return new Set(normKey(s).split(' ').filter((w) => w.length > 1))
}

/** True when two items say the same thing (same words, or ≥ 85% overlap). */
export function isNearDuplicate(a: string, b: string): boolean {
  const ka = normKey(a)
  const kb = normKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  // one contains the other and they are close in length ("2 approve app" / "approve app")
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
  if (short.length >= 6 && long.includes(short) && short.length >= 0.6 * long.length) return true
  const wa = words(a)
  const wb = words(b)
  if (wa.size < 3 || wb.size < 3) return false
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.max(wa.size, wb.size) >= 0.85
}

export function dedupe(items: readonly string[]): string[] {
  const out: string[] = []
  for (const it of items) if (!out.some((o) => isNearDuplicate(o, it))) out.push(it)
  return out
}

// ---------- reply parsing ----------

const LIST = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/
const FENCE = /^\s*(```|~~~)/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}/

/** Labels that open a "needs you" section. */
const NEED_HEAD = /⚠|needs? your attention|needs? you\b|what you (?:do|need to do) now|your (?:choice|call|move|turn|action|decision)|\bowner\b|action(?:s)? (?:needed|required)|manual step|for you to do|you(?:'ll)? need to do/i

/** Phrases that make any line a needs-me item by itself. */
const NEED_INLINE = /\byou need to\b|\byou must\b|\bplease run\b|\btype `|⚠/i

/** Headings that end a needs section (a different section starts). */
const OTHER_HEAD = /✅|💡|📝|ℹ|what worked|got stuck|heads-up|suggested next|next edits|in progress|known gaps|summary|done\b/i

const NOTHING = /^(none|nothing|n\/a|no action|no owner action|nothing needed|nothing for you)\b/i

/** 'strong' for #, bold and emoji labels; 'colon' for a short "Label:" line. */
function headingKind(raw: string): 'strong' | 'colon' | false {
  const line = raw.trim()
  if (!line) return false
  if (/^#{1,6}\s/.test(line)) return 'strong'
  // **Label** or **Label** — text, or **Label:** text
  if (/^\*\*[^*]{2,80}\*\*\s*(?:[:—–-].*)?$/.test(line)) return 'strong'
  // **Label:** text
  if (/^\*\*[^*]{1,80}:\*\*\s*\S/.test(line)) return 'strong'
  if (/^__[^_]{2,80}__\s*(?:[:—–-].*)?$/.test(line)) return 'strong'
  if (LIST.test(line)) return false
  // an emoji-led label line (⚠️ Needs your attention)
  if (/^[☀-➿\u{1F300}-\u{1FAFF}]/u.test(line) && line.length <= 80) return 'strong'
  // short line ending with ':'
  if (line.length <= 80 && /:\s*$/.test(line)) return 'colon'
  return false
}

function isHeadingLine(raw: string): boolean {
  return headingKind(raw) !== false
}

/** The text after a label on a label line ("**⚠️ Owner:** add the key" → "add the key"). */
function afterLabel(raw: string): string {
  const line = raw.trim()
  const bold = line.match(/^(?:\*\*|__)([^*_]+)(?:\*\*|__)\s*(?:[:—–-]\s*)?(.*)$/)
  if (bold) {
    const inner = bold[1] ?? ''
    const rest = bold[2] ?? ''
    // **Label: text** form
    const m = inner.match(/^[^:]{2,60}:\s*(.+)$/)
    if (!rest && m) return m[1] ?? ''
    return rest
  }
  const plain = stripMd(line).match(/^[^:—–]{2,60}[:—–]\s*(.+)$/)
  return plain ? (plain[1] ?? '') : ''
}

function cleanItem(raw: string): string {
  let t = raw
  if (/^\s*\|/.test(t)) {
    t = t
      .split('|')
      .map((c) => stripMd(c))
      .filter(Boolean)
      .join(' — ')
  }
  t = stripMd(t)
    .replace(/^(?:⚠️?|📌|➡️?|🔴|🟡)\s*/u, '')
    .replace(/^(?:needs your attention|action needed|owner)\s*[:—–-]\s*/i, '')
    .trim()
  return t
}

const MAX_ITEM = 200

/**
 * Pulls the things the person must do out of a final reply.
 *
 * 1. Sections: a heading/label line matching NEED_HEAD opens one; its list
 *    items (numbered or bulleted), table rows and plain lines become items,
 *    indented sub-bullets and the first line of a code fence join the step
 *    above. A blank line followed by a non-list line, or another heading,
 *    closes it.
 * 2. Anywhere else: a line with "you need to", "you must", "please run",
 *    "type `" or ⚠ is an item by itself.
 * Code blocks outside a section are ignored. Items are redacted, cut to 200
 * chars and de-duplicated.
 */
export function extractNeeds(reply: string): string[] {
  const lines = String(reply || '').replace(/\r\n?/g, '\n').split('\n')
  const items: string[] = []
  let inSection = false
  let inFence = false
  let fenceTaken = false
  let blankSeen = false
  let lastIndex = -1 // index in items of the last item from a section

  const push = (raw: string): number => {
    const t = cleanItem(raw)
    if (t.length < 3 || NOTHING.test(t)) return -1
    items.push(clip(redact(t), MAX_ITEM))
    return items.length - 1
  }
  const appendToLast = (extra: string) => {
    if (lastIndex < 0) return
    const add = cleanItem(extra)
    if (!add) return
    items[lastIndex] = clip(redact(`${items[lastIndex]} — ${add}`), MAX_ITEM)
  }

  for (const raw of lines) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      fenceTaken = false
      continue
    }
    if (inFence) {
      if (inSection && !fenceTaken && raw.trim()) {
        const code = raw.trim()
        if (lastIndex >= 0) {
          items[lastIndex] = clip(redact(`${items[lastIndex]} \`${code}\``), MAX_ITEM)
        } else {
          lastIndex = push(code)
        }
        fenceTaken = true
      }
      continue
    }
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      blankSeen = true
      continue
    }
    const kind = headingKind(line)
    // inside a needs section a plain "Then run:" line is a step, not a heading
    const heading = kind === 'strong' || (kind === 'colon' && (!inSection || NEED_HEAD.test(line)))
    if (heading) {
      if (NEED_HEAD.test(line) && !(OTHER_HEAD.test(stripMd(line)) && !/⚠|need|owner|you/i.test(line))) {
        inSection = true
        blankSeen = false
        lastIndex = -1
        const tail = afterLabel(line)
        if (tail && !/^[—–-]?\s*(owner actions|decisions|things that need)/i.test(tail)) {
          const idx = push(tail)
          if (idx >= 0) lastIndex = idx
        }
        continue
      }
      inSection = false
      lastIndex = -1
      // a heading can still carry an inline trigger ("**Next:** you need to ...")
      if (NEED_INLINE.test(line) && !/⚠/.test(line)) push(afterLabel(line) || line)
      continue
    }
    if (TABLE_SEP.test(line)) continue
    const isList = LIST.test(line)
    const indent = (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length
    if (inSection) {
      if (blankSeen && !isList && !/^\s*\|/.test(line) && items.length > 0 && lastIndex >= 0) {
        // a paragraph after the list: the section is over
        inSection = false
        lastIndex = -1
      } else {
        blankSeen = false
        if (indent >= 2 && lastIndex >= 0 && (isList || !/^\s*\d/.test(line))) {
          appendToLast(line)
        } else if (/^\s*\|/.test(line) && /\|\s*(step|what|action|#)\s*\|/i.test(line)) {
          // table header row: skip
        } else {
          const idx = push(line)
          if (idx >= 0) lastIndex = idx
        }
        continue
      }
    }
    blankSeen = false
    if (NEED_INLINE.test(line)) push(line)
  }
  return dedupe(items)
}

/**
 * A 1–3 line plain summary of a final reply: lines that start with ✅ or
 * "Done" (or the bullets under a "✅ Done" heading) first; else the first
 * sentence of the first paragraph.
 */
export function summarize(reply: string, maxLines = 3): string[] {
  const lines = String(reply || '').replace(/\r\n?/g, '\n').split('\n')
  const picked: string[] = []
  let inFence = false
  let inDone = false
  for (const raw of lines) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence || !raw.trim()) continue
    const plain = stripMd(raw)
    if (isHeadingLine(raw)) {
      inDone = /✅|^done\b/i.test(plain)
      const tail = inDone ? stripMd(afterLabel(raw)) : ''
      if (tail && !/^what shipped/i.test(tail)) picked.push(tail)
      continue
    }
    if (inDone && LIST.test(raw)) {
      picked.push(plain)
    } else if (/^(✅|✔|☑)/u.test(plain) || /^done\b[:.!—–-]?/i.test(plain)) {
      picked.push(plain.replace(/^(✅|✔️?|☑️?)\s*/u, ''))
    }
    if (picked.length >= maxLines) break
  }
  if (picked.length === 0) {
    inFence = false
    for (const raw of lines) {
      if (FENCE.test(raw)) {
        inFence = !inFence
        continue
      }
      if (inFence || !raw.trim() || /^\s*\|/.test(raw) || TABLE_SEP.test(raw)) continue
      const plain = stripMd(raw)
      if (!plain || /^#{1,6}\s/.test(raw.trim())) continue
      const sentence = plain.match(/^(.+?[.!?])(\s|$)/)
      picked.push(sentence ? (sentence[1] ?? plain) : plain)
      break
    }
  }
  return picked.slice(0, maxLines).map((l) => clip(redact(l), 160)).filter(Boolean)
}

/** "just now", "5m", "2h", "3d" */
export function ago(ms: number): string {
  if (!(ms > 0) || ms < 60000) return 'just now'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** "just now", "5m ago", "2h ago" */
export function since(ms: number): string {
  const a = ago(ms)
  return a === 'just now' ? a : `${a} ago`
}

export function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** "17:05" today, "Sat 17:05" on another day. */
export function whenShort(ts: number, now: number): string {
  return ymd(ts) === ymd(now) ? hhmm(ts) : `${DAYS[new Date(ts).getDay()]} ${hhmm(ts)}`
}

export function ymd(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function basename(p: string): string {
  const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p || ''
}

export function firstLine(s: string): string {
  const l = String(s || '').split(/\r?\n/).find((x) => x.trim()) ?? ''
  return stripMd(l)
}

// ---------- prompt cleaning ----------

/** Blocks the harness or the IDE injects into a prompt: dropped whole. */
const INJECTED = ['browser_instruction', 'system-reminder', 'ide_selection', 'ide_opened_file'] as const

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A tag name with an underscore or a hyphen: a machine wrapper, not prose. */
const WRAPPER_TAG = '[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+'

/**
 * The words the person actually typed, with the blocks the harness wraps
 * around them taken out:
 * - `<browser_instruction>`, `<system-reminder>`, `<ide_selection>`,
 *   `<ide_opened_file>` blocks that start a line go, whole (an unclosed one
 *   at the very start, cut off by a length limit, goes to the end);
 * - `<command-name>` / `<command-message>` go, `<command-args>` keeps its text;
 * - `<pasted_content …>…</pasted_content>` becomes `[pasted text]`;
 * - any other leading `<tag>…</tag>` block whose tag has `_` or `-` goes.
 * A tag mentioned mid-sentence ("strip the `<ide_selection>` block") stays.
 * Returns '' when nothing the person wrote is left.
 */
export function cleanPrompt(input: string): string {
  let t = String(input || '').replace(/\r\n?/g, '\n')
  // pasted text → a marker (self-closing first, so `<x/>` is not read as an opener)
  t = t.replace(/<pasted_content\b[^>]*\/>/gi, '[pasted text]')
  t = t.replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/gi, '[pasted text]')
  // slash-command wrappers: keep the args, drop the rest
  t = t.replace(/<command-args>([\s\S]*?)<\/command-args>/gi, ' $1 ')
  t = t.replace(/<(command-name|command-message)>[\s\S]*?<\/\1>/gi, ' ')
  // injected blocks that start a line
  for (const tag of INJECTED) {
    const name = reEsc(tag)
    t = t.replace(new RegExp(`^[ \\t]*<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>[ \\t]*`, 'gim'), '')
    // cut off before its closing tag (a capped prompt): only when it leads
    const open = new RegExp(`^\\s*<${name}\\b[^>]*>`, 'i')
    if (open.test(t) && !new RegExp(`<\\/${name}>`, 'i').test(t)) t = ''
  }
  // any other leading wrapper block
  const lead = new RegExp(`^\\s*<(${WRAPPER_TAG})\\b[^>]*>[\\s\\S]*?<\\/\\1>`)
  for (let i = 0; i < 20 && lead.test(t); i++) t = t.replace(lead, '')
  return t
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** True for a /deck run, typed or wrapped by the harness. */
export function isDeckPrompt(raw: string): boolean {
  const t = String(raw || '')
  return /^\s*\/deck\b/i.test(t) || /<command-name>\s*\/?deck\s*<\/command-name>/i.test(t)
}

/** A chat's title from its first (clean) prompt. */
export function chatTitle(cleanText: string): string {
  return clip(firstLine(cleanText), 32)
}
