import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

// a busy machine needs more than the usual 5 s
const SLOW = { timeoutMs: 30_000 }

const HOME = 'C:/Users/tester'
const DIR = `${HOME}/.claude/zed-mods/command-deck`
const T0 = 1_800_000_000_000
// made-up values in real shapes, put together so no scanner reads them here
const A = 'sbp_' + '0123456789abcdef'.repeat(2)
const B = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'

const REPLY = `## ✅ Done
- Built the deck pane.

## ⚠️ What you do now
1. Run \`npm run migrate\`
2. Restart VS Code.
3. Tick this off with /deck done 1.
`

type World = {
  files: Map<string, { text: string; mtime: number }>
  toasts: string[]
  status: (string | undefined)[]
  opened: string[]
  placed: boolean
  clock: ReturnType<typeof mock.clock>
}

/** The engine hands fs hooks native paths (backslashes on Windows). */
// on Linux and macOS a C:/ path reads as relative, so the engine puts the working folder in front
const slash = (p: string) => p.replace(/\\/g, '/').replace(/^.*\/(?=[A-Z]:\/)/, '')

/** The world beneath the plugin: an in-memory disk, a session, a surface. */
function world(on: On, surfaces: RenderSurface[], sid = 'sess-A'): World {
  const w: World = { files: new Map(), toasts: [], status: [], opened: [], placed: true, clock: mock.clock(on, { now: T0 }) }
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on)
  on('session.id', () => ({ value: sid }))
  on('session.cwd', () => ({ value: 'C:/work/shop' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('fs.read', ($, e) => {
    const f = w.files.get(slash(e.path))
    return f ? { value: f.text } : { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => {
    w.files.set(slash(e.path), { text: e.text, mtime: w.clock.now() + w.files.size })
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const prefix = slash(e.path).replace(/\/$/, '') + '/'
    const entries = [...w.files.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, f]) => ({ name: p.slice(prefix.length), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtime, isLink: false }))
    return entries.length ? { value: entries } : { deny: 'ENOENT' }
  })
  on('fs.exists', ($, e) => {
    const p = slash(e.path).replace(/\/$/, '')
    return { value: [...w.files.keys()].some((k) => k === p || k.startsWith(p + '/')) }
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
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: w.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no room here' } }
  })
  // the engine's own answers for the events the plugin passes on
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return w
}

async function oneTurn($: Engine, text: string, answer: string, turnId: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
  await $.turn.complete({ answer, durationMs: 1200, isAborted: false, turnId, reason: 'answer' })
}

function deck($: Engine, args: string) {
  return $.command.run({ command: 'deck', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

function json(w: World, path: string): any {
  const f = w.files.get(path)
  return f ? JSON.parse(f.text) : undefined
}

test('capture: prompt → result → needs-me, saved to this chat file, toast in this chat', SLOW, async ($, on) => {
  const w = world(on, ['terminal'])
  await $.session.start({ cwd: 'C:/work/shop', surface: 'terminal', isInteractive: true })
  await oneTurn($, 'build the command deck mod\nwith three columns', REPLY, 't1')

  const chat = json(w, `${DIR}/chats/sess-A.json`)
  expect(chat.folder).toBe('shop')
  expect(chat.title).toBe('build the command deck mod')
  expect(chat.prompts.length).toBe(1)
  expect(chat.prompts[0].result.status).toBe('done')
  expect(chat.prompts[0].result.summary).toEqual(['Built the deck pane.'])
  expect(chat.needs.map((n: { text: string }) => n.text)).toEqual([
    'Run npm run migrate',
    'Restart VS Code.',
    'Tick this off with /deck done 1.',
  ])
  expect(w.toasts.some((t) => t.startsWith('📌 New for you: Run npm run migrate'))).toBe(true)
})

test('secrets never reach the disk', SLOW, async ($, on) => {
  const w = world(on, ['terminal'])
  await $.session.start({ cwd: 'C:/work/shop', surface: 'terminal', isInteractive: true })
  await oneTurn($, `use ${A} to deploy`, `⚠️ You need to paste ${B} into the dashboard.`, 't1')
  const all = [...w.files.values()].map((f) => f.text).join('\n')
  expect(all.includes(A)).toBe(false)
  expect(all.includes(B)).toBe(false)
  expect(all.includes('[hidden]')).toBe(true)
})

test('where no pane can be drawn /deck answers with text; done, export', SLOW, async ($, on) => {
  const w = world(on, ['vscode'])
  w.placed = false
  await $.session.start({ cwd: 'C:/work/shop', surface: 'vscode', isInteractive: true })
  await oneTurn($, 'build it', REPLY, 't1')
  const out = await deck($, '')
  expect(w.opened).toEqual(['command-deck'])
  expect(out.text).toContain('## 📌 Needs me (3 open)')
  expect(out.text).toContain('- **1.** Run npm run migrate')
  expect(out.text).toContain('### shop (3)')
  expect(out.text).toContain('✓ done')
  // no footer here, so the count is a status entry
  expect(w.status.at(-1)).toBe('deck 3 to do')

  const done = await deck($, 'done 1')
  expect(done.text).toContain('Done: Run npm run migrate')
  expect(done.text).toContain('2 still need you.')
  const exp = await deck($, 'export all')
  expect(exp.text).toContain('Saved (last 14 days, 2 to do)')
  const file = [...w.files.keys()].find((k) => k.startsWith(`${DIR}/exports/`))
  expect(w.files.get(file!)!.text).toContain('- [x] Run npm run migrate')
})

test('/deck opens the pane where it can; /deck list is text; the terminal has no status entry', SLOW, async ($, on) => {
  const w = world(on, ['terminal'])
  await $.session.start({ cwd: 'C:/work/shop', surface: 'terminal', isInteractive: true })
  await oneTurn($, 'build it', REPLY, 't1')
  expect((await deck($, '')).text).toBe('Deck open · last 24h · 3 to do')
  expect(w.opened).toEqual(['command-deck'])
  expect((await deck($, 'list')).text).toContain('## 📌 Needs me (3 open)')
  expect(w.status.filter(Boolean).length).toBe(0)
})

test('another chat: its needs and its waiting dialog reach this chat by polling', SLOW, async ($, on) => {
  const w = world(on, ['terminal'])
  await $.session.start({ cwd: 'C:/work/shop', surface: 'terminal', isInteractive: true })
  const other = {
    v: 1,
    sid: 'sess-B',
    folder: 'shop-api',
    title: 'fix checkout',
    cwd: 'C:/work/shop-api',
    updatedAt: T0 + 5000,
    waiting: { since: T0 + 5000, what: 'permission for Bash', aliveAt: T0 + 5000 },
    prompts: [{ id: 'p', at: T0 + 1000, text: 'fix checkout' }],
    needs: [{ id: 'x1', at: T0 + 5000, seen: T0 + 5000, text: 'Approve the database migration.' }],
  }
  w.files.set(`${DIR}/chats/sess-B.json`, { text: JSON.stringify(other), mtime: T0 + 5000 })
  await w.clock.advance(8000)
  expect(w.toasts.some((t) => t.includes('shop-api · fix checkout: Approve the database migration.'))).toBe(true)
  expect(w.toasts.some((t) => t.startsWith('⏳ shop-api · fix checkout is waiting for your answer (permission for Bash)'))).toBe(true)
  const out = await deck($, 'done 1')
  expect(out.text).toContain('Done: Approve the database migration.')
  // the tick lives in THIS chat's marks file; the other chat's file is untouched
  expect(json(w, `${DIR}/marks/sess-A.json`).marks.x1.done).toBe(true)
  expect(json(w, `${DIR}/chats/sess-B.json`).needs.length).toBe(1)
})

test('DECK.md is written about 2 s after a turn, from cleaned prompts; ticks from another chat merge on the poll', SLOW, async ($, on) => {
  const w = world(on, ['vscode'])
  await $.session.start({ cwd: 'C:/work/shop', surface: 'vscode', isInteractive: true })
  // the marks folder is made at start, so the 8 s scan never lists a missing folder
  expect(json(w, `${DIR}/marks/sess-A.json`)).toBeDefined()
  const injected = `<browser_instruction># Browser tools\n\nYou can use the browser tools.\n</browser_instruction>\nbuild the deck | with pipes\nsecond line`
  await oneTurn($, injected, REPLY, 't1')
  expect(json(w, `${DIR}/chats/sess-A.json`).title).toBe('build the deck | with pipes')
  expect(json(w, `${DIR}/chats/sess-A.json`).prompts[0].text).toBe('build the deck | with pipes\nsecond line')
  await w.clock.advance(2100)

  const deckFile = () => w.files.get(`${DIR}/DECK.md`)?.text ?? ''
  let md = deckFile()
  expect(md).toMatch(/^# Command Deck — updated \d\d:\d\d\n/)
  expect(md).toContain('## 📌 NEEDS ME (3)')
  expect(md).toContain('- [ ] **1.** Run npm run migrate — shop · build the deck | with pipes · just now')
  expect(md).toContain('- [ ] **2.** Restart VS Code.')
  expect(md).toContain('### shop (3)')
  expect(md).toContain('Tick all: `/deck done group shop`')
  expect(md).toContain('| Time | Chat | My prompt | AI result |')
  expect(md).toContain('| build the deck \\| with pipes second line | ✓ Built the deck pane. |')
  expect(md.includes('browser_instruction')).toBe(false)

  // another chat ticks item 2
  const id2 = json(w, `${DIR}/chats/sess-A.json`).needs[1].id
  const manual = { v: 1, sid: 'sess-Z', updatedAt: T0 + 3000, marks: { [id2]: { done: true, at: T0 + 3000 } } }
  w.files.set(`${DIR}/marks/sess-Z.json`, { text: '\uFEFF' + JSON.stringify(manual), mtime: T0 + 3000 })
  await w.clock.advance(8000)
  md = deckFile()
  expect(md).toContain('## 📌 NEEDS ME (2)')
  expect(md).toContain('- [ ] **1.** Run npm run migrate')
  expect(md).toContain('- [ ] **3.** Tick this off with /deck done 1.')
  expect(md).toContain('- ~~**2.** Restart VS Code.~~')

  // /deck done uses the same stable numbers; a ticked number says so
  const again = await deck($, 'done 2')
  expect(again.text).toContain('Item 2 is already done.')
  const three = await deck($, 'done 3')
  expect(three.text).toContain('Done: Tick this off with /deck done 1.')
})

test('/deck, the pane and the footer give the same count, a waiting chat included', SLOW, async ($, on) => {
  const w = world(on, ['terminal'])
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.modes.join(' · ')] })
  })
  await $.session.start({ cwd: 'C:/work/shop', surface: 'terminal', isInteractive: true })
  await oneTurn($, 'build it', REPLY, 't1')
  const other = { v: 1, sid: 'sess-B', folder: 'api', title: 'limits', cwd: 'C:/work/api', updatedAt: T0, waiting: { since: T0, what: 'permission for Bash', aliveAt: T0 }, prompts: [], needs: [] }
  w.files.set(`${DIR}/chats/sess-B.json`, { text: JSON.stringify(other), mtime: T0 })
  await w.clock.advance(8000)
  expect((await deck($, '')).text).toContain('4 to do')
  const pane = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', requestId: 'command-deck', props: PANE_PROPS(60) })
  expect(await pane.find({ type: 'Text', text: 'NEEDS ME (4)' })).toBeDefined()
  const footer = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ text: 'deck 4 to do' })).toBeDefined()
})

