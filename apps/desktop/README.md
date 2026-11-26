# Tedix desktop app

A small desktop app that opens the Tedix OS chat in its own window, stays in
the menu bar, sets up this Mac for Tedix without a terminal, and runs this
Mac's runners while it is open.

The app includes the `tedix` command-line tool. It copies it to
`cli/tedix` in its own data folder and links `~/.local/bin/tedix` to that
copy, so agents find it on your shell's `PATH`. The Tedix OS page runs
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
- **First run.** Choose **Try a demo** for the bundled sample or **Sign in**
  to use a Tedix account. After sign-in, choose **Open Tedix** or
  **Connect an app**. The setup guide is also in **Settings → General**.
- **Connect an app.** Tedix looks for Mac apps and command-line tools
  separately. If both are installed for the same provider, Tedix uses the
  Mac app's executable. Choose **Connect** to add Tedix to a detected coding tool and
  start its browser sign-in. Claude Code and Codex can check the connection
  with a Tedix read. Fresh ChatGPT Work and Claude Code installs use the
  bundled native plugin marketplace, with hook review in the host. For
  Claude (Cowork), add the `tedix-hq/tedix-plugins` marketplace and install
  Tedix. If marketplaces are unavailable, save the bundled plugin ZIP for
  Claude's upload screen. Local tasks and session sharing are set up separately in
  **Settings → Agents**.
- **The command-line tool.** With no `tedix` installed, the app links its own
  copy and adds `~/.local/bin` to your shell profile if it is missing. A
  separate install is left alone until you choose **Let the app manage it**:
  the app keeps your file as `~/.local/bin/tedix.before-app`, links its copy
  and restarts the runners. **Use the separate install again**
  reverses it.
- **Updates.** The app and the command-line tool update together as one
  thing, "Tedix". The app looks for updates when it starts, every hour,
  and from **Tedix → Check for Updates…**:
  - It downloads a newer app in the background and refuses one whose
    SHA-256 differs from the manifest. After Check for Updates…, the sidebar
    entry and the menus show "Checking for updates…" and then
    "Downloading update… 40%".
  - Then **Update ready** appears at the bottom of the Tedix OS sidebar,
    above the account row (in the bottom-left corner without a sidebar). The
    app draws it over the page and moves the account row up while it is
    there.
  - One click updates, with no question: the app restarts into the new
    version and puts the newest command-line tool in place before it
    starts the runners; with only a newer command-line tool, it does that
    without a restart. Running tasks keep going. While it restarts, the
    window shows "Restarting Tedix…" instead of going blank. The new
    version is copied next to the installed app before the old one quits,
    so only a quick swap happens with no window open. The new start
    reopens the page that was open, and "Updated to <version>" shows once
    in the entry and fades out.
  - If a download, a check you asked for or an update fails, the entry and
    the menus say "Update failed · Try again"; a click tries again, and
    Settings › General says why.
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
  from before. **Settings → General** offers **Go back** after an update that failed, which swaps the two and restarts the runners. The
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
  shows Settings as a panel over the dimmed Tedix window; the close button,
  a click beside the panel or Escape goes back. It has search, the account,
  three sections: General (version and updates, a problem when there is
  one, open at login, appearance, setup guide), This Mac (name, "Let tedis
  edit files and run commands", the tasks running now, a model on this
  Mac, a sample workspace, and the sessions: one switch, a tab per
  agent, a searchable project list) and Agents (the Claude and
  ChatGPT apps, and one row per agent with its next step and a
  switch that lets it take tasks; **Ready** only after Tedix worked inside
  it; one round arrow beside the title looks for agents again; routing,
  rules file and project folder under a collapsed **Advanced**).
  Every button answers at once: it shows a spinner and what it is doing
  ("Checking…", "Signing in…") until it finishes, and the row then shows
  the result. The version row says what the update entry says: checking,
  downloading with its percent, ready with **Restart to update**, failed
  with **Try again**, or up to date and when it was checked. A tool's switch starts or stops only that
  tool's runner: the supervisor reads `~/.tedix/supervisor-runners.json`
  by itself, so other tools keep their tasks.
- **Update when you choose.** While an update is ready, **Update Tedix**
  also shows in the app menu and the menu bar menu. **Check for Updates…**
  in the menu updates at once when one is found, else opens Settings ›
  General with the result. **Check for updates** in Settings only checks
  and shows the result in its row.
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
| `src/setup.ts`         | The setup steps: agents, sign-in, running tasks       |
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
