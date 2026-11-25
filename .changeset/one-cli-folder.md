---
"@tedix/cli": patch
---

The command-line tool keeps everything it stores in `~/.tedix`. On the next `tedix supervise` start it moves runner source copies, the OpenCode plugin, scan rules and archives out of `~/.local/share/tedix` and `~/.cache/tedix`, updates the settings that name them, deletes the old folders, and keeps the newest three backup copies of each settings file.