test('a prompt that is only injected text, or a /deck run, is not saved', SLOW, async ($, on) => {
  const w = world(on, ['vscode'])
  await $.session.start({ cwd: 'C:/work/shop', surface: 'vscode', isInteractive: true })
  await $.prompt.submit({ text: '<system-reminder>\nnothing typed\n</system-reminder>', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: '<command-name>/deck</command-name>\n<command-args>done 2</command-args>', wait: false, origin: { kind: 'composer' } })
  expect(json(w, `${DIR}/chats/sess-A.json`)?.prompts?.length ?? 0).toBe(0)
})

const PANE_PROPS = (bodyColumns: number) => ({
  title: 'Command Deck',
  isFocused: false,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

test('pane draws on every surface: wide = three columns, narrow = NEEDS ME first; Done ticks', SLOW, async ($, on) => {
  world(on, ['terminal'])
  await $.session.start({ cwd: 'C:/work/shop', surface: 'terminal', isInteractive: true })
  await oneTurn($, 'build it', REPLY, 't1')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const wide = await $.ui.mount({ plugin: 'command-deck', surface, component: 'Pane', requestId: 'command-deck', props: PANE_PROPS(150) })
    expect(await wide.find({ type: 'Text', text: /^MY PROMPTS/ })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: 'AI RESULTS' })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: 'NEEDS ME (3)' })).toBeDefined()
    await wide.unmount()

    const narrow = await $.ui.mount({ plugin: 'command-deck', surface, component: 'Pane', requestId: 'command-deck', props: PANE_PROPS(48) })
    expect(await narrow.find({ type: 'Text', text: 'NEEDS ME (3)' })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /^MY PROMPTS → AI RESULTS/ })).toBeDefined()
    await narrow.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'vscode', component: 'Pane', requestId: 'command-deck', props: PANE_PROPS(48) })
  const buttons = await ui.findAll({ type: 'Button', text: 'Done' })
  expect(buttons.length).toBe(3)
  await ui.press({ key: buttons[0]!.key! })
  expect(await ui.find({ type: 'Text', text: 'NEEDS ME (2)' })).toBeDefined()
  await ui.unmount()
})

