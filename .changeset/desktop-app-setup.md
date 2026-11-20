---
"@tedix/cli": minor
---

The Tedix desktop app can now set up a Mac without a terminal, and `tedix setup agents` installs the published plugin.

- `tedix setup agents` adds the plugin from `tedix-hq/tedix-plugins` (`tedix@tedix-plugins`) to Claude Code and Codex. An earlier install from `tedix-hq/tedix` counts as installed and keeps updating from there; no second copy is added.
- `tedix setup agents --status --json` prints, for Claude Code, Codex and Devin, whether the tool is found and whether Tedix is added to it.
- `tedix login` works when the desktop app starts it: it opens the browser and waits. It is still refused in CI and inside a coding agent.
- A `tedix` that the desktop app ships and links from `~/.local/bin` leaves updating to the app: `tedix update` and `tedix rollback` say so and change nothing. Separately installed copies update as before.
- `tedix setup agents` gives a coding tool up to two minutes to answer and up to 14 minutes to fetch the plugin, so a slow connection no longer fails the install.
