---
sidebar:
  order: 37
title: "Give the supervisor Full Disk Access on macOS"
topic: "Platform"
resource_type: guide
description: "Let the background Tedix supervisor resume Codex and Claude Code sessions checked out in Documents, Desktop or Downloads, with a grant that survives CLI updates."
summary: "Create a self-signed code-signing certificate named 'Tedix CLI (local)', run tedix update, then add ~/.local/bin/tedix under Full Disk Access"
read_when:
  - The supervisor log says a session was "not resumed headless" because its folder is privacy-protected
  - Answers do not reach sessions checked out under ~/Documents
visibility: public
---

# Give the supervisor Full Disk Access on macOS

`tedix supervise install` runs the supervisor as a macOS background service.
macOS privacy protection keeps background services out of Documents, Desktop,
Downloads and iCloud Drive. The supervisor still delivers answers to open
sessions there, but it cannot resume a closed Codex or Claude Code session
whose checkout lives in one of those folders. Its log says so with
"not resumed headless".

Keeping checkouts elsewhere (for example `~/code`) avoids this entirely. To keep
them where they are, grant the CLI Full Disk Access. Release binaries are
ad-hoc signed, so macOS would forget a grant at every update. A local signing
identity keeps the grant across updates. Tedix never creates it for you.

## Three steps, once

1. Open **Keychain Access**, choose **Keychain Access > Certificate Assistant >
   Create a Certificate…**, name it exactly `Tedix CLI (local)`, set
   **Identity Type** to **Self-Signed Root** and **Certificate Type** to
   **Code Signing**, and create it in the login keychain.
2. Run `tedix update`. With that identity present, the CLI re-signs
   `~/.local/bin/tedix` with it, and does so again after every update.
3. Open **System Settings > Privacy & Security > Full Disk Access**, click
   **+**, add `~/.local/bin/tedix` (press **Cmd+Shift+G** to type the path), and
   turn it on. Then restart the supervisor with
   `tedix supervise uninstall && tedix supervise install`.

`codesign -d -r- ~/.local/bin/tedix` then shows
`identifier "dev.tedix.cli" and certificate leaf = …`, which stays the same
across updates.
