# Tedix desktop app

A small desktop app that opens the Tedix OS chat in its own window, stays in
the menu bar, sets up this Mac for Tedix without a terminal, and runs this
Mac's runners while it is open.

The app includes the `tedix` command-line tool. It copies it to
`cli/tedix` in its own data folder and links `~/.local/bin/tedix` to that
copy, so coding tools find it on your shell's `PATH`. The Tedix OS page runs
without access to the app or the computer.

The app is not signed or notarized yet and has been run on macOS only.

## What you can do

- **Keep Tedix in the menu bar.** Closing the window leaves Tedix running
  with its icon in the menu bar; it leaves the Dock until a window opens
  again. A click on the icon opens **New Chat…**. Type a message and press
  Return for Tedix Cloud, or choose **On This Mac** for a local model.
  Escape closes the launcher. A right click (or Control-click) opens a
  short menu: **Open Tedix**, **New Chat…**, a line when tasks are paused
  or not running, **Pause Tasks** or **Resume Tasks**, **Settings…** and
  **Quit Tedix**. Pause and Quit ask first while tasks run; paused tasks
  stay paused, also when the app opens again, until **Resume Tasks**.
  The app menu is short too: About, **Check for Updates…**, **Settings…**
  (`Cmd+,`), Hide and Quit; **File → New Chat** is `Cmd+N`. Opened at login, Tedix
  starts in the menu bar without a window.
- **Run this Mac's runners.** The app starts `tedix supervise`, which runs
  the runners in `~/.tedix/supervisor-runners.json`, as its own child
  process, and stops it when you quit (it waits up to 30 seconds before it
  stops the runners by force). If it ends by itself, the app starts it
  again after 5 seconds, waiting longer after each quick end. Its output
  goes to `~/.tedix/supervisor.app.log`; its log stays
  `~/.tedix/supervisor.log`.
  - The first start on a Mac that ran the runners with the command-line
    tool's login service (`dev.tedix.supervisor`, from
    `tedix supervise install`) unloads that service, deletes its file in
    `~/Library/LaunchAgents`, and turns on **Open at Login**, so the runners
    still start when you log in. The app does this on every start, so a
    later `tedix supervise install` is undone too. Macs without the app keep
    using the login service.
  - A supervisor left behind by an app that crashed is stopped; the
    command-line tool also stops by itself when the app that started it is
    gone. One started from a terminal is left alone, and the menu says so.
  - A Mac with no runners starts them from **Set up this Mac**.
  - The copy run from source leaves the runners to the installed app; start
    it with `TEDIX_DEV_RUNNERS=1` to run them from there.
- **Chat in Tedix OS.** The window opens the organization you used last
  (`https://<organization>.os.tedix.dev/chat`), or `https://os.tedix.dev`,
  where the sign-in picks the organization. You stay signed in between
  launches. The window first opens at most of the screen, centred, and
  then keeps its last size and place (in `window.json` in the app's data
  folder) as long as that is on a connected screen. Links to other sites open in your default
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
- **Set up this Mac.** **Settings → General → Setup guide** opens it, and it opens by itself until
  this Mac is signed in, and from a `tedix://setup` link. Five short
  screens, with dashes at the bottom left to move between them (Welcome,
  This Mac, Coding tools, Sessions, Ready); Settings → General → Set up
  this Mac opens them again:
  - **Welcome.**
  - **This Mac:** the sign-in (first Tedix in this app, then this Mac's
    command-line tool with `tedix -w connect login`, started by the app),
    the command-line tool and its version, and opening at login.
  - **Coding tools:** the Claude and ChatGPT apps first, then one row per
    tool found (Claude Code, Codex, Devin, OpenCode) with a **Use for
    tasks** switch and its next step inline (**Add**, **Sign in**, **Check
    read**), **Ready** once that is done; and the project folder. With no
    coding tool installed, one line with links to get one.
  - **Sessions:** whether your coding sessions show in Tedix, on for every
    project unless you change it, with a tab and a list per tool.
  - **Ready:** one line on what is connected after one live check that the
    command-line tool reaches Tedix, or the one thing that still needs you
    with a link to its screen.

  A row shows one short line and one control. Versions, places and what a
  failure said are behind **Details**; a failed step shows its reason and
  **Retry** under the row. The window changes other tools only through
  `tedix setup agents` and the tool's own commands.

