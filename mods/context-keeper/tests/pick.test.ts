import { describe, expect, test } from 'claude-code/testing'

import type { IndexEntry } from '../hooks/pick'
import { pickForNewChat, recentBackups, reviveIndex, upsertIndex } from '../hooks/pick'
import { shortCapsulePath } from '../hooks/text'

const T0 = Date.parse('2026-10-16T10:00:00')
const H = 3_600_000
const HERE = 'C:/work/my project'
const DIR = 'C:/Users/tester/.claude/zed-mods/context-keeper/capsules'

function entry(sid: string, ageH: number, over: Partial<IndexEntry> = {}): IndexEntry {
  return { sid, title: `chat ${sid}`, cwd: HERE, slug: 'my-project', updatedAt: T0 - ageH * H, turns: 5, ctxPct: 40, path: `${DIR}/my-project/${sid}.md`, transcript: `x/${sid}.jsonl`, ...over }
}

describe('which capsule a new chat receives', () => {
  const opts = { cwd: HERE, currentSid: 'NOW', now: T0, maxAgeMs: 72 * H }

  test('the newest capsule of the same project', () => {
    const list = [entry('old', 5), entry('new', 1), entry('mid', 3)]
    expect(pickForNewChat(list, opts)?.sid).toBe('new')
  })

  test('never the current chat, even when it is the newest', () => {
    const list = [entry('NOW', 0), entry('prev', 2)]
    expect(pickForNewChat(list, opts)?.sid).toBe('prev')
  })

  test('the chat just cleared wins over a newer one', () => {
    const list = [entry('other', 0.1), entry('cleared', 0.5)]
    expect(pickForNewChat(list, { ...opts, previousSid: 'cleared' })?.sid).toBe('cleared')
  })

  test('same folder whatever the case or slashes', () => {
    const list = [entry('a', 1, { cwd: 'c:\\work\\my project\\' })]
    expect(pickForNewChat(list, opts)?.sid).toBe('a')
  })

  test('not another project, not an empty chat, not a stale one', () => {
    const list = [entry('elsewhere', 1, { cwd: 'C:/work/shop-app' }), entry('empty', 1, { turns: 0 }), entry('stale', 100)]
    expect(pickForNewChat(list, opts)).toBe(undefined)
  })

  test('the index keeps one entry per chat, newest first, and revives a damaged file', () => {
    let idx = reviveIndex('garbage', HERE, 'my-project')
    idx = upsertIndex(idx, entry('a', 2))
    idx = upsertIndex(idx, entry('b', 1))
    idx = upsertIndex(idx, { ...entry('a', 0), title: 'renamed' })
    expect(Object.keys(idx.chats).length).toBe(2)
    expect(idx.chats.a!.title).toBe('renamed')
    expect(recentBackups(Object.values(idx.chats), 'zzz').map((e) => e.sid)).toEqual(['a', 'b'])
    expect(recentBackups(Object.values(idx.chats), 'a').map((e) => e.sid)).toEqual(['b'])
  })
})

test('short paths', () => {
  expect(shortCapsulePath(`${DIR}/shop/abc.md`)).toBe('capsules/shop/abc.md')
})
