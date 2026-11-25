import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// a busy machine needs more than the usual 5 s
const SLOW = { timeoutMs: 30_000 }

const CWD = 'C:/work/shop'
const HOME = 'C:/Users/tester'
const FOLDER = `${HOME}/.claude/zed-mods/done-check`
const LOG = `${FOLDER}/log`
const NOON = new Date(2026, 9, 4, 12, 0).getTime()

type World = {
  files: Map<string, string>
  store: Map<string, unknown>
  statuses: (string | undefined)[]
  toasts: string[]
  failWrites: boolean
}

/** The engine hands file hooks the platform's spelling, backslashes on Windows. */
// on Linux and macOS a C:/ path reads as relative, so the engine puts the working folder in front
const slash = (p: string) => p.replace(/\\/g, '/').replace(/^.*\/(?=[A-Z]:\/)/, '')

/** What stands beneath the mod: session, files, commands, drawing, tools. */
function world(on: On, config?: object, env: Record<string, string> = { USERPROFILE: HOME }): World {
  const w: World = { files: new Map(), store: new Map(), statuses: [], toasts: [], failWrites: false }
  const value = <T,>(v: T) => ({ value: v })
  mock.env(on, env)
  mock.clock(on, { now: NOON })
  if (config) w.files.set(`${FOLDER}/config.json`, JSON.stringify(config))
  on('store.get', (_$, e) => value(w.store.get(e.key)))
  on('store.set', (_$, e) => {
    w.store.set(e.key, e.value)
    return value(undefined)
  })
  on('session.id', () => value('00000000-1111-4222-8333-444444444444'))
  on('session.cwd', () => value(CWD))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => value({ command: e.name }))
  on('fs.exists', (_$, e) => value(w.files.has(slash(e.path))))
  on('fs.read', (_$, e) => {
    const text = w.files.get(slash(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return value(text)
  })
  on('fs.write', (_$, e) => {
    if (w.failWrites) throw new Error('EACCES: permission denied')
    w.files.set(slash(e.path), e.text)
    return value(undefined)
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return value(undefined)
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return value(undefined)
  })
  on('ui.log', () => value(undefined))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('classic.Stop', () => ({}))
  // a Bash command fails when it contains FAIL
  on('tool.call', (_$, e) => {
    const args = e as unknown as Record<string, unknown>
    if (String(e.tool) === 'Bash' && String(args.command).includes('FAIL')) {
      return { result: 'Exit code 1', text: 'Exit code 1', isError: true as const }
    }
    return { result: { ok: true }, text: 'ok' }
  })
  return w
}

const done = ($: Engine, args: string) =>
  $.command.run({ command: 'done', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

let turnId = 0
async function begin($: Engine, prompt: string, calls: Array<Record<string, unknown>>): Promise<string> {
  const id = `t${++turnId}`
  await $.prompt.submit({ text: prompt, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: prompt, turnId: id })
  for (const c of calls) await $.tool.call(c as never)
  return id
}

async function turn($: Engine, prompt: string, calls: Array<Record<string, unknown>>, answer = '✅ Done') {
  const id = await begin($, prompt, calls)
  await $.turn.complete({ answer, durationMs: 42000, isAborted: false, turnId: id, reason: 'answer' })
}

const stop = ($: Engine, more: object = {}) =>
  $.classic.Stop({
    hook_event_name: 'Stop',
    session_id: 's',
    transcript_path: '',
    cwd: CWD,
    stop_hook_active: false,
    ...more,
  } as never) as Promise<{ block?: string }>

const edit = (p: string) => ({ tool: 'Edit', file_path: p, old_string: 'a', new_string: 'b' })
const bash = (command: string) => ({ tool: 'Bash', command, description: 'x' })
const last = (w: World) => w.statuses[w.statuses.length - 1]
const logText = (w: World) => [...w.files].find(([p]) => p.startsWith(LOG))?.[1] ?? ''

test('an edit with no check raises the flag, and the next prompt carries the note', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, 'Fix the header colour', [edit(`${CWD}/src/Header.tsx`)])
  expect(last(w)).toBe('unverified · 1 file · /done')
  const sent = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(sent.context?.join('\n') ?? '').toContain('ran no build, test or check')
  // nothing is written to disk unless the work log is on
  expect([...w.files.keys()]).toEqual([])
})

test('a check after the edit: no flag, "verified ✓" in the footer', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, 'edit and build', [edit(`${CWD}/a.ts`), bash('cd app && npm run build')])
  expect(last(w)).toBeUndefined()
  const footer = await $.ui.mount({ plugin: 'done-check', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  const mark = await footer.find({ type: 'Text', text: 'verified ✓' })
  expect(mark?.props.color).toBe('green')
  const sent = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(sent.context ?? []).toHaveLength(0)
})

test('a build before the last edit does not count', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, 'build then edit', [bash('npm run build'), edit(`${CWD}/a.ts`)])
  expect(last(w)).toBe('unverified · 1 file · /done')
})

