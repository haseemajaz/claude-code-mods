// done-check: says so when Claude finishes a turn that changed code without
// running a build, a test or a check after the last change.
//
// - The footer says "verified ✓" in green; the status line says
//   "unverified · 2 files" or "check failed: npm test".
// - While that flag is up, the next prompt carries one hidden note for Claude.
//   It rides the prompt, not the system prompt, so the prompt cache stays warm.
// - /done insist on: Claude is sent back once, before it may stop, to run a check.
// - /done log on: one entry per turn in a local day file.
// Nothing leaves this computer.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DoneCheckTurn, DoneCheckVerdict } from '../types'
import {
  EDIT_TOOLS,
  NO_EXTRA,
  appendEntry,
  checkCommand,
  clip,
  insistText,
  isCheckTool,
  isScratch,
  judge,
  ledgerEntry,
  ledgerPath,
  localTime,
  newTurn,
  nudgeText,
  patterns,
  shellWrites,
  shouldLog,
  statusText,
  turnsTable,
  verifiedWord,
} from './core'
import type { Extra, Mode, TurnRecord } from './core'
import { homeFolder, modFolder, readSettings, slashed, strings, tilde } from './home'
import { redact } from './redact'

const verdictAtom = atom({ plugin: 'done-check', key: 'verdict' } as const, null as DoneCheckVerdict | null)
const dismissedAtom = atom({ plugin: 'done-check', key: 'dismissed' } as const, false)
const turnsAtom = atom({ plugin: 'done-check', key: 'turns' } as const, [] as DoneCheckTurn[])

const SHELLS = new Set(['Bash', 'PowerShell'])
const SWITCHES = ['on', 'insist', 'log'] as const

// This session's state in the module; a reload starts it over. The verdict and
// the /done list live in $.state and survive that.
let current: TurnRecord | null = null
let seq = 0
let pendingPrompt = ''
let sessionId = ''
let cwd = ''
let logFolder = ''
let home = ''
let logFailed = false
let extra: Extra = NO_EXTRA
let mode: Mode = { on: true, insist: false, log: false }

async function showStatus($: EngineInterface): Promise<void> {
  const v = await read($, verdictAtom)
  const dismissed = await read($, dismissedAtom)
  const show = mode.on && v && !dismissed && v.kind !== 'verified'
  $.ui.status(show ? (statusText(v) ?? undefined) : undefined)
}

