// billing-meter: hours per project, measured from the Claude Code chat files.
//
//  - footer: "2.75 h billable today · shop 1.50", at session start and at most
//    every 5 minutes after a turn
//  - /bill: reports, CSV and Markdown timesheets, projects, rates
// The measuring is engine/billing.py, which also runs on its own.

import type { EngineInterface, Register } from 'claude-code'

import { HELP, PYTHONS, plan, statusLine } from './core'
import { lookForFooter, setFooter, watchFooter } from './footer'
import { homeFolder } from './home'

type $ = EngineInterface

const REFRESH_MS = 5 * 60 * 1000

let sessionId = ''
let home = ''
let python: string | null = null
let lastRefresh = 0
let refreshing = false

function script($: $): string {
  return `${$.plugin.root.replace(/[\\/]+$/, '')}/engine/billing.py`
}

async function run($: $, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  let lastErr = ''
  for (const exe of python ? [python] : PYTHONS) {
    try {
      const r = await $.process.run([exe, '-I', '-X', 'utf8', script($), ...args], {
        // not in the project: a python.exe or a module lying there must not run
        ...(home ? { cwd: home } : {}),
        timeoutMs,
        env: { NoDefaultCurrentDirectoryInExePath: '1' },
      })
      const out = (r.stdout || '').trim()
      const err = (r.stderr || '').trim()
      // the Windows Store alias answers "Python was not found": try the next name
      if (r.exitCode !== 0 && /was not found|9009/i.test(`${err}\n${out}`)) {
        lastErr = err || out
        continue
      }
      python = exe
      if (r.exitCode === 0) return { ok: true, out }
      return { ok: false, out: (err || out || `exit ${r.exitCode}`).split(/\r?\n/).slice(-6).join('\n') }
    } catch (err) {
      lastErr = String(err)
    }
  }
  return { ok: false, out: `billing-meter needs Python 3.9 or newer (tried ${PYTHONS.join(', ')}). ${lastErr}`.trim() }
}

async function refresh($: $): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const r = await run($, ['status'], 120_000)
    setFooter($, r.ok ? statusLine(r.out) : undefined, false)
    lastRefresh = await $.clock.now()
  } catch {
    // no processes here: /bill says so
  } finally {
    refreshing = false
  }
}

export const register: Register = (on) => {
  watchFooter(on)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      home = await homeFolder($)
      await lookForFooter($)
      sessionId = await $.session.id()
      await $.command.register({
        name: 'bill',
        description: 'billing-meter: hours per project from your chats. /bill [range] · /bill export · /bill add · /bill help',
        argumentHint: '[range | export | add | rate | project | help]',
      })
    } catch {
      // the footer still works
    }
    void refresh($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if ((await $.clock.now()) - lastRefresh > REFRESH_MS) void refresh($)
    } catch {
      // never hold up a turn
    }
    return r
  })

  on('command.run', { command: 'bill' }, async ($, e) => {
    if (!sessionId) {
      try {
        sessionId = await $.session.id()
      } catch {
        // stays empty
      }
    }
    const p = plan(e.args ?? '', sessionId)
    if (p.kind === 'help') return { text: HELP }
    if (p.kind === 'error') return { text: p.text }
    const r = await run($, p.args, 300_000)
    if (p.args[0] === 'tag' || p.args[0] === 'config') void refresh($)
    if (!r.ok) return { text: `billing-meter could not finish "${p.title}":\n${r.out}` }
    const isWeek = p.args[0] === 'report' && p.title === 'week'
    return { text: isWeek ? `${r.out}\n\n(/bill today · /bill month · /bill export · /bill help)` : r.out }
  })
}
