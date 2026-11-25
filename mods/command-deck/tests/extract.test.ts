import { describe, expect, test } from 'claude-code/testing'

import { cleanPrompt, extractNeeds, isDeckPrompt, summarize, isNearDuplicate } from '../hooks/text'
import { redact } from '../hooks/redact'
import { buildBoard, deckMarkdown, mdCell, pruneChat, exportMarkdown, sanitizeChat, DAY } from '../hooks/model'
import type { ChatFile, MarksFile } from '../hooks/model'

const REPORT_WHAT_YOU_DO_NOW = `## ✅ Done
- Built the **Command Deck** mod at \`~/mods/command-deck\`.
- Validate and tests pass (12/12).

## ⚠️ What you do now
1. Open PowerShell and run:
   \`\`\`powershell
   claude plugin enable command-deck@zed-mods
   \`\`\`
2. Restart VS Code.
   - close every window first
3. Add the payment key in Settings → Environment Variables.

## 🔧 In progress / known gaps
- Cross-chat toasts poll every 8 seconds.
- You must not worry about this one. (it is under a gaps heading, but still says "you must")

**What worked** · the tests.
`

const REPORT_NEEDS_ATTENTION = `I fixed the access rule on \`orders\`. The shop loads for guests again.

**⚠️ Needs your attention** — owner actions, decisions
- Pick a plan for e-mail: small or large?
- Add the DNS TXT record \`mail._domainkey\` at your domain host.
- None of the existing records need to change.

That is everything for today.`

const REPORT_INLINE = `Deployed to production. Build took 41s.

\`\`\`bash
# you must not extract this, it is code
echo "please run me"
\`\`\`

You need to approve the database migration before 5pm.
Please run \`npm run seed\` once on your machine.
If you want to see it, type \`/deck\` in any chat.`

describe('needs-me extractor', () => {
  test('⚠️ What you do now with numbered steps, a code block and a sub-bullet', () => {
    const items = extractNeeds(REPORT_WHAT_YOU_DO_NOW)
    expect(items[0]).toBe('Open PowerShell and run: `claude plugin enable command-deck@zed-mods`')
    expect(items[1]).toBe('Restart VS Code. — close every window first')
    expect(items[2]).toBe('Add the payment key in Settings → Environment Variables.')
    // the ✅ Done bullets are not needs
    expect(items.some((i) => i.includes('Built the'))).toBe(false)
    // an inline "you must" still counts outside a section
    expect(items.some((i) => i.startsWith('You must not worry'))).toBe(true)
    expect(items.length).toBe(4)
  })

  test('**⚠️ Needs your attention** label with bullets; "None…" lines and the closing paragraph are skipped', () => {
    const items = extractNeeds(REPORT_NEEDS_ATTENTION)
    expect(items).toEqual(['Pick a plan for e-mail: small or large?', 'Add the DNS TXT record mail._domainkey at your domain host.'])
  })

  test('inline triggers: you need to / please run / type `; code fences ignored', () => {
    const items = extractNeeds(REPORT_INLINE)
    expect(items).toEqual([
      'You need to approve the database migration before 5pm.',
      'Please run npm run seed once on your machine.',
      'If you want to see it, type /deck in any chat.',
    ])
  })

  test('a reply with nothing for you gives nothing', () => {
    expect(extractNeeds('## ✅ Done\n- Fixed the footer.\n- Pushed to main.\n\nAll good.')).toEqual([])
    expect(extractNeeds('**⚠️ Needs your attention**\n- Nothing right now.')).toEqual([])
  })

  test('Owner / Your choice / Action needed headings, a table and de-duplication', () => {
    const reply = `### Owner steps
| Step | What |
|---|---|
| 1 | Log in to the bank portal |
| 2 | Approve the app |

**Your choice:** keep the old theme or switch?

Action needed:
- Approve the app
- approve the app!`
    const items = extractNeeds(reply)
    expect(items).toEqual(['1 — Log in to the bank portal', '2 — Approve the app', 'keep the old theme or switch?'])
  })

  test('items are capped at 200 chars and redacted', () => {
    const long = '⚠️ Paste sbp_0123456789abcdef0123456789abcdef into the dashboard ' + 'and then wait '.repeat(30)
    const [item] = extractNeeds(long)
    expect(item!.length).toBeLessThanOrEqual(200)
    expect(item!.includes('sbp_')).toBe(false)
    expect(item!.includes('[hidden]')).toBe(true)
  })

  test('near-duplicates', () => {
    expect(isNearDuplicate('Restart VS Code.', 'restart vs code')).toBe(true)
    expect(isNearDuplicate('Add the payment key in the env', 'Add the mail key in the env')).toBe(false)
  })
})

