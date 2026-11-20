# Tedix desktop app

A small desktop app that opens the Tedix OS chat in its own window and shows
what the Tedix CLI is doing on this computer.

For runners and the CLI's own sign-in and updates, the app only runs the
`tedix` command it finds on your `PATH` or in `~/.local/bin`; it does not
include a CLI. The Tedix OS page runs without access to the app or the
computer.

The app is not signed or notarized yet and has been run on macOS only.

## What you can do

- **Chat in Tedix OS.** The window opens `https://tedix.os.tedix.dev/chat`. You
  stay signed in between launches. Links to other sites open in your default
  browser. Back, forward and reload are in the **View** menu.
- **Sign in with an emailed link.** Start the sign-in in the app and click the
  emailed link as usual. The page that opens in your browser offers to open
  the Tedix app, and the app window finishes the sign-in.
- **Sign in with Google or Apple.** They do not allow sign-in inside an app
  window, so the app opens your normal browser, also from **Tedix → Sign In
  with Browser**. Sign in there, confirm, and choose **Open the Tedix app**.
  The app waits 30 minutes for this, also across a restart. If the sign-in
  cannot finish, the app says why and offers to start again.
- **See and change this computer's status.** **Tedix → This Mac…**
  (`Cmd+Shift+M`) shows the runners, active runs, whether the process that
  answers a tedi's requests on this computer is up, and the CLI version. It
  has a switch for each runner, the machine name, "Let tedis edit files and
  run commands on this Mac", and buttons for `tedix -w connect login`,
  `tedix update` and restarting the runners. The switches edit
  `~/.tedix/supervisor-runners.json` and then restart the runners, which
  stops runs in progress.
- **Update the app.** The app looks for a newer version when it starts and
  every four hours, and from **Tedix → Check for Updates…**. It downloads the
  new version, checks it, and asks before it restarts (**Restart to Update**).

Closing the window quits the app; the runners keep running because the CLI's
supervisor owns them.

## When something goes wrong

The app writes one line per sign-in and update step to
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
does not take `tedix://` links: those always go to the installed app. To finish
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

Build the files on a Mac, from `apps/desktop`:

```sh
bun install --frozen-lockfile
bun run compile
node_modules/.bin/electron-builder --dir --publish never --mac --arm64 --x64 -c.extraMetadata.version=X.Y.Z
ditto -c -k --keepParent dist/mac-arm64/Tedix.app Tedix-X.Y.Z-darwin-arm64.zip
ditto -c -k --keepParent dist/mac/Tedix.app Tedix-X.Y.Z-darwin-x64.zip
shasum -a 256 Tedix-X.Y.Z-darwin-*.zip
```

An installed app replaces itself only when it runs from a folder it can write
to, such as Applications. The first install is still by hand.

## Where things are

| File                  | What it does                                               |
| --------------------- | ---------------------------------------------------------- |
| `src/main.ts`         | Windows, menu, sign-in, and the This Mac window's commands |
| `src/update.ts`       | Finds, checks and installs a newer app                     |
| `src/log.ts`          | Writes the log file                                        |
| `src/status.ts`       | Reads the status from the CLI and the files it keeps       |
| `src/runners-file.ts` | Edits `supervisor-runners.json`                            |
| `src/shell.ts`        | Finds and runs `tedix`                                     |
| `panel.html`          | The This Mac window (`src/panel.ts`)                       |
| `src/preload.ts`      | The few functions the This Mac window may call             |