test('a failing check shows by name', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, 'edit and test', [edit(`${CWD}/a.ts`), bash('npm test -- FAIL')])
  expect(last(w)).toBe('check failed: npm test -- FAIL')
})

test('insist mode sends Claude back once, and only when a check is missing', SLOW, async ($, on) => {
  world(on)
  await start($)
  await done($, 'insist on')
  await begin($, 'edit', [edit(`${CWD}/a.ts`)])
  expect((await stop($)).block).toContain('ran no build, test or check')
  // the second stop of the same turn goes through
  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  // a check ran: nothing to insist on
  await begin($, 'edit', [edit(`${CWD}/a.ts`), bash('npm test')])
  expect((await stop($)).block).toBeUndefined()
  // a question turn changed nothing
  await begin($, 'what is this?', [{ tool: 'Read', file_path: 'a.ts' }])
  expect((await stop($)).block).toBeUndefined()
})

test('without insist mode Claude may always stop', SLOW, async ($, on) => {
  world(on)
  await start($)
  await begin($, 'edit', [edit(`${CWD}/a.ts`)])
  expect((await stop($)).block).toBeUndefined()
})

test('/done dismiss lowers the flag; /done lists the turns', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, 'what is in README?', [{ tool: 'Read', file_path: 'README.md' }], 'It says hello.')
  await turn($, 'edit', [edit(`${CWD}/a.ts`)])
  const out = await done($, '')
  expect(out.text).toContain('done-check is ON · insist off · work log off')
  expect(out.text).toMatch(/ {2}2 {2}\d\d:\d\d {8}1 {2}no {8}- {7}edit/)
  await done($, 'dismiss')
  expect(last(w)).toBeUndefined()
  const sent = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(sent.context ?? []).toHaveLength(0)
})

test('/done off mutes everything and is remembered', SLOW, async ($, on) => {
  const w = world(on)
  await start($)
  await done($, 'insist on')
  await turn($, 'edit', [edit(`${CWD}/a.ts`)])
  await done($, 'off')
  expect(last(w)).toBeUndefined()
  await begin($, 'edit', [edit(`${CWD}/a.ts`)])
  expect((await stop($)).block).toBeUndefined()
  expect(w.store.get('on')).toBe(false)
})

test('config.json adds checks and ignored paths, and turns the log on', SLOW, async ($, on) => {
  const w = world(on, { checks: ['^\\./verify\\.sh'], ignore: ['generated/'], log: true })
  await start($)
  await turn($, 'edit', [edit(`${CWD}/generated/x.ts`)])
  expect(last(w)).toBeUndefined()
  await turn($, 'edit', [edit(`${CWD}/a.ts`), bash('./verify.sh --all')])
  expect(last(w)).toBeUndefined()
  expect(logText(w)).toContain('- **Verified:** yes: `./verify.sh --all`')
})

test('CLAUDE_CONFIG_DIR moves the folder', SLOW, async ($, on) => {
  const w = world(on, undefined, { USERPROFILE: HOME, CLAUDE_CONFIG_DIR: 'D:\\cc' })
  await start($)
  await done($, 'log on')
  await turn($, 'edit', [edit(`${CWD}/a.ts`)])
  expect([...w.files.keys()][0]).toMatch(/^D:\/cc\/zed-mods\/done-check\/log\/2026-10-04\.md$/)
})

test('the work log keeps secrets out', SLOW, async ($, on) => {
  const w = world(on, { log: true })
  await start($)
  await turn(
    $,
    'use token ghp_' + 'Ab1'.repeat(12) + ' to push',
    [edit(`${CWD}/src/a.ts`), bash('git push')],
    '✅ Pushed, DB_PASSWORD=' + 'Qx7pLm2vRt9k set',
  )
  const log = logText(w)
  expect(log).toContain('## 12:00 · shop · session 00000000 · 2 tool calls · 42s')
  expect(log).toContain('`src/a.ts`')
  expect(log).not.toContain('ghp_')
  expect(log).not.toContain('Qx7pLm2vRt9k')
})

test('a log that cannot be written says so once and the turn carries on', SLOW, async ($, on) => {
  const w = world(on, { log: true })
  w.failWrites = true
  await start($)
  await turn($, 'one', [edit(`${CWD}/a.ts`)])
  await turn($, 'two', [edit(`${CWD}/b.ts`)])
  expect(w.toasts).toHaveLength(1)
  expect((await done($, '')).text).toContain('2 turns')
})
