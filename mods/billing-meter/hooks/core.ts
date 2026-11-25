// billing-meter: pure helpers (no $), unit-tested in tests/billing.test.ts.

export const RANGES = /^(today|yesterday|week|this-week|last-week|month|this-month|last-month|all|\d{4}-\d{2}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}|last-\d+-days)$/i

export const HELP = [
  'billing-meter: hours per client, measured from your Claude Code chats.',
  '',
  '  /bill                        this week',
  '  /bill <range>                today | yesterday | week | last-week | month | last-month | all | 2026-10 | 2026-10-06 | 2026-10-01..2026-10-15 | last-30-days',
  '  /bill export [range]         save CSV + Markdown timesheets (default: this month)',
  '  /bill <range> <project>      one project only, e.g. /bill month shop',
  '  /bill project <name>         put this chat\'s time on <name> from now on  (/bill project auto = detect again)',
  '  /bill add <name> <folder>    a project: every chat that touches <folder> counts for <name>',
  '  /bill rate <project> <amount> [USD]   hourly rate, used for the Amount column',
  '  /bill basis engaged|you|claude|you+claude   what counts as billable (default you)',
  '  /bill round <minutes>        round up per project per day (default 15)',
  '  /bill descriptions on|off    keep the first words of your prompts on each line (default off)',
  '  /bill projects               list projects, rates, billed or not',
  '',
  'You = your typing + reading. Claude = main chat. Agents = helpers in parallel. Engaged = clock time anyone worked on it.',
].join('\n')

export type Plan =
  | { kind: 'run'; args: string[]; title: string }
  | { kind: 'help' }
  | { kind: 'error'; text: string }

/** Turns the text after /bill into the engine's arguments. `session` is this chat's id. */
export function plan(input: string, session: string): Plan {
  const words = input.trim().split(/\s+/).filter(Boolean)
  const [head = '', ...rest] = words
  const h = head.toLowerCase()
  if (!head) return { kind: 'run', args: ['report', '--range', 'week'], title: 'week' }
  if (h === 'help' || h === '?') return { kind: 'help' }
  if (h === 'projects' || h === 'config') return { kind: 'run', args: ['config', '--show'], title: 'projects' }
  if (h === 'export') {
    const range = rest[0] && RANGES.test(rest[0]) ? rest[0] : 'month'
    const project = rest[0] && RANGES.test(rest[0]) ? rest.slice(1).join(' ') : rest.join(' ')
    return { kind: 'run', args: ['export', '--range', range, ...(project ? ['--project', project] : [])], title: `export ${range}` }
  }
  if (h === 'project' || h === 'tag') {
    const name = rest.join(' ')
    if (!name) return { kind: 'error', text: 'Which project? /bill project <name>, or /bill project auto. /bill projects lists them.' }
    if (!session) return { kind: 'error', text: 'This chat has no id yet; try again after the first reply.' }
    return { kind: 'run', args: ['tag', '--session', session, '--project', name], title: 'project' }
  }
  if (h === 'add') {
    // the folder may have spaces: the name is the first word, or the first quoted words
    const m = /^add\s+(?:"([^"]+)"|(\S+))\s+(.+)$/i.exec(input.trim())
    const name = m?.[1] ?? m?.[2]
    const folder = m?.[3]?.trim().replace(/^"|"$/g, '')
    if (!name || !folder) return { kind: 'error', text: 'Use: /bill add <name> <folder>, e.g. /bill add shop C:/code/shop or /bill add "Acme Ltd" /home/me/acme' }
    return { kind: 'run', args: ['config', '--add-project', name, '--path', folder], title: 'add' }
  }
  if (h === 'rate') {
    if (rest.length < 2) return { kind: 'error', text: 'Use: /bill rate <project> <amount> [currency], e.g. /bill rate shop 80 USD' }
    // the project name may have spaces: the amount is a number near the end, a 3-letter currency may follow it
    const tail = [...rest]
    const cur = /^[A-Za-z]{3}$/.test(tail[tail.length - 1] ?? '') && /^\d/.test(tail[tail.length - 2] ?? '') ? tail.pop() : undefined
    const amount = tail.pop() ?? ''
    if (!/^\d+(\.\d+)?$/.test(amount)) return { kind: 'error', text: `"${amount}" is not an amount. Use: /bill rate <project> <amount> [currency]` }
    const name = tail.join(' ')
    if (!name) return { kind: 'error', text: 'Which project? /bill rate <project> <amount>' }
    return { kind: 'run', args: ['config', '--rate', name, amount, ...(cur ? [cur.toUpperCase()] : [])], title: 'rate' }
  }
  if (h === 'basis') {
    const b = (rest[0] ?? '').toLowerCase()
    if (!['engaged', 'you', 'claude', 'you+claude'].includes(b)) return { kind: 'error', text: 'Use: /bill basis engaged | you | claude | you+claude' }
    return { kind: 'run', args: ['config', '--basis', b], title: 'basis' }
  }
  if (h === 'descriptions') {
    const v = (rest[0] ?? '').toLowerCase()
    if (v !== 'on' && v !== 'off') return { kind: 'error', text: 'Use: /bill descriptions on | off' }
    return { kind: 'run', args: ['config', '--descriptions', v], title: 'descriptions' }
  }
  if (h === 'round') {
    const m = rest[0] ?? ''
    if (!/^\d+$/.test(m)) return { kind: 'error', text: 'Use: /bill round <minutes>, e.g. /bill round 15 (0 = no rounding)' }
    return { kind: 'run', args: ['config', '--round', m], title: 'round' }
  }
  if (RANGES.test(head)) {
    const project = rest.join(' ')
    return { kind: 'run', args: ['report', '--range', head.toLowerCase(), ...(project ? ['--project', project] : [])], title: head }
  }
  return { kind: 'error', text: `Unknown "${head}". ${'/bill help'} lists what works.` }
}

/** The engine's one line for today, kept short. */
export function statusLine(stdout: string): string | undefined {
  const line = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => /^\d+\.\d\d h billable today/.test(s))
  if (!line) return undefined
  return line.length > 60 ? line.slice(0, 59) + '…' : line
}

export const PYTHONS = ['python', 'py', 'python3'] as const