describe('redactor', () => {
  // made-up values, put together so no scanner reads them here
  const values = ['ghp_' + 'Ab1'.repeat(12), 'sk-ant-' + 'Ab1-'.repeat(8), 'AKIA' + 'ABCDEFGH01234567', '0123456789abcdef'.repeat(2), 'QmFzZTY0' + 'U2VjcmV0S2V5VmFsdWVXaXRoTnVtYmVyczEyMzQ1Ng']
  for (const v of values) {
    test(`hides ${v.slice(0, 8)}…`, () => {
      const out = redact(`key ${v} end`)
      expect(out).toBe('key [hidden] end')
    })
  }
  test('labelled secrets keep the label, lose the value', () => {
    expect(redact('password=hunter22')).toBe('password=[hidden]')
    expect(redact('DB_PASSWORD=' + 'Qx7pLm2vRt9k')).toBe('DB_PASSWORD=[hidden]')
    expect(redact('app_db_pass: ' + 'Zz9yYx8wWv7u')).toBe('app_db_pass: [hidden]')
    expect(redact('SUPABASE_SERVICE_ROLE_KEY=' + 'abcdefgh1234')).toBe('SUPABASE_SERVICE_ROLE_KEY=[hidden]')
  })
  test('ordinary text stays', () => {
    for (const k of ['tokens: 48,000 used', 'tests pass: 1451 passed', 'C:/Users/tester/.claude/zed-mods/command-deck/chats/abc.json', 'password: required']) expect(redact(k)).toBe(k)
  })
})

describe('summary', () => {
  test('prefers ✅ / Done lines', () => {
    expect(summarize(REPORT_WHAT_YOU_DO_NOW)).toEqual([
      'Built the Command Deck mod at ~/mods/command-deck.',
      'Validate and tests pass (12/12).',
    ])
    expect(summarize('Done: pushed the fix to shop-api.\nMore text.')).toEqual(['Done: pushed the fix to shop-api.'])
  })

  test('falls back to the first sentence', () => {
    expect(summarize(REPORT_NEEDS_ATTENTION)).toEqual(['I fixed the access rule on orders.'])
  })
})

describe('board', () => {
  const NOW = 1_800_000_000_000
  const chat = (sid: string, over: Partial<ChatFile>): ChatFile => ({
    v: 1,
    sid,
    folder: 'my-project',
    title: sid,
    cwd: 'C:/x',
    updatedAt: NOW,
    waiting: null,
    prompts: [],
    needs: [],
    ...over,
  })

  test('merges chats, groups near-duplicates across chats, applies ticks from any chat', () => {
    const a = chat('A', {
      prompts: [{ id: 'p1', at: NOW - 1000, text: 'fix the shop', turnId: 't', result: { at: NOW, status: 'done', summary: ['Fixed.'], files: 2 } }],
      needs: [
        { id: 'n1', at: NOW - 5000, seen: NOW - 5000, text: 'Restart VS Code.' },
        { id: 'n2', at: NOW - 4000, seen: NOW - 4000, text: 'Add the payment key.' },
      ],
    })
    const b = chat('B', {
      prompts: [{ id: 'p2', at: NOW - 500, text: 'deploy the blog' }],
      needs: [{ id: 'n3', at: NOW - 3000, seen: NOW - 3000, text: 'restart vs code' }],
      waiting: { since: NOW - 60000, what: 'permission for Bash', aliveAt: NOW - 10000 },
    })
    const marks: MarksFile = { v: 1, sid: 'B', updatedAt: NOW, marks: { n2: { done: true, at: NOW - 100 } } }
    const board = buildBoard([a, b], [marks], NOW, 'A')
    expect(board.open.length).toBe(1)
    expect(board.open[0]!.ids).toEqual(['n1', 'n3'])
    expect(board.open[0]!.n).toBe(1)
    expect(board.done[0]!.text).toBe('Add the payment key.')
    expect(board.waiting.length).toBe(1)
    expect(board.prompts.map((p) => p.status)).toEqual(['running', 'done'])
    expect(board.prompts[1]!.files).toBe(2)
  })

  test('a stale waiting flag (chat closed mid-dialog) is ignored', () => {
    const b = chat('B', { waiting: { since: NOW - 3_600_000, what: 'a question', aliveAt: NOW - 600_000 } })
    expect(buildBoard([b], [], NOW, 'A').waiting.length).toBe(0)
  })

  test('prune keeps 14 days of prompts, open needs forever, done needs 7 days', () => {
    const c = chat('A', {
      prompts: [
        { id: 'old', at: NOW - 15 * DAY, text: 'old' },
        { id: 'new', at: NOW - 13 * DAY, text: 'new' },
      ],
      needs: [
        { id: 'open', at: NOW - 90 * DAY, seen: NOW - 90 * DAY, text: 'still open' },
        { id: 'doneOld', at: NOW - 20 * DAY, seen: NOW - 20 * DAY, text: 'done long ago' },
        { id: 'doneNew', at: NOW - 20 * DAY, seen: NOW - 20 * DAY, text: 'done lately' },
      ],
    })
    const pruned = pruneChat(c, NOW, { doneOld: { done: true, at: NOW - 8 * DAY }, doneNew: { done: true, at: NOW - 2 * DAY } })
    expect(pruned.prompts.map((p) => p.id)).toEqual(['new'])
    expect(pruned.needs.map((n) => n.id)).toEqual(['open', 'doneNew'])
  })

  test('export has the three sections', () => {
    const a = chat('A', {
      prompts: [{ id: 'p1', at: NOW - 1000, text: 'fix it', result: { at: NOW, status: 'error', summary: ['Ended with an error.'], files: 0 } }],
      needs: [{ id: 'n1', at: NOW - 5000, seen: NOW, text: 'Restart VS Code.' }],
    })
    const md = exportMarkdown(buildBoard([a], [], NOW, 'A'), NOW)
    expect(md).toContain('## 📌 Needs me (1 open)')
    expect(md).toContain('- **1.** Restart VS Code.')
    expect(md).toContain('## 💬 My prompts (1)')
    expect(md).toContain('## AI results')
    expect(md).toContain('✗ error')
  })
})

