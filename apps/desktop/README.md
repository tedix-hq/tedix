# Tedix desktop app

A small desktop app that opens the Tedix OS chat in its own window and shows
what the Tedix CLI is doing on this computer.

It is only a face for the CLI. The CLI stays in charge of sign-in, updates,
runners and credentials. The app finds the `tedix` command on your `PATH` or in
`~/.local/bin` and runs it; it does not include a CLI, does not read or store
credentials, and does not call the Tedix API.

The app is unsigned and, for now, meant for your own Mac. It has been run on
macOS only.

## What you can do

- **Chat in Tedix OS.** The window opens `https://tedix.os.tedix.dev/chat`. The
  page fills the whole window; drag the window by the page's top bar. You
  stay signed in between launches. Links to other sites open in your default
  browser.
- **Sign in with an emailed link.** Start the sign-in in the app and click the
  emailed link as usual. The page that opens in your browser offers to open
  the Tedix app, and the app window finishes the sign-in. If that does not
  happen, copy the link and choose **Tedix → Paste Sign-in Link**.
- **Sign in with Google or Apple.** They do not allow sign-in inside an app
  window, so the app opens your normal browser. Sign in there, confirm, and
  choose **Open the Tedix app**. You can also start this from **Tedix → Sign
  In with Browser**. Not yet tried against the live service.
- **See this computer's status.** Choose **Tedix → This Mac…** (`Cmd+Shift+M`).
  The small window shows how many runners are running, how many runs are
  active, whether the process that answers a tedi's requests on this computer
  is up, and the CLI version. On battery it warns that closing the lid stops
  runs. Back, forward and reload are in the **View** menu.
- **Change this computer's settings.** The same window has:
  - a switch for each runner (`enabled`)
  - the machine name (`machineName`)
  - "Let tedis edit files and run commands on this Mac" (`machineWriteMode`)
  - **Sign in** (`tedix -w connect login`), **Update** (`tedix update`) and
    **Restart runners**

The switches edit `~/.tedix/supervisor-runners.json`, the CLI's own settings
file, one line at a time, and then restart the runners. Restarting stops runs
that are in progress. Closing the window quits the app; the runners keep
running because the CLI's supervisor owns them.

## Run it

From the repository root, after `bun install`:

```sh
bun run --cwd apps/desktop dev
```

The first run downloads the Electron program for your system.

## Build the Mac app

```sh
bun run --cwd apps/desktop build
open apps/desktop/dist/mac-arm64/Tedix.app
```

The build has no signing identity, no notarization and no automatic updates.

## Where things are

| File                  | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| `src/main.ts`         | Windows, menu, and the commands the This Mac window calls |
| `src/status.ts`       | Reads the status from the CLI and the files it keeps      |
| `src/runners-file.ts` | Edits `supervisor-runners.json`                           |
| `src/shell.ts`        | Finds and runs `tedix`                                    |
| `panel.html`          | The This Mac window (`src/panel.ts`)                      |
| `src/preload.ts`      | The few functions the This Mac window may call            |

The Tedix OS page runs without access to the app or the computer.
