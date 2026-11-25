// The mod loaded by the engine, over an in-memory disk: a new chat receives
// the right capsule, a resumed one does not, /clear hands the cleared chat's
// capsule on, turns write redacted capsules, the model failing leaves the
// extract, /restore loads a capsule into the chat.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, SessionMessage } from 'claude-code'

// a busy machine needs more than the usual 5 s
const SLOW = { timeoutMs: 30_000 }

const HOME = 'C:/Users/tester'
const DIR = `${HOME}/.claude/zed-mods/context-keeper`
const CWD = 'C:/work/my project'
const T0 = Date.parse('2026-10-16T10:00:00')
// a made-up value in a real shape, put together so no scanner reads it here
const FAKE = 'ghp_' + '0123456789abcdef0123'
const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = {
  files: Map<string, string>
  toasts: string[]
  status: (string | undefined)[]
  msgs: SessionMessage[]
  turns: number
  ctx: number
  modelCalls: number
  model: () => ModelCompleteResult
  clock: ReturnType<typeof mock.clock>
  setId: (s: string) => void
  surfaces: ('terminal' | 'vscode')[]
}

// on Linux and macOS a C:/ path reads as relative, so the engine puts the working folder in front
const slash = (p: string) => p.replace(/\\/g, '/').replace(/^.*\/(?=[A-Z]:\/)/, '')

function world(on: On, config?: object): World {
  const w: World = {
    files: new Map(),
    toasts: [],
    status: [],
    msgs: [],
    turns: 0,
    ctx: 40_000,
    modelCalls: 0,
    model: () => ({ isAnswered: false, reason: 'empty-reply', usage: USAGE }),
    clock: mock.clock(on, { now: T0 }),
    surfaces: ['vscode'],
    setId: (s) => {
      id = s
    },
  }
  let id = 'sess-A'
  if (config) w.files.set(`${DIR}/config.json`, JSON.stringify(config))
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on)
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.root', () => ({ value: CWD }))
  on('session.turns', () => ({ value: w.turns }))
  on('session.messages', () => ({ value: w.msgs }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { tokens: w.ctx, window: 200_000, percent: Math.round(w.ctx / 2000) }, rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-16T15:00:00' }] } }))
  on('model.complete', () => {
    w.modelCalls++
    return { value: w.model() }
  })
  on('fs.read', ($, e) => {
    const f = w.files.get(slash(e.path))
    return f === undefined ? { deny: 'ENOENT' } : { value: f }
  })
  on('fs.write', ($, e) => {
    w.files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(slash(e.path)) }))
  on('fs.list', ($, e) => {
    const prefix = slash(e.path).replace(/\/$/, '') + '/'
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of w.files.keys()) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      const i = rest.indexOf('/')
      names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
    }
    if (!names.size) return { deny: 'ENOENT' }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('classic.SessionStart', () => ({}))
  return w
}

/** A previous chat in the same folder, already backed up. */
function seedPrevious(w: World, sid: string, title: string, ageMs: number, cwd = CWD) {
  const slug = cwd.split('/').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const path = `${DIR}/capsules/${slug}/${sid}.md`
  w.files.set(path, `# Context capsule · ${title}\n- Chat ${sid}\n\n## Goal\nShip the ${title} change.\n`)
  const idxPath = `${DIR}/capsules/${slug}/index.json`
  const idx = w.files.has(idxPath) ? JSON.parse(w.files.get(idxPath)!) : { v: 1, project: cwd, slug, updatedAt: 0, chats: {} }
  idx.chats[sid] = { sid, title, cwd, slug, updatedAt: T0 - ageMs, turns: 6, ctxPct: 50, path, transcript: `${HOME}/.claude/projects/x/${sid}.jsonl` }
  w.files.set(idxPath, JSON.stringify(idx))
}

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['vscode' as const], tools: [], outputStyle: null, traits: [] }

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'vscode', isInteractive: true })
}

async function turn($: Engine, w: World, text: string, answer: string, id: string, extra: SessionMessage['toolUses'] = []) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId: id })
  w.msgs.push({ role: 'user', text, toolUses: [] }, { role: 'assistant', text: answer, toolUses: extra })
  w.turns++
  await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: id, reason: 'answer' })
  await w.clock.advance(50)
}

function cmd($: Engine, command: string, args = '') {
  return $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

test('a new chat receives the newest capsule of its folder as one session section', SLOW, async ($, on) => {
  const w = world(on)
  seedPrevious(w, 'old-chat', 'Release notes', 5 * 3_600_000)
  seedPrevious(w, 'prev-chat', 'Shop app · fix rounding', 20 * 60_000)
  seedPrevious(w, 'other-proj', 'Blog', 60_000, 'C:/work/blog')
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const last = r.sections[r.sections.length - 1]!
  expect(last.id).toBe('context-keeper:backup')
  expect(last.scope).toBe('session')
  expect(last.text.startsWith('# Backup from your previous chat (Shop app · fix rounding, 2026-10-16 09:40)')).toBe(true)
  expect(last.text).toContain(`${HOME}/.claude/projects/x/prev-chat.jsonl`)
  expect(last.text).toContain('Ship the Shop app · fix rounding change.')
  // the same text every request: the prompt cache is never broken by it
  const again = await $.prompt.compose(COMPOSE)
  expect(again.sections[again.sections.length - 1]!.text).toBe(last.text)
  // keeping going is no news: nothing in the status line
  expect(w.status.filter(Boolean)).toEqual([])
})

test('a resumed chat gets no section', SLOW, async ($, on) => {
  const w = world(on)
  w.turns = 4
  seedPrevious(w, 'prev-chat', 'Shop app', 60_000)
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections.map((s) => s.id)).toEqual(['intro'])
})