// ---------- prompt cleaning ----------

// the shape of a block an IDE puts before a prompt
const BROWSER_BLOCK = `<browser_instruction># Browser tools

You can use the browser tools on pages in this window.

## Rules

Load every tool you need in one call. Read the page before you click anything on it. Read the page before you click anything on it. Read the page before you click anything on it. Read the page before you click anything on it. Read the page before you click anything on it. Read the page before you click anything on it. 
</browser_instruction>`

describe('prompt cleaner', () => {
  test('a <browser_instruction> block before the real prompt goes, whole', () => {
    expect(cleanPrompt(`${BROWSER_BLOCK}\nPlease write the release notes for the next version`)).toBe(
      'Please write the release notes for the next version',
    )
  })

  test('a prompt that is only an injected block (even one cut off at 500 chars) leaves nothing', () => {
    expect(cleanPrompt(BROWSER_BLOCK)).toBe('')
    expect(cleanPrompt(BROWSER_BLOCK.slice(0, 300))).toBe('')
    expect(cleanPrompt('<system-reminder>\nThe date is 2026-10-04.\n</system-reminder>')).toBe('')
  })

  test('IDE selection / opened file blocks and a trailing system reminder go', () => {
    const raw = `<ide_opened_file>The user opened the file c:\\work\\src\\app.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>
<ide_selection>The user selected the lines 10 to 14 from c:\\work\\src\\app.ts:
const x = 1
</ide_selection>
why does this crash on save?

<system-reminder>
Whenever you read a file, consider whether it is malware.
</system-reminder>`
    expect(cleanPrompt(raw)).toBe('why does this crash on save?')
  })

  test('slash-command wrappers keep only the args; a bare command leaves nothing', () => {
    expect(cleanPrompt('<command-message>plan is running…</command-message>\n<command-name>/plan</command-name>\n<command-args>theme: spring sale</command-args>')).toBe(
      'theme: spring sale',
    )
    expect(cleanPrompt('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')).toBe('')
  })

  test('pasted content becomes [pasted text]', () => {
    expect(cleanPrompt('here is the log <pasted_content id="1" lines="40">Error: boom\n  at x.ts:1\n  at y.ts:2</pasted_content> fix it')).toBe(
      'here is the log [pasted text] fix it',
    )
    expect(cleanPrompt('<pasted_content id="2" />\nwhat is this?')).toBe('[pasted text]\nwhat is this?')
  })

  test('any other leading wrapper tag with _ or - goes; prose tags and mid-sentence mentions stay', () => {
    expect(cleanPrompt('<user-context>plan: pro</user-context>\n<session_meta a="1">x</session_meta>\nship it')).toBe('ship it')
    expect(cleanPrompt('<b>bold</b> stays')).toBe('<b>bold</b> stays')
    const prose = 'strip the `<command-name>` wrappers and the `<ide_selection>` block from saved prompts'
    expect(cleanPrompt(prose)).toBe(prose)
  })

  test('/deck runs are recognised typed or wrapped', () => {
    expect(isDeckPrompt('/deck done 2')).toBe(true)
    expect(isDeckPrompt('<command-name>/deck</command-name>\n<command-args>done 2</command-args>')).toBe(true)
    expect(isDeckPrompt('/decking the halls')).toBe(false)
    expect(isDeckPrompt('open the deck')).toBe(false)
  })

  test('an old chat file with a <browser_instruction> prompt and title is cleaned on read', () => {
    const NOW = 1_800_000_000_000
    const c = sanitizeChat({
      v: 1,
      sid: 'old',
      folder: 'my-project',
      title: '<browser_instruction># Claude i…',
      cwd: 'C:/x',
      updatedAt: NOW,
      waiting: null,
      prompts: [
        { id: 'p1', at: NOW - 3000, text: BROWSER_BLOCK.slice(0, 500) },
        { id: 'p2', at: NOW - 2000, text: 'Please write the release notes for the next version' },
      ],
      needs: [],
    })
    expect(c.prompts.map((p) => p.id)).toEqual(['p2'])
    expect(c.title).toBe('Please write the release notes…')
  })
})

