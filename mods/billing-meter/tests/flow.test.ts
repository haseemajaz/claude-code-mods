import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// a busy machine needs more than the usual 5 s
const SLOW = { timeoutMs: 30_000 }

type Run = { argv: string[]; cwd?: string }

/** What stands beneath the mod; `answer` plays the Python engine. */
function world(on: On, answer: (argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string }) {
  const w = { runs: [] as Run[], statuses: [] as (string | undefined)[], clock: mock.clock(on, { now: Date.UTC(2026, 9, 4, 10, 0) }) }
  mock.env(on, { USERPROFILE: 'C:/Users/tester' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.modes.join(' · ')] })
  })
  on('process.run', (_$, e) => {
    w.runs.push({ argv: [...e.argv], cwd: e.init?.cwd })
    return { value: { ...answer(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/code/shop', surface: 'terminal', isInteractive: true })
const bill = ($: Engine, args: string) => $.command.run({ command: 'bill', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

test('the footer shows today, read from the engine', SLOW, async ($, on) => {
  const w = world(on, () => ok('1.25 h billable today · shop 1.25\n'))
  await start($)
  // the first reading is not awaited by the session: give it a few turns of the engine
  for (let i = 0; i < 10; i++) await bill($, 'today')
  const footer = await $.ui.mount({ plugin: 'billing-meter', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ text: '1.25 h billable today · shop 1.25' })).toBeDefined()
  expect(w.runs[0]!.argv.slice(4).map((a) => a.replace(/\\/g, '/'))[0]).toMatch(/billing-meter\/engine\/billing\.py$/)
  // hours are no warning: nothing in the status line
  expect(w.statuses.filter(Boolean)).toEqual([])
})

test('Python starts outside the project, and takes nothing from its environment', SLOW, async ($, on) => {
  const w = world(on, () => ok('HI'))
  await start($)
  await bill($, 'today')
  for (const r of w.runs) {
    // a python.exe or a sitecustomize.py in the project must not run
    expect(String(r.cwd).replace(/\\/g, '/')).toBe('C:/Users/tester')
    expect(r.argv.slice(1, 4)).toEqual(['-I', '-X', 'utf8'])
  }
})

test('/bill passes its arguments on and shows the answer', SLOW, async ($, on) => {
  const w = world(on, (argv) => ok(argv.includes('report') ? 'REPORT' : ''))
  await start($)
  const out = await bill($, 'last-month shop')
  expect(out.text).toBe('REPORT')
  expect(w.runs.at(-1)!.argv.slice(5)).toEqual(['report', '--range', 'last-month', '--project', 'shop'])
})

test('the next Python name is tried when one is missing, and no Python says so', SLOW, async ($, on) => {
  const w = world(on, (argv) => (argv[0] === 'python3' ? ok('HI') : { exitCode: 9009, stdout: '', stderr: 'Python was not found' }))
  await start($)
  expect((await bill($, 'today')).text).toBe('HI')
  expect(w.runs.at(-1)!.argv[0]).toBe('python3')
})

test('no Python at all', SLOW, async ($, on) => {
  world(on, () => ({ exitCode: 9009, stdout: '', stderr: 'Python was not found' }))
  await start($)
  expect((await bill($, 'today')).text).toContain('needs Python 3.9 or newer')
})
