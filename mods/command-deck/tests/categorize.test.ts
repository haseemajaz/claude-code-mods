import { describe, expect, test } from 'claude-code/testing'

import { AGES, KINDS, ageOf, allGroups, chatProject, groupSlug, itemKind, itemProject, matchGroup, parseNumbers, projectOfPath, readProjects, setProjects } from '../hooks/categorize'
import { buildBoard, groupNeeds, groupsText } from '../hooks/model'
import type { ChatFile } from '../hooks/model'

const T0 = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

const PROJECTS = readProjects([
  { name: 'Shop', folders: ['code\\shop'], words: ['checkout', 'invoice'] },
  { name: 'Shop admin', folders: ['code/admin'], words: ['back office'] },
  { name: 'Blog', folders: ['code/blog'], words: ['blog', 'C++'] },
  { folders: ['no name'] },
  'not an object',
])
const NAMES = ['Shop', 'Shop admin', 'Blog', 'Other']

describe('kinds', () => {
  const items: [string, string][] = [
    ['Pick one: A) keep the old layout, B) use the new one', 'Decide'],
    ['Do you want the export as CSV?', 'Decide'],
    ['Approve the pull request', 'Decide'],
    ['Sign in to the hosting dashboard again', 'Sign in / keys'],
    ['Add the API key to the .env file', 'Sign in / keys'],
    ['Run npm run migrate', 'Run / do'],
    ['Restart the dev server', 'Run / do'],
    ['Check the checkout page on your phone', 'Test / check'],
    ['Open the PDF and look at page 2', 'Test / check'],
    ['Heads-up: the old endpoint is gone', 'Read / FYI'],
  ]
  for (const [text, kind] of items) {
    test(`${kind}: ${text}`, () => {
      expect(itemKind(text)).toBe(kind)
    })
  }
})

describe('projects', () => {
  test('wrong entries in config.json are dropped', () => {
    expect(PROJECTS.map((p) => p.name)).toEqual(['Shop', 'Shop admin', 'Blog'])
    expect(readProjects('nonsense')).toEqual([])
  })

  test('nothing configured: the folder of the chat is the project', () => {
    setProjects([])
    expect(chatProject({ cwd: 'C:\\work\\shop-app', title: 'x', texts: ['fix the invoice'] })).toBe('shop-app')
    expect(chatProject({ cwd: '/home/me/blog/', title: 'x' })).toBe('blog')
    expect(chatProject({ cwd: '', title: 'x' })).toBe('Other')
    expect(itemProject('Check the invoice', 'shop-app')).toBe('shop-app')
  })

  test('configured: folder first, then words; whole words only', () => {
    setProjects(PROJECTS)
    expect(projectOfPath('C:\\code\\shop\\src')).toBe('Shop')
    expect(chatProject({ cwd: 'C:/work/misc', title: 'fix the checkout', texts: ['the invoice is wrong'] })).toBe('Shop')
    expect(chatProject({ cwd: 'C:/work/misc', title: 'weblogs', texts: [] })).toBe('misc')
    expect(itemProject('Read the blog post', 'Shop')).toBe('Blog')
    expect(itemProject('Learn C++ first', 'Shop')).toBe('Blog')
    expect(itemProject('The blog needs the checkout link', 'Blog')).toBe('Blog') // a tie goes to the chat
    expect(itemProject('nothing to go on', 'Shop')).toBe('Shop')
    setProjects([])
  })
})

describe('age', () => {
  test('Today, This week, Older than a week', () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime()
    expect(ageOf(new Date(2026, 9, 16, 0, 5).getTime(), now)).toBe('Today')
    expect(ageOf(new Date(2026, 9, 15, 23, 50).getTime(), now)).toBe('This week')
    expect(ageOf(now - 7 * DAY + 1000, now)).toBe('This week')
    expect(ageOf(now - 8 * DAY, now)).toBe('Older than a week')
    expect(AGES.length).toBe(3)
  })
})

