# Tedix desktop app

A small desktop app that opens the Tedix OS chat in its own window, sets up
this Mac for Tedix without a terminal, and shows what the Tedix CLI is doing
on this computer.

The app includes the `tedix` command-line tool. It copies it to
`cli/tedix` in its own data folder and links `~/.local/bin/tedix` to that
copy, so coding tools find it on your shell's `PATH`. The Tedix OS page runs
without access to the app or the computer.

The app is not signed or notarized yet and has been run on macOS only.

## What you can do

- **Chat in Tedix OS.** The window opens the organization you used last
  (`https://<organization>.os.tedix.dev/chat`), or `https://os.tedix.dev`,
  where the sign-in picks the organization. You stay signed in between
  launches. Links to other sites open in your default
  browser. Back, forward and reload are in the **View** menu.
- **Sign in with an emailed link.** Start the sign-in in the app and click the
  emailed link as usual. The page that opens in your browser offers to open
  the Tedix app, and the app window finishes the sign-in.
- **Sign in with Google or Apple.** They do not allow sign-in inside an app
  window, so the app opens your normal browser, also from **Tedix → Sign In
  with Browser**. Sign in there, confirm, and choose **Open the Tedix app**.
  The app waits 30 minutes for this, also across a restart. If the sign-in
  cannot finish, the app says why and offers to start again. Once you are
  signed in, the menu shows who is signed in instead.
- **Set up this Mac.** **Tedix → Set Up This Mac…** opens by itself until
  this Mac is signed in, and from a `tedix://setup` link. One step per
  screen: the two sign-ins, shown apart (Tedix in this app, and this Mac's
  command-line tool with `tedix -w connect login`, started by the app), the
  command-line tool, adding Tedix to the coding tools it finds (Claude Code,
  Codex, Devin; OpenCode is only detected), the one manual step for the
  Claude and ChatGPT apps, and which coding tools Tedix may start here. Each
  coding tool is asked whether its own Tedix connection is signed in, and
  gets a **Sign in** button only when the tool has a command for it. The
  last screen lists every item as done, skipped or needing attention, with
  one live check that the command-line tool reaches Tedix. Every action
  shows its latest output line, and on failure the reason, Retry and Copy
  details. It changes other tools only through `tedix setup agents` and the
  tool's own commands.
- **The command-line tool.** With no `tedix` installed, the app links its own
  copy and adds `~/.local/bin` to your shell profile if it is missing. A
  separate install is left alone until you choose **Let the app manage it**:
  the app keeps your file as `~/.local/bin/tedix.before-app`, links its copy
  and restarts the background service. **Use the separate install again**
  reverses it.
- **Keep the command-line tool current.** The command-line tool has its own
  releases, more often than the app. The app looks for a newer one when it
  starts and every four hours, downloads it, checks it, puts it in place of
  its copy and restarts the background service so the runners use it. That
  restart stops tasks that are running, so the app first waits for a moment
  without any, for up to 30 minutes. **Tedix → This Mac…** and the
  command-line tool step of **Set Up This Mac…** show the version in use
  and what the app last did, or why an update did not apply, and have
  **Check for command-line tool update**. `tedix update` and
  `tedix rollback` in a terminal work on the app's copy too and restart the
  background service themselves.
- **See and change this computer's status.** **Tedix → This Mac…**
  (`Cmd+Shift+M`) shows the runners, active runs, whether the process that
  answers a tedi's requests on this computer is up, and the CLI version. It
  has a switch for each runner, the machine name, "Let tedis edit files and
  run commands on this Mac", and a button that restarts the runners. The
  switches edit `~/.tedix/supervisor-runners.json` and then restart the
  runners, which stops runs in progress.
- **Update the app.** The app looks for a newer version when it starts and
  every four hours, and from **Tedix → Check for Updates…**. It downloads the
  new version, checks it, and asks before it restarts (**Restart to Update**).

Closing the window quits the app; the runners keep running because the CLI's
supervisor owns them.

## When something goes wrong

The app writes one line per sign-in, setup and update step to
`~/Library/Logs/@tedix/desktop/tedix.log` (`~/Library/Logs/Tedix Dev/` for the
copy run from source). It holds page addresses without anything after `?` or
`#`, and no tokens, codes or keys.

## Run it from source

From the repository root, after `bun install`:

```sh
bun run --cwd apps/desktop dev
```

This copy is called Tedix Dev. It keeps its own data folder
(`~/Library/Application Support/Tedix Dev`), so it has its own sign-in, and it
does not take `tedix://` links: those always go to the installed app. It has
a command-line tool inside only after `bun scripts/fetch-cli.ts arm64` (or
`x64`); without that it uses the `tedix` already on this Mac. To finish
a browser sign-in in Tedix Dev, copy the address of the **Open the Tedix app**
button and pass it on:

```sh
bun run --cwd apps/desktop dev "tedix://sign-in?code=…"
```

## Build the Mac app

```sh
bun run --cwd apps/desktop build
open apps/desktop/dist/mac-arm64/Tedix.app
```

