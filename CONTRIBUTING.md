# Contributing

Thanks for looking. Small, sharp fixes are the easiest to take.

## Report a problem

Open an issue with the mod's name, your Claude Code version (`claude --version`), your system, and the exact command, reply or config that went wrong. Take out names and keys.

## Change something

1. Fork and clone. No packages to install.
2. Edit `mods/<name>/`. Each mod has its own README and tests.
3. `home.ts`, `redact.ts` and `footer.ts` inside a mod are copies. Edit them in `shared/` and run `node scripts/shared.mjs`.
4. Run the checks:

```sh
node scripts/shared.mjs --check
claude plugin validate --strict .
claude plugin test mods/done-check
python mods/billing-meter/engine/test_billing.py
```

`claude plugin test` needs no login and makes no model request. `claude plugin validate --strict` also type-checks.

To try your copy in a real session without touching your setup:

```sh
CLAUDE_CONFIG_DIR=/tmp/try claude --plugin-dir mods/done-check
```

## What fits

- It fixes an annoyance you met, not one you imagine.
- It stays quiet when there is nothing to say.
- It opens no network connection.
- Every new rule has a test for what it stops and a test for what it lets through.
- Made-up values only in tests. Put key shapes together from parts (`'ghp_' + 'Ab1'.repeat(12)`), so no scanner trips on them.