test('the footer shows the count', SLOW, async ($, on) => {
  world(on, ['terminal'])
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.modes.join(' · ')] })
  })
  await $.session.start({ cwd: 'C:/work/shop', surface: 'terminal', isInteractive: true })
  await oneTurn($, 'build it', REPLY, 't1')
  const footer = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ text: 'deck 3 to do' })).toBeDefined()
  await footer.unmount()
})

// ---------------- groups, ranges, undo last ----------------

const DAY = 24 * 60 * 60 * 1000

const CONFIG = {
  projects: [
    { name: 'Shop', folders: ['code/shop'], words: ['checkout', 'invoice'] },
    { name: 'Blog', folders: ['code/blog'], words: ['blog'] },
  ],
}

/** Another chat (in the shop folder) with items of every age; numbers come out oldest first. */
function seedOther(w: World) {
  const needs = [
    ['o1', T0 - 10 * DAY, 'Approve the invoice fix?'],
    ['o2', T0 - 9 * DAY, 'Send the new dates for the blog.'],
    ['o3', T0 - 3 * DAY, 'Open the receipt PDF and check the totals.'],
    ['o4', T0 - 2 * DAY, 'Log in again to the hosting dashboard.'],
    ['o5', T0 - DAY, 'Read the new page and tell me which to remove.'],
    ['o6', T0 - 1000, 'Send the pricing question to support.'],
  ] as const
  const other = {
    v: 1,
    sid: 'sess-B',
    folder: 'shop',
    title: 'shop work',
    cwd: 'C:/code/shop',
    updatedAt: T0,
    waiting: null,
    prompts: [],
    needs: needs.map(([id, at, text]) => ({ id, at, seen: at, text })),
  }
  w.files.set(`${DIR}/config.json`, { text: JSON.stringify(CONFIG), mtime: T0 })
  w.files.set(`${DIR}/chats/sess-B.json`, { text: JSON.stringify(other), mtime: T0 })
}