/** config.json first, then whatever /done last switched. */
async function loadMode($: EngineInterface): Promise<void> {
  home = await homeFolder($)
  const folder = await modFolder($, 'done-check')
  const set = await readSettings($, folder)
  extra = { checks: patterns(strings(set.checks)), tools: patterns(strings(set.tools)), ignore: strings(set.ignore) }
  logFolder = typeof set.logFolder === 'string' && set.logFolder.trim() ? slashed(set.logFolder).replace(/^~(?=$|\/)/, home) : folder ? `${folder}/log` : ''
  mode = { on: set.on !== false, insist: set.insist === true, log: set.log === true }
  for (const key of SWITCHES) {
    const stored = await $.store.get(key)
    if (typeof stored === 'boolean') mode = { ...mode, [key]: stored }
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      sessionId = await $.session.id()
      cwd = await $.session.cwd()
      await loadMode($)
      await $.command.register({
        name: 'done',
        description: 'done-check: which turns were verified; switch the flag, insist mode or the work log',
        argumentHint: '[on|off|dismiss|insist on|off|log on|off]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`done-check: setup failed (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
    }
    return r
  })

  // The prompt as typed, and the note while the last turn's flag is up.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId) return next(e)
    pendingPrompt = e.text
    const [v, dismissed] = await Promise.all([read($, verdictAtom), read($, dismissedAtom)])
    const note = mode.on && v && !dismissed ? nudgeText(v) : null
    if (!note) return next(e)
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    current = newTurn(e.text || pendingPrompt, await $.clock.now())
    pendingPrompt = ''
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const turn = current
    if (!turn) return next(e)
    const tool = String(e.tool)
    turn.calls += 1
    const args = e as unknown as Record<string, unknown>
    const command = SHELLS.has(tool) && typeof args.command === 'string' ? args.command : ''
    const check = command ? checkCommand(command, extra) : isCheckTool(tool, extra) ? toolLabel(tool, args) : null
    const checkSeq = check ? ++seq : 0
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (check) {
      // a check sent to the background has no result yet, so it proves nothing
      const result = ran.result as { backgroundTaskId?: unknown } | undefined
      const inBackground = !ran.isError && !!result && typeof result === 'object' && !!result.backgroundTaskId
      if (!inBackground) turn.checks.push({ cmd: check, seq: checkSeq, ok: !ran.isError })
    }
    if (EDIT_TOOLS.has(tool) && !ran.isError) {
      const path = String(args.file_path ?? args.notebook_path ?? '')
      if (path && !isScratch(path, extra)) turn.files.set(path, ++seq)
    }
    if (command) {
      const writes = shellWrites(command, extra)
      if (writes.length) {
        const at = ++seq
        for (const w of writes) turn.files.set(w, at)
      }
    }
    return ran
  })

  // Insist mode: one trip back before Claude may stop.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (!mode.on || !mode.insist || e.agent_id || e.stop_hook_active || !current || r.block) return r
    const reason = insistText(judge(current))
    if (!reason) return r
    $.ui.toast('done-check: nothing checked that. Sent back to run a check.', { timeoutMs: 6000 })
    return { ...r, block: reason }
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const turn = current
    current = null
    if (!turn) return r
    try {
      const before = await read($, turnsAtom)
      const number = (before[before.length - 1]?.turn ?? 0) + 1
      const now = await $.clock.now()
      const v = judge(turn)
      await update($, verdictAtom, () => ({ kind: v.kind, changed: v.changed, cmd: v.cmd, turn: number }))
      await update($, dismissedAtom, () => false)
      const logged = mode.log && shouldLog(turn) ? await writeLog($, turn, v, e.answer, e.durationMs, e.isAborted, now) : false
      const row: DoneCheckTurn = {
        turn: number,
        at: localTime(now),
        prompt: clip(redact(turn.prompt).replace(/\s+/g, ' ').trim(), 80),
        changed: v.changed,
        verified: verifiedWord(v),
        logged,
      }
      await update($, turnsAtom, (list) => [...list, row].slice(-100))
      await showStatus($)
    } catch (err) {
      $.ui.log(`done-check: turn.complete failed (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
    }
    return r
  })

  on('command.run', { command: 'done' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const now = await $.clock.now()
    const path = logFolder ? tilde(ledgerPath(now, logFolder), home) : '(no home folder found)'
    const turnTo = async (key: (typeof SWITCHES)[number], to: boolean) => {
      mode = { ...mode, [key]: to }
      await $.store.set(key, to)
      await showStatus($)
    }
    if (word === 'on' || word === 'off') {
      await turnTo('on', word === 'on')
      return { text: word === 'on' ? 'done-check is ON.' : 'done-check is OFF: no flag, no note, no insisting, in any chat, until /done on.' }
    }
    if ((word === 'insist' || word === 'log') && (value === 'on' || value === 'off')) {
      await turnTo(word, value === 'on')
      if (word === 'insist') {
        return {
          text:
            value === 'on'
              ? 'Insist mode ON: when a turn changed code and nothing checked it, Claude is sent back once to run a check before it stops. This can add one more model request to a turn.'
              : 'Insist mode off: Claude may stop; the flag still shows.',
        }
      }
      return { text: value === 'on' ? `Work log ON: ${path}` : 'Work log off. Files already written stay where they are.' }
    }
    if (word === 'dismiss') {
      await update($, dismissedAtom, () => true)
      await showStatus($)
      return { text: 'Flag lowered for this turn. The next turn is judged afresh.' }
    }
    if (word) return { text: 'Use /done, /done on|off, /done dismiss, /done insist on|off or /done log on|off.' }
    return { text: turnsTable(await read($, turnsAtom), mode, path) }
  })

  // The footer's "verified ✓".
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const v = await read($, verdictAtom)
    if (!mode.on || !v || v.kind !== 'verified') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const mark = <Text color="green">verified ✓</Text>
    if (!e.props.modes.length) return mark
    return (
      <Box flexDirection="row">
        <Text dimColor>{e.props.modes.join(' & ')} · </Text>
        {mark}
      </Box>
    )
  })
}

async function writeLog(
  $: EngineInterface,
  turn: TurnRecord,
  verdict: ReturnType<typeof judge>,
  answer: string,
  durationMs: number,
  isAborted: boolean,
  now: number,
): Promise<boolean> {
  if (!logFolder) return false
  const path = ledgerPath(now, logFolder)
  try {
    const entry = ledgerEntry({
      endedAt: now,
      durationMs,
      sessionId,
      cwd,
      prompt: turn.prompt,
      files: [...turn.files.keys()],
      calls: turn.calls,
      verdict,
      answer,
      isAborted,
    })
    // never overwrite a log that could not be read
    const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : null
    await $.fs.write(path, appendEntry(existing, entry, now))
    return true
  } catch (err) {
    if (!logFailed) {
      logFailed = true
      $.ui.toast(`done-check: could not write the work log (${clip(err instanceof Error ? err.message : String(err), 80)})`, { timeoutMs: 8000 })
    }
    return false
  }
}

function toolLabel(tool: string, args: Record<string, unknown>): string {
  const url = typeof args.url === 'string' ? ` ${args.url}` : ''
  return clip(`${tool}${url}`, 120)
}