test('turns write a redacted capsule and an index, with no model call by default', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, w, 'Fix the shop checkout bug.\nAlways run the tests.', `## ✅ Done\nFixed. Key used: ${FAKE}\n## ⚠️ Needs your attention\n- Approve the staging deploy.`, 't1', [
    { tool_use_id: 'u1', tool: 'Edit', input: { file_path: 'C:\\work\\shop-app\\src\\pay.ts' } },
  ])
  await turn($, w, 'also check the receipt PDF', 'Checked.', 't2')
  const md = w.files.get(`${DIR}/capsules/my-project/sess-A.md`)!
  expect(md).toContain('Fix the shop checkout bug.')
  expect(md).toContain('- C:/work/shop-app/src/pay.ts (edited ×1)')
  expect(md).toContain('- Always run the tests.')
  expect(md).not.toContain(FAKE)
  expect(md).toContain('- Summary: automatic extract (no model)')
  const idx = JSON.parse(w.files.get(`${DIR}/capsules/my-project/index.json`)!)
  expect(idx.chats['sess-A'].turns).toBe(2)
  for (const s of w.status) expect(String(s).length <= 40).toBe(true)
  expect(w.modelCalls).toBe(0)
  const out = await cmd($, 'backup')
  expect(out.text).toContain('Backup saved: ~/.claude/zed-mods/context-keeper/capsules/my-project/sess-A.md')
  expect(w.modelCalls).toBe(0)
})

test('useModel: a failing model keeps the extract, a working one writes the summary', SLOW, async ($, on) => {
  const w = world(on, { useModel: true })
  await start($)
  await turn($, w, 'Fix the shop checkout bug.', 'Fixed.', 't1')
  expect(w.modelCalls).toBe(0)
  await turn($, w, 'also check the receipt PDF', 'Checked.', 't2')
  expect(w.modelCalls).toBe(1)
  const path = `${DIR}/capsules/my-project/sess-A.md`
  expect(w.files.get(path)!).toContain('- Summary: automatic extract (no model)')
  w.model = () => ({ isAnswered: true, text: '## Goal\nFix the checkout.\n## Decisions made\n- none recorded\n## Current state\nFixed, PDF checked.\n## Open tasks / next steps\n- Approve staging deploy.\n## Preferences\n- none recorded', usage: USAGE })
  const out = await cmd($, 'backup')
  expect(out.text).toContain('summary by haiku')
  expect(w.files.get(path)!).toContain('- Summary: haiku,')
  expect(w.files.get(path)!).toContain('Fix the checkout.')
})

test('the coach toasts once when the advice changes to compact', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  w.ctx = 150_000
  await turn($, w, 'keep building the shop order export', 'Working on it, next I will add the CSV.', 't1')
  expect(w.status.at(-1)).toBe('Coach: /compact · 75%')
  expect(w.toasts.filter((t) => t.includes('Compact now')).length).toBe(1)
  await turn($, w, 'continue the shop export', 'Still going, next I will add tests.', 't2')
  expect(w.toasts.filter((t) => t.includes('Compact now')).length).toBe(1)
  const coach = await cmd($, 'coach')
  expect(coach.text).toContain("Coach: Compact now (/compact) · 75% context, but the task isn't finished")
  expect(coach.text).toContain('- Context: 150k tokens of 200k (75% of the window)')
})

test('/clear hands the cleared chat its own capsule; /restore loads one by number', SLOW, async ($, on) => {
  const w = world(on)
  seedPrevious(w, 'older', 'Release notes', 2 * 3_600_000)
  await start($)
  await turn($, w, 'Fix the shop checkout bug', '## ✅ Done\nFixed.', 't1')
  await $.session.end({ reason: 'clear', sessionId: 'sess-A', resume: { id: 'sess-A' } })
  w.setId('sess-B')
  w.turns = 0
  w.msgs = []
  await $.classic.SessionStart({ source: 'clear', session_id: 'sess-B' })
  const r = await $.prompt.compose(COMPOSE)
  const last = r.sections[r.sections.length - 1]!
  expect(last.id).toBe('context-keeper:backup')
  expect(last.text).toContain('Backup from your previous chat (Fix the shop checkout bug')

  const list = await cmd($, 'restore')
  expect(list.text).toContain('1. Fix the shop checkout bug')
  expect(list.text).toContain('2. Release notes')
  const load = await cmd($, 'restore', '2')
  expect(load.text).toContain('Loaded "Release notes"')
  expect(load.context?.[0]).toContain('# Backup from your previous chat (Release notes,')
  const bad = await cmd($, 'restore', '9')
  expect(bad.text).toContain('No backup number 9')
})

test('copyTo keeps a second copy; autoLoad false gives a new chat nothing', SLOW, async ($, on) => {
  const w = world(on, { copyTo: 'D:\\notes\\capsules', autoLoad: false })
  seedPrevious(w, 'prev-chat', 'Shop app', 60_000)
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections.map((s) => s.id)).toEqual(['intro'])
  await turn($, w, 'Fix the shop checkout bug', 'Fixed.', 't1')
  expect([...w.files.keys()]).toContain('D:/notes/capsules/2026-10-16/my-project--sess-A.md')
})