/** The open items' numbers, read off DECK.md. */
const openNums = (w: World) => [...w.files.get(`${DIR}/DECK.md`)!.text.matchAll(/^- \[ \] \*\*(\d+)\.\*\*/gm)].map((m) => Number(m[1])).sort((a, b) => a - b)

test('/deck groups counts by project, kind and age; /deck list <group>; an ambiguous group lists its matches', SLOW, async ($, on) => {
  const w = world(on, ['vscode'])
  seedOther(w)
  await $.session.start({ cwd: 'C:/work/other', surface: 'vscode', isInteractive: true })
  const g = await deck($, 'groups')
  expect(g.text).toContain('NEEDS ME by group (6 open)')
  expect(g.text).toMatch(/5 {2}Shop +→ \/deck done group shop/)
  expect(g.text).toMatch(/1 {2}Blog +→ \/deck done group blog/)
  expect(g.text).toMatch(/2 {2}Older than a week +→ \/deck done group older/)
  const list = await deck($, 'list shop')
  expect((list.text ?? '').split('\n')[0]).toBe('Shop (5 open), newest first:')
  expect((list.text ?? '').split('\n')[1]).toContain('6. Send the pricing question to support.')
  const amb = await deck($, 'done group week')
  expect(amb.text).toContain('"week" matches 2 groups: age:This week, age:Older than a week')
  expect(json(w, `${DIR}/marks/sess-A.json`).last).toBeUndefined()
})