- **The command-line tool.** With no `tedix` installed, the app links its own
  copy and adds `~/.local/bin` to your shell profile if it is missing. A
  separate install is left alone until you choose **Let the app manage it**:
  the app keeps your file as `~/.local/bin/tedix.before-app`, links its copy
  and restarts the runners. **Use the separate install again**
  reverses it.
- **Updates.** The app and the command-line tool update together as one
  thing, "Tedix". The app looks for updates when it starts, every four hours,
  and from **Tedix → Check for Updates…**:
  - It downloads a newer app in the background and refuses one whose
    SHA-256 differs from the manifest. Nothing appears by itself until it is
    ready.
  - Then **Update ready** appears at the bottom of the Tedix OS sidebar,
    above the account row (in the bottom-left corner without a sidebar). The
    app draws it over the page and moves the account row up while it is
    there.
  - One click updates. With no task running on this Mac, the app restarts
    into the new version at once and puts the newest command-line tool in
    place before it starts the runners; with only a newer command-line tool,
    it does that without a restart.
  - With tasks running, it asks once: "2 tasks are running. Update when they
    finish?" with **Update when done** and **Update now**; Escape means not
    now. While it waits, the runners finish their tasks and take no new
    ones (the app writes `~/.tedix/app-update-waiting`), so the wait ends.
    A task counts only while its agent process is alive.
  - If an update fails, the entry says so; a click shows why and offers to
    try again.
  - **Check for Updates…** updates like a click on the entry, or says
    "Tedix is up to date" with the version.
- **Nothing is replaced without a click.** Replacing the command-line
  tool stops tasks running on this Mac. So the app never
  replaces the tool and never restarts the runners by itself.
  When the click has to restart the app first, it leaves a note in the
  app's data folder (`update-after-restart.json`) that is good for five
  minutes and for one start: the app deletes it as it starts, and only a
  start that found a fresh note applies the command-line tool. Any other
  start (at login, after installing the app by hand, after a crash) changes
  nothing. This stays so until the tool is signed with an identity that
  does not change between versions.
- **Go back, and see what is wrong.** The app keeps the command-line tool
  from before. **Settings → About** offers **Go back** after an update that failed, which swaps the two and restarts the runners. The
  app never goes back by itself. If `tedix supervise` or every runner stays
  down after a restart, the app says that this Mac's
  runners are down, shows one notification, and offers **Restart runners**.
  If some sessions could not be reopened because macOS does not let Tedix
  read their folder, the app says which folder; it does not treat that as
  runners being down. Keep checkouts outside Documents, Desktop and
  Downloads. `tedix update`
  and `tedix rollback` in a terminal work on the app's copy too; the runners
  use the new version after **Restart** in Settings → This Mac or the next
  start of the app.
- **Change every setting in one place.** **Tedix → Settings…** (`Cmd+,`)
  shows Settings inside the main window; **Done** or Escape goes back. It
  has search, the account, and five sections: General (open at login,
  appearance, setup guide), Coding tools (the Claude and ChatGPT apps, and
  one row per coding tool with its next step and a **Use for tasks**
  switch; **Ready** only after Tedix worked inside it), Sessions (one
  switch, a tab per coding tool, a searchable project list), This Mac
  (name, "Let tedis edit files and run commands", the tasks running now,
  a model on this Mac, a sample workspace) and About (version, updates,
  and whether everything works). A tool's switch starts or stops only that
  tool's runner: the supervisor reads `~/.tedix/supervisor-runners.json`
  by itself, so other tools keep their tasks.
- **Update without stopping work.** With tasks running, the update asks
  once, **Update now** or **Later**; running tasks keep going and their
  runner restarts on the new version when the task ends.

## When something goes wrong

The app writes one line per sign-in, setup and update step to
`~/Library/Logs/@tedix/desktop/tedix.log` (`~/Library/Logs/Tedix Dev/` for the
copy run from source). It holds page addresses without anything after `?` or
`#`, and no tokens, codes or keys.

## Chat with a local model

Choose **Tedix → New Chat… → On This Mac**, or click the menu bar icon
and choose **On This Mac**. This chat needs no Tedix account or local workspace.
You can also open it directly:

```sh
open -na /Applications/Tedix.app --args --local-model
```