describe('group names', () => {
  const pick = (q: string) => {
    const m = matchGroup(q, NAMES)
    return m.ok ? `${m.group.facet}:${m.group.name}` : 'ERR'
  }
  test('a prefix finds one group; facet:name narrows; exact names win', () => {
    expect(pick('shop')).toBe('project:Shop')
    expect(pick('shop admin')).toBe('project:Shop admin')
    expect(pick('BL')).toBe('project:Blog')
    expect(pick('older')).toBe('age:Older than a week')
    expect(pick('this week')).toBe('age:This week')
    expect(pick('decide')).toBe('kind:Decide')
    expect(pick('keys')).toBe('kind:Sign in / keys')
    expect(pick('project:other')).toBe('project:Other')
    expect(pick('kind:other')).toBe('kind:Other')
  })

  test('an ambiguous prefix is an error that lists every match; nothing found says so', () => {
    const other = matchGroup('other', NAMES)
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.error).toContain('project:Other, kind:Other')
    const none = matchGroup('zzz', NAMES)
    if (!none.ok) expect(none.error).toContain('No group "zzz"')
  })

  test("every group's slug finds exactly that group", () => {
    for (const g of allGroups(NAMES)) expect(pick(groupSlug(g, NAMES))).toBe(`${g.facet}:${g.name}`)
    expect(groupSlug({ facet: 'age', name: 'Older than a week' }, NAMES)).toBe('older')
    expect(KINDS.length).toBe(6)
  })
})

describe('numbers and ranges', () => {
  test('lists, ranges both ways, commas, junk reported', () => {
    expect(parseNumbers(['3', '7', '12'])).toEqual({ nums: [3, 7, 12], bad: [] })
    expect(parseNumbers(['3-6'])).toEqual({ nums: [3, 4, 5, 6], bad: [] })
    expect(parseNumbers(['9-7,2'])).toEqual({ nums: [7, 8, 9, 2], bad: [] })
    expect(parseNumbers(['3–5'])).toEqual({ nums: [3, 4, 5], bad: [] })
    expect(parseNumbers(['2', '2', 'x', '0'])).toEqual({ nums: [2], bad: ['x', '0'] })
    expect(parseNumbers(['1-99999']).bad).toEqual(['1-99999'])
  })
})

describe('the board carries the categories', () => {
  const chat = (sid: string, cwd: string, needs: [string, number][]): ChatFile => ({
    v: 1,
    sid,
    folder: 'x',
    title: sid,
    cwd,
    updatedAt: T0,
    waiting: null,
    prompts: [],
    needs: needs.map(([text, at], i) => ({ id: `${sid}-${i}`, at, seen: at, text })),
  })

  test('each item has project, kind, age; groups are newest first inside, numbers unchanged', () => {
    const board = buildBoard(
      [
        chat('a', 'C:/code/shop', [
          ['Approve the invoice fix?', T0 - 10 * DAY],
          ['Open the receipt and check the totals.', T0 - 2 * DAY],
        ]),
        chat('b', 'C:/code/blog', [['Send the new dates.', T0 - DAY]]),
      ],
      [],
      T0,
      'a',
    )
    const byText = Object.fromEntries(board.open.map((n) => [n.text, n]))
    expect(byText['Approve the invoice fix?']).toMatchObject({ n: 1, project: 'shop', kind: 'Decide', age: 'Older than a week' })
    expect(byText['Open the receipt and check the totals.']).toMatchObject({ n: 2, project: 'shop', kind: 'Test / check', age: 'This week' })
    expect(byText['Send the new dates.']).toMatchObject({ n: 3, project: 'blog', kind: 'Run / do' })
    expect(groupNeeds(board.open, 'project', T0).map((g) => [g.name, g.items.map((n) => n.n)])).toEqual([
      ['blog', [3]],
      ['shop', [2, 1]],
    ])
    const text = groupsText(board)
    expect(text).toContain('2  shop')
    expect(text).toContain('→ /deck done group shop')
    expect(text).toContain('Older than a week  → /deck done group older')
  })
})
