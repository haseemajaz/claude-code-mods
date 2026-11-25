import { describe, expect, test } from 'claude-code/testing'

import { plan, statusLine, RANGES } from '../hooks/core'

describe('/bill arguments', () => {
  test('no argument shows the week', () => {
    expect(plan('', 's1')).toEqual({ kind: 'run', args: ['report', '--range', 'week'], title: 'week' })
  })

  test('ranges pass through, with an optional project', () => {
    expect(plan('today', 's1')).toMatchObject({ args: ['report', '--range', 'today'] })
    expect(plan('2026-10', 's1')).toMatchObject({ args: ['report', '--range', '2026-10'] })
    expect(plan('2026-10-01..2026-10-15', 's1')).toMatchObject({ args: ['report', '--range', '2026-10-01..2026-10-15'] })
    expect(plan('month Acme Ltd', 's1')).toMatchObject({ args: ['report', '--range', 'month', '--project', 'Acme Ltd'] })
    expect(plan('last-30-days', 's1')).toMatchObject({ args: ['report', '--range', 'last-30-days'] })
  })

  test('export defaults to this month', () => {
    expect(plan('export', 's1')).toMatchObject({ args: ['export', '--range', 'month'] })
    expect(plan('export last-month shop', 's1')).toMatchObject({ args: ['export', '--range', 'last-month', '--project', 'shop'] })
  })

  test('project tags this chat', () => {
    expect(plan('project Acme portal', 'abc')).toMatchObject({ args: ['tag', '--session', 'abc', '--project', 'Acme portal'] })
    expect(plan('project', 'abc').kind).toBe('error')
    expect(plan('project shop', '').kind).toBe('error')
  })

  test('rate takes a project with spaces, an amount and an optional currency', () => {
    expect(plan('rate shop 120', 's')).toMatchObject({ args: ['config', '--rate', 'shop', '120'] })
    expect(plan('rate Acme Ltd 80 eur', 's')).toMatchObject({ args: ['config', '--rate', 'Acme Ltd', '80', 'EUR'] })
    expect(plan('rate shop lots', 's').kind).toBe('error')
  })

  test('add names a project for a folder, spaces and all', () => {
    expect(plan('add shop C:/code/my shop', 's')).toMatchObject({ args: ['config', '--add-project', 'shop', '--path', 'C:/code/my shop'] })
    expect(plan('add "Acme Ltd" /home/me/acme', 's')).toMatchObject({ args: ['config', '--add-project', 'Acme Ltd', '--path', '/home/me/acme'] })
    expect(plan('add shop', 's').kind).toBe('error')
  })

  test('descriptions on and off', () => {
    expect(plan('descriptions on', 's')).toMatchObject({ args: ['config', '--descriptions', 'on'] })
    expect(plan('descriptions maybe', 's').kind).toBe('error')
  })

  test('basis and round are checked', () => {
    expect(plan('basis you', 's')).toMatchObject({ args: ['config', '--basis', 'you'] })
    expect(plan('basis hours', 's').kind).toBe('error')
    expect(plan('round 6', 's')).toMatchObject({ args: ['config', '--round', '6'] })
    expect(plan('round six', 's').kind).toBe('error')
  })

  test('help and unknown words', () => {
    expect(plan('help', 's').kind).toBe('help')
    expect(plan('banana', 's').kind).toBe('error')
    expect(RANGES.test('last-week')).toBe(true)
  })
})

describe('footer', () => {
  test('takes the line for today and keeps it short', () => {
    expect(statusLine('noise\n2.75 h billable today · shop 1.50\n')).toBe('2.75 h billable today · shop 1.50')
    expect(statusLine('Traceback ...')).toBeUndefined()
    expect(statusLine('1.00 h billable today · ' + 'x'.repeat(100))!.length).toBe(60)
  })
})
