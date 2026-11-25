# Security

Please report a security problem in private: on this repository, open **Security**, then **Report a vulnerability** (a GitHub private advisory). I answer there. Please do not open a public issue for it.

Worth reporting:

- a key in a common format that ends up in a file these mods write
- a way to make a mod run something, or write outside its own folder

## Known limits

- The filter hides common key shapes, not URL passwords, `curl -u`, Basic auth or plain password words; treat the saved files as private.
- `command-deck` and `context-keeper` save parts of prompts and replies. `done-check` does with `/done log on`, and `billing-meter` with `/bill descriptions on`.
- A mod runs with your permissions, like any Claude Code plugin.

Only the newest release gets fixes.
