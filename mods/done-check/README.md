# done-check

Claude says "done". Did anything check it?

After each turn, done-check looks at what happened:

| The turn | You see |
| --- | --- |
| changed code and ran no build, test or check after the last change | status line: `unverified · 2 files · /done` |
| ran a check, and its latest run failed | status line: `check failed: npm test` |
| ran checks after the last change and they passed | green `verified ✓` in the footer |
| changed only documents, or nothing | nothing |

While a flag is up, your next prompt carries one hidden line that tells Claude to check its work first.

## Install

```text
/plugin marketplace add zed-dz/claude-code-mods
/plugin install done-check@zed-mods
```

## Commands

| Command | What it does |
| --- | --- |
| `/done` | Lists this session's turns: files changed, and whether they were verified |
| `/done insist on` | Claude is sent back once, before it stops, when a turn changed code and nothing checked it. `off` to stop. This can add one model request to a turn. |
| `/done dismiss` | Lowers the flag for this turn |
| `/done off` / `on` | Turns everything off or on, in every chat |
| `/done log on` / `off` | Writes one entry per turn to a day file on your disk. Off by default. |

## What counts as a check

Build, test, lint and type-check commands of npm, pnpm, yarn, bun, node, deno, Python, Rust, Go, .NET, Java, Ruby, PHP, Swift, Zig, Elixir, Flutter, Make, just and Terraform; a `curl` to localhost; and browser tools (Playwright, Chrome, Puppeteer).

- A check must start after the last change. Earlier ones are stale.
- For each command only its latest run counts: failed, fixed, passed reads as verified.
- `grep "npm test"` or `npm install vitest` is not a check.
- A check sent to the background has no result yet, so it does not count.

## Settings

Optional: `~/.claude/zed-mods/done-check/config.json`

```json
{
  "checks": ["^\\./verify\\.sh", "\\bbazel test\\b"],
  "tools": ["^mcp__staging__"],
  "ignore": ["generated/", "vendor/"],
  "insist": false,
  "log": false,
  "logFolder": "~/notes/done"
}
```

`checks` and `tools` are patterns for shell commands and tool names that count as a check. `ignore` lists path parts whose changes do not need one.

## What it misses

- It knows that a check ran, not that the check was the right one.
- A check hidden in a script (`node my-check.js`) is not seen. Add it to `checks`.
- The verdict is per turn. A turn with no changes after an unverified one lowers the flag.

## Privacy

No network, no other programs. Nothing is written to disk unless the log is on. Common key shapes are hidden in the log; URL passwords, `curl -u`, Basic auth and plain password words are not. Treat the log as private.