test('/deck done group ticks a whole group, numbers stay put, /deck undo last brings the group back', SLOW, async ($, on) => {
  const w = world(on, ['vscode'])
  seedOther(w)
  await $.session.start({ cwd: 'C:/work/other', surface: 'vscode', isInteractive: true })
  await w.clock.advance(2100)
  expect(openNums(w)).toEqual([1, 2, 3, 4, 5, 6])
  const out = await deck($, 'done group shop')
  expect(out.text).toBe('Ticked 5 in Shop. 1 still need you. Undo: /deck undo last')
  await w.clock.advance(2100)
  expect(openNums(w)).toEqual([2])
  expect(w.files.get(`${DIR}/DECK.md`)!.text).toContain('## ✅ DONE (last 24 h, 5)')
  expect((await deck($, 'undo last')).text).toBe('Put back 5 items (Shop). 6 need you now.')
  await w.clock.advance(2100)
  expect(openNums(w)).toEqual([1, 2, 3, 4, 5, 6])
  // the same tick is not put back twice
  expect((await deck($, 'undo last')).text).toContain('Nothing to undo')
})

test('/deck done 2-3 and /deck done older; undo last only undoes the last one', SLOW, async ($, on) => {
  const w = world(on, ['vscode'])
  seedOther(w)
  await $.session.start({ cwd: 'C:/work/other', surface: 'vscode', isInteractive: true })
  const r = await deck($, 'done 2-3')
  expect(r.text).toContain('Done: Send the new dates')
  expect(r.text).toContain('Done: Open the receipt PDF')
  expect(r.text).toContain('4 still need you.')
  await w.clock.advance(1000)
  // 2 is older than a week but already ticked: only 1 is left in that group
  expect((await deck($, 'done older')).text).toBe('Ticked 1 in Older than a week. 3 still need you. Undo: /deck undo last')
  expect((await deck($, 'undo last')).text).toBe('Put back 1 item (Older than a week). 4 need you now.')
  await w.clock.advance(2100)
  expect(openNums(w)).toEqual([1, 4, 5, 6])
  // a second undo walks one step further back: the 2-3 range
  expect((await deck($, 'undo last')).text).toBe('Put back 2 items (items 2, 3). 6 need you now.')
  expect((await deck($, 'done 2 x')).text).toContain('Not a number or a range: x')
  expect((await deck($, 'done 99')).text).toContain('No item 99.')
})

test("undo last also puts back another chat's tick", SLOW, async ($, on) => {
  const w = world(on, ['vscode'])
  seedOther(w)
  await $.session.start({ cwd: 'C:/work/other', surface: 'vscode', isInteractive: true })
  await deck($, 'done 1')
  const at = T0 + 5000
  const theirs = { v: 1, sid: 'sess-Z', updatedAt: at, marks: { o5: { done: true, at }, o6: { done: true, at } }, last: { at, ids: ['o5', 'o6'], label: 'two things', count: 2 } }
  w.files.set(`${DIR}/marks/sess-Z.json`, { text: JSON.stringify(theirs), mtime: at })
  await w.clock.advance(8000)
  expect(openNums(w)).toEqual([2, 3, 4])
  expect((await deck($, 'undo last')).text).toBe('Put back 2 items (two things). 5 need you now.')
  expect(json(w, `${DIR}/marks/sess-A.json`).undid).toEqual([`sess-Z:${at}`])
  expect((await deck($, 'undo last')).text).toContain('Put back 1 item (Approve the invoice fix')
})