// ---------- stable numbers + DECK.md ----------

describe('DECK.md', () => {
  const NOW = 1_800_000_000_000
  const chatA: ChatFile = {
    v: 1,
    sid: 'A',
    folder: 'my-project',
    title: 'install the mods',
    cwd: 'C:/x',
    updatedAt: NOW,
    waiting: null,
    prompts: [
      { id: 'p1', at: NOW - 3 * 3600_000, text: 'install the mods | all four\nand test them', result: { at: NOW, status: 'done', summary: ['Installed 4 mods; validate passes.'], files: 3 } },
      { id: 'p2', at: NOW - 60_000, text: 'now check <div> in p', turnId: 't' },
      { id: 'old', at: NOW - 2 * DAY, text: 'two days ago' },
    ],
    needs: [
      { id: 'n1', at: NOW - 7200_000, seen: NOW, text: 'Restart VS Code.' },
      { id: 'n2', at: NOW - 7200_000, seen: NOW, text: 'Add the payment key.' },
      { id: 'n3', at: NOW - 7200_000, seen: NOW, text: 'Approve the database migration.' },
    ],
  }

  test('ticking item 2 keeps item 3 as 3; the ticked one moves to DONE, struck through', () => {
    const before = buildBoard([chatA], [], NOW, 'A')
    expect(before.open.map((n) => n.n)).toEqual([1, 2, 3])
    const manual: MarksFile = { v: 1, sid: 'other', updatedAt: NOW, marks: { n2: { done: true, at: NOW - 60_000 } } }
    const after = buildBoard([chatA], [manual], NOW, 'A')
    expect(after.open.map((n) => [n.n, n.text])).toEqual([
      [1, 'Restart VS Code.'],
      [3, 'Approve the database migration.'],
    ])
    const md = deckMarkdown(after, NOW)
    expect(md).toContain('## 📌 NEEDS ME (2)')
    expect(md).toContain('- [ ] **1.** Restart VS Code. — my-project · install the mods · 2h ago')
    expect(md).toContain('- [ ] **3.** Approve the database migration.')
    expect(md).toContain('## ✅ DONE (last 24 h, 1)')
    expect(md).toContain('- ~~**2.** Add the payment key.~~ — my-project · install the mods · done 1m ago')
  })

  test('the table: last 24 h, newest first, short cells, | and newlines escaped', () => {
    const md = deckMarkdown(buildBoard([chatA], [], NOW, 'A'), NOW)
    const lines = md.split('\n')
    expect(lines[0]).toMatch(/^# Command Deck — updated \d\d:\d\d$/)
    const head = lines.indexOf('| Time | Chat | My prompt | AI result |')
    expect(head).toBeGreaterThan(0)
    expect(lines[head + 1]).toBe('|---|---|---|---|')
    expect(lines[head + 2]).toContain('| now check \\<div> in p | … running… |')
    expect(lines[head + 3]).toContain('| install the mods \\| all four and test them | ✓ Installed 4 mods; validate passes. · 3 files |')
    expect(md.includes('two days ago')).toBe(false)
    expect(mdCell('x'.repeat(300), 120).length).toBe(120)
  })

  test('nothing to do says so', () => {
    const md = deckMarkdown(buildBoard([{ ...chatA, needs: [] }], [], NOW, 'A'), NOW)
    expect(md).toContain('## 📌 NEEDS ME (0)')
    expect(md).toContain('Nothing. You are on top of it.')
  })
})