Start [Ollama](https://docs.ollama.com/api/openai-compatibility) with a downloaded
model, or start the [LM Studio local server](https://lmstudio.ai/docs/developer/core/server)
with a model available on this Mac. Tedix looks for models from both servers
and shows them in the picker beside the message box. Open **Connections** to
change a port or refresh the list. The default ports are 11434 for Ollama and
1234 for LM Studio. Replies appear as text arrives.

Tedix connects to the local server at `127.0.0.1` without API credentials.
Choose a model on this Mac for on-device inference. Chats last until you close
the window or start a new chat.

## Use Local Tedix without a Cloud account

In Tedix, open **Settings → This Mac**, choose **Open** next to **Local workspace**,
then click **Start on this Mac**. Tedix opens the Revenue Ops sample workspace and saves
its files on this Mac. When you open Local Workspace again, Tedix starts the
service for you. Local Workspace uses a separate session from Tedix Cloud.

The sample workspace ships with AI replies turned off.

### Run a separate local workspace for development

Run `bun run-local` from a Tedix source checkout.

To open the installed app directly in local mode:

```sh
open -na /Applications/Tedix.app --args --local
```

If you set `TEDIX_LOCAL_OS_PORT` on the launcher, pass the same port to the app
with `--local=3048` in place of `--local`.

For AI replies, authenticate Wrangler to your Cloudflare account and start the
stack with Workers AI enabled:

```sh
bunx wrangler login
bunx wrangler whoami
bun run-local --inference --workers-ai-account=YOUR_ACCOUNT_ID
```

The stack stores work on this Mac and sends model requests to Cloudflare. Local
chat shows whether requests go through AI Gateway or directly to Workers AI.
Add `--ai-gateway=YOUR_GATEWAY_ID` to require your gateway or
`--ai-routing=direct` to choose direct Workers AI. See
[Getting started](../../docs/public/getting-started.md) for the local stack's
requirements and options.

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
build picks it up as `Contents/Resources/cli/tedix`. The publish job sets
`DESKTOP_SOURCE_SHA`, which makes `bun run compile` prepare both Local Workspace
payloads from that checkout. For a local packaging test, use
`bun run bundle:local arm64` (or `x64`) before packaging. The installed app
unpacks its payload into its application data folder on the first start.

The CLI fetch script downloads the latest
published CLI from `downloads.tedix.dev` and refuses it unless its SHA-256 is
the one in that release's `SHA256SUMS`; add a version to pin one
(`bun scripts/fetch-cli.ts arm64 0.29.0`). Publish the CLI release the app
needs first. A build without these two steps has no command-line tool inside.

The copy inside the app is only the starting point. A CLI release reaches
installed apps without an app release, through the update entry:

- The app reads `https://downloads.tedix.dev/latest.json` and remembers the
  version. That is all it does by itself. The update entry appears for
  the newer of that version and the copy inside the app when it is newer
  than the app's copy in `cli/tedix` in its data folder and
  `~/.local/bin/tedix` is that copy. A copy inside a new app is used without
  asking only on a first run, when the data folder has no copy yet.
- After the click (and, with a newer app, the restart) the app downloads
  `releases/<version>/tedix-<version>-darwin-<arm64|x64>` and refuses it
  unless its SHA-256 is the one in that release's `SHA256SUMS`. Same rules
  as the app's own update: https from that host only, no redirects.
- The new file is written beside the copy, signed the same way, started once
  to check its version, and renamed over the copy. The copy before is kept
  as `cli/tedix.other-app`; **Go back to version Y** swaps the two files.
  `tedix update` keeps its own `cli/tedix.previous`, which `tedix rollback`
  puts back.
- Then the app stops its `tedix supervise`, starts it again on the new file,
  and waits up to three minutes for the switched-on runners. It reports
  runners as down only when `tedix supervise` is not running or no runner
  started. Lines with "could not read"
  in `~/.tedix/supervisor.log` since the reload are shown as a note about
  folder access, not as a failure, and nothing is put back by itself.
- To keep installed apps from offering a CLI version, do not move
  `latest.json` to it; the app has no pin of its own.

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
| `update.html`          | The update entry (`src/update-button.ts`)             |
| `download.html`        | The downloading window (`src/download-window.ts`)     |
| `src/log.ts`           | Writes the log file                                   |
| `src/status.ts`        | Reads the status from the CLI and the files it keeps  |
| `src/runners-file.ts`  | Edits `supervisor-runners.json`                       |
| `src/runners.ts`       | Starts and stops `tedix supervise` as a child process |
| `input.html`           | The menu bar's input bar (`src/input-bar.ts`)         |
| `src/shell.ts`         | Finds and runs `tedix`                                |
| `settings.html`        | Settings, inside the main window (`src/settings.ts`)  |
| `src/ui-parts.ts`      | Rows and the Sessions list shared with setup          |
| `src/preload.ts`       | The few functions the app's own two windows may call  |
