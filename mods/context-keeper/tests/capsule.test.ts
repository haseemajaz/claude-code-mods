import { describe, expect, test } from 'claude-code/testing'

import type { Msg } from '../hooks/capsule'
import { addPrompt, areaOf, emptyLedger, ingestMessages, injectionText, modelPrompt, openTasksIn, parseModelSections, renderCapsule, reviveLedger, transcriptExcerpt } from '../hooks/capsule'
import { redact } from '../hooks/redact'

const T0 = Date.parse('2026-10-16T10:00:00')
const ROOT = 'C:/work/my project'
const SID = '00000000-1111-4222-8333-444444444444'
// made-up values in real shapes, put together so no scanner reads them here
const FAKE = 'ghp_' + 'abcdef0123456789abcdef'

function ledger() {
  return emptyLedger(SID, ROOT, ROOT, 'my-project', T0, `C:/Users/tester/.claude/projects/x/${SID}.jsonl`)
}

const tool = (id: string, name: string, input: Record<string, unknown>, extra: { text?: string; isError?: true } = {}) => ({ tool_use_id: id, tool: name, input, ...extra })

const CHAT: Msg[] = [
  { role: 'user', text: '<system-reminder>ignore me</system-reminder>Fix the shop checkout rounding bug. Always run the tests before you say done.' },
  {
    role: 'assistant',
    text: 'Looking at the checkout code.',
    toolUses: [
      tool('t1', 'Read', { file_path: 'C:\\work\\shop-app\\src\\lib\\totals.ts' }),
      tool('t2', 'Edit', { file_path: 'C:\\work\\shop-app\\src\\lib\\totals.ts' }),
      tool('t3', 'Bash', { command: 'npm test -- totals' }),
      tool('t5', 'Bash', { command: `curl -H "Authorization: Bearer ${FAKE}" https://api.example.com/v1/projects` }),
    ],
  },
  { role: 'user', text: '', toolResults: [{ tool_use_id: 't1' }] },
  {
    role: 'assistant',
    text: '## ✅ Done\n- Fixed rounding; we decided to round to 0.05 instead of 0.01.\n- Live: https://shop.example.com/cart\n\n## ⚠️ Needs your attention\n1. Approve the staging deploy.\n2. Check the receipt PDF.\n',
  },
]

describe('redaction', () => {
  const secrets = [
    'ghp_' + '0123456789abcdef0123',
    'github_pat_' + '11ABCDEFG0123456789_abcdefghijk',
    'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUv',
    're_' + 'AbCdEf12_AbCdEf1234567890123456',
    'vcp_' + 'abcdefABCDEF1234567890abcd',
    'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '0123456789abcdef'.repeat(2),
    'QmFzZTY0' + 'U2VjcmV0S2V5VmFsdWVXaXRoTnVtYmVyczEyMzQ1Ng',
  ]
  for (const s of secrets) {
    test(`hides ${s.slice(0, 12)}…`, () => {
      const out = redact(`key: ${s} end`)
      expect(out.includes(s)).toBe(false)
      expect(out).toContain('[hidden]')
    })
  }

  test('keeps paths, session ids and ordinary words', () => {
    const keep = `C:/Users/tester/code/shop-app/hooks/register.ts ${SID} compact now`
    expect(redact(keep)).toBe(keep)
  })

  test('password=value style', () => {
    expect(redact('password=hunter2secret')).toBe('password=[hidden]')
    // compound names
    expect(redact('DB_PASSWORD=' + 'Qx7pLm2vRt9k')).toBe('DB_PASSWORD=[hidden]')
    expect(redact('app_db_pass: ' + 'Zz9yYx8wWv7u')).toBe('app_db_pass: [hidden]')
    expect(redact('tokens: 48,000 used')).toBe('tokens: 48,000 used')
  })

  test('OAuth client secrets, AWS keys and bearer tokens', () => {
    for (const s of ['GOCSPX-' + 'AbCdEfGhIjKlMnOpQrStUvWx', 'AKIA' + 'ABCDEFGH01234567', 'sb_secret_' + 'abcdefghij12345678']) {
      expect(redact(`key: ${s} end`).includes(s)).toBe(false)
    }
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123').includes('abcdefghijklmnopqrstuvwxyz0123')).toBe(false)
  })
})