## Publish a release

The app updates itself from `https://downloads.tedix.dev/desktop/`, laid out
like the CLI's releases. It accepts only https from that host, follows no
redirects, and refuses a download whose SHA-256 differs from the manifest.
A release with version `X.Y.Z` (three numbers) publishes, in this order:

1. `desktop/releases/X.Y.Z/Tedix-X.Y.Z-darwin-arm64.zip` and
   `…-darwin-x64.zip`: a zip of `Tedix.app` with the app folder at the top.
2. `desktop/releases/X.Y.Z/manifest.json`:

   ```json
   {
   	"schemaVersion": 1,
   	"version": "X.Y.Z",
   	"sourceSha": "<40-character commit>",
   	"assets": [
   		{
   			"name": "Tedix-X.Y.Z-darwin-arm64.zip",
   			"sha256": "<64 lowercase hex characters>",
   			"size": 123456789,
   			"url": "https://downloads.tedix.dev/desktop/releases/X.Y.Z/Tedix-X.Y.Z-darwin-arm64.zip"
   		}
   	]
   }
   ```

3. `desktop/latest.json`, last, served without caching:

   ```json
   {
   	"schemaVersion": 1,
   	"version": "X.Y.Z",
   	"sourceSha": "<40-character commit>",
   	"manifestUrl": "https://downloads.tedix.dev/desktop/releases/X.Y.Z/manifest.json"
   }
   ```

The app reads `version` from `latest.json`, and `version` and each asset's
`name` and `sha256` from the manifest. It builds the download address itself
from the version and its processor (`arm64` or `x64`).

Build the files on a Mac, from `apps/desktop`. `scripts/fetch-cli.ts` puts the
command-line tool for one processor type in `cli/<arch>/tedix`, where the
build picks it up as `Contents/Resources/cli/tedix`. It downloads the latest
published CLI from `downloads.tedix.dev` and refuses it unless its SHA-256 is
the one in that release's `SHA256SUMS`; add a version to pin one
(`bun scripts/fetch-cli.ts arm64 0.29.0`). Publish the CLI release the app
needs first. A build without these two steps has no command-line tool inside.

The copy inside the app is only the starting point. A CLI release reaches
installed apps without an app release:

- The app reads `https://downloads.tedix.dev/latest.json` and, when that
  version is newer than its copy in `cli/tedix` in its data folder, downloads
  `releases/<version>/tedix-<version>-darwin-<arm64|x64>` and refuses it
  unless its SHA-256 is the one in that release's `SHA256SUMS`. Same rules
  as the app's own update: https from that host only, no redirects.
- The new file is written beside the copy, signed the same way, started once
  to check its version, and renamed over the copy. The copy before is kept
  as `cli/tedix.previous-app`. `tedix update` keeps its own `cli/tedix.previous`,
  which `tedix rollback` puts back.
- The app never replaces its copy with an older one. After an app update, the
  copy inside the new app is used only when it is newer than the copy in the
  data folder. So an app release does not need the newest CLI inside; it
  needs one that is new enough for a first install.
- To hold installed apps on a CLI version, do not move `latest.json` past it;
  the app follows `latest.json` and has no pin of its own.

```sh
bun install --frozen-lockfile
bun scripts/fetch-cli.ts arm64
bun scripts/fetch-cli.ts x64
bun run compile
node_modules/.bin/electron-builder --dir --publish never --mac --arm64 --x64 -c.extraMetadata.version=X.Y.Z
ditto -c -k --keepParent dist/mac-arm64/Tedix.app Tedix-X.Y.Z-darwin-arm64.zip
ditto -c -k --keepParent dist/mac/Tedix.app Tedix-X.Y.Z-darwin-x64.zip
shasum -a 256 Tedix-X.Y.Z-darwin-*.zip
```

An installed app replaces itself only when it runs from a folder it can write
to, such as Applications. The first install is still by hand.

## Where things are

| File                   | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `src/main.ts`          | Windows, menu, sign-in, and the two windows' commands |
| `src/setup.ts`         | The setup steps: coding tools, sign-in, running tasks |
| `src/cli.ts`           | Copies, links and updates the app's command-line tool |
| `setup.html`           | The Set up this Mac window (`src/onboarding.ts`)      |
| `ui.css`               | Colours, buttons, switches and cards of both windows  |
| `src/icons.ts`         | The small drawings both windows use                   |
| `scripts/fetch-cli.ts` | Fetches the command-line tool for a build             |
| `src/update.ts`        | Finds, checks and installs a newer app                |
| `src/log.ts`           | Writes the log file                                   |
| `src/status.ts`        | Reads the status from the CLI and the files it keeps  |
| `src/runners-file.ts`  | Edits `supervisor-runners.json`                       |
| `src/shell.ts`         | Finds and runs `tedix`                                |
| `panel.html`           | The This Mac window (`src/panel.ts`)                  |
| `src/preload.ts`       | The few functions the app's own two windows may call  |