describe('capsule builder', () => {
  test('ingests prompts, files, commands, urls, decisions, open tasks · redacted', () => {
    const l = ledger()
    ingestMessages(l, CHAT, T0)
    expect(l.turns).toBe(1)
    expect(l.firstPrompts[0]).toBe('Fix the shop checkout rounding bug. Always run the tests before you say done.')
    expect(l.prefs[0]).toContain('Always run the tests')
    expect(l.files['C:/work/shop-app/src/lib/totals.ts']).toEqual({ reads: 1, edits: 1, firstTurn: 1, lastTurn: 1 })
    expect(l.commands[0]).toBe('npm test -- totals')
    expect(l.commands[1]).toContain('Bearer [hidden]')
    expect(l.urls).toContain('https://shop.example.com/cart')
    expect(l.decisions[0]).toContain('round to 0.05')
    expect(l.openTasks).toEqual(['Approve the staging deploy.', 'Check the receipt PDF.'])
  })

  test('the same transcript ingested twice counts once', () => {
    const l = ledger()
    ingestMessages(l, CHAT, T0)
    ingestMessages(l, CHAT, T0 + 1000)
    expect(l.turns).toBe(1)
    expect(l.files['C:/work/shop-app/src/lib/totals.ts']!.edits).toBe(1)
  })

  test('prompt.submit counts a repeated prompt; the transcript scan does not add it again', () => {
    const l = ledger()
    addPrompt(l, 'continue please with the build', T0, true)
    addPrompt(l, 'continue please with the build', T0 + 1, true)
    ingestMessages(l, [{ role: 'user', text: 'continue please with the build' }], T0 + 2)
    expect(l.turns).toBe(2)
  })

  test('deterministic fallback: every section from the extract, no model', () => {
    const l = ledger()
    ingestMessages(l, CHAT, T0)
    const md = renderCapsule(l, T0)
    expect(md).toContain('# Context capsule · Fix the shop checkout rounding bug.')
    expect(md).toContain('- Summary: automatic extract (no model)')
    expect(md).toContain(`- Full transcript: C:/Users/tester/.claude/projects/x/${SID}.jsonl`)
    for (const h of ['## Goal', '## Current state', '## Open tasks / next steps', '## Decisions made', '## Preferences (stated in this chat)', '## Files touched', '## Commands / URLs / IDs', '## Last prompts']) expect(md).toContain(h)
    expect(md).toContain('- C:/work/shop-app/src/lib/totals.ts (edited ×1)')
    expect(md).toContain('- Approve the staging deploy.')
    expect(md.includes(FAKE)).toBe(false)
  })

  test('model sections replace the extract where present', () => {
    const l = ledger()
    ingestMessages(l, CHAT, T0)
    const parsed = parseModelSections('## Goal\nFix the rounding.\n\n## Decisions made\n- Round to 0.05.\n\n## Current state\nFixed and tested; token=' + 'abcdef123456' + ' used.\n\n## Open tasks / next steps\n- Deploy to staging.\n\n## Preferences\n- Tests before done.')
    expect(parsed).toBeDefined()
    l.model = { at: T0, model: 'haiku', sections: parsed! }
    const md = renderCapsule(l, T0)
    expect(md).toContain('Fix the rounding.')
    expect(md).toContain('- Deploy to staging.')
    expect(md).toContain('- Summary: haiku,')
    expect(md).toContain('token=[hidden]')
  })

  test('a reply without a goal or a state is rejected (the extract stays)', () => {
    expect(parseModelSections('Sure! Here is a summary of the chat.')).toBe(undefined)
    expect(parseModelSections('## Goal\nx\n## Decisions made\n- y')).toBe(undefined)
  })

  test('the capsule never exceeds its cap', () => {
    const l = ledger()
    for (let i = 0; i < 40; i++) {
      addPrompt(l, `prompt ${i} ` + 'lorem ipsum dolor sit amet '.repeat(30), T0 + i, true)
      l.files[`C:/work/project/folder${i}/file${i}.ts`] = { reads: 1, edits: i % 3, firstTurn: i, lastTurn: i }
      l.commands.push(`npm run task-${i} ` + '--flag '.repeat(20))
    }
    l.lastAnswer = 'x'.repeat(5000)
    for (const cap of [3000, 6000, 9000]) {
      const md = renderCapsule(l, T0, cap)
      expect(md.length <= cap).toBe(true)
      expect(md).toContain('## Goal')
    }
  })

  test('the new chat section is capped and points to the transcript', () => {
    const l = ledger()
    ingestMessages(l, CHAT, T0)
    const text = injectionText(renderCapsule(l, T0), 'Shop app · fix rounding', T0, l.transcript, 4000)
    expect(text.startsWith('# Backup from your previous chat (Shop app · fix rounding, 2026-10-16 10:00)')).toBe(true)
    expect(text).toContain(`the full previous transcript (JSONL) is at: ${l.transcript}`)
    expect(text.length <= 4000).toBe(true)
  })

  test('the model prompt is redacted and bounded', () => {
    const l = ledger()
    ingestMessages(l, CHAT, T0)
    const p = modelPrompt(l, transcriptExcerpt(CHAT))
    expect(p.includes(FAKE)).toBe(false)
    expect(p).toContain('## Preferences')
    expect(p.length < 60_000).toBe(true)
  })

  test('a damaged ledger file loads as a fresh one', () => {
    const fresh = ledger()
    expect(reviveLedger('nonsense', fresh)).toBe(fresh)
    const l = reviveLedger({ turns: 4, prompts: 'not an array' }, fresh)
    expect(l.turns).toBe(4)
    expect(Array.isArray(l.prompts)).toBe(true)
  })

  test('areas and open tasks', () => {
    expect(areaOf(`${ROOT}/Sites/Shop front/src/app.tsx`, ROOT)).toBe('Sites/Shop front')
    expect(areaOf('D:/other/shop-app/src/x.ts', ROOT)).toBe('shop-app/src')
    expect(openTasksIn('## In progress\n- deploy staging\n## Other\n- not this')).toEqual(['deploy staging'])
  })
})
