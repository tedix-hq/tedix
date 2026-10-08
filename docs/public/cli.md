---
sidebar:
  order: 80
title: "Install the Tedix CLI"
topic: "Getting started"
resource_type: tutorial
description: "Install, verify, update, and roll back the Tedix CLI, a small program installed on your machine."
summary: "Public standalone CLI installation and lifecycle guide"
read_when:
  - Installing Tedix without access to the source repository
  - Updating or rolling back the Tedix CLI
  - Verifying Tedix CLI release integrity
visibility: public
---

# Install the Tedix CLI

> The CLI is a public beta that anyone can download. Tedix Cloud, which it
> connects to, is an invited beta; see [Release status](./release-status.md).

The Tedix CLI is a small program installed on your machine. It covers Home
conversations, Code Mode, Work Items, skills, automations, flows, engine
observation, and tedi operations. The standalone
binary includes Bun and its runtime dependencies. You do not need access to the
Tedix source repository or a local Bun installation for gateway operations.
To run the product locally, clone the repository and run `bun run-local`; see
[Getting started](./getting-started.md). The optional `tedix setup` and
`tedix dev` commands wrap that launcher and need Bun and Node.js 22+ for
Wrangler. Inside a checkout, `tedix setup` uses it. Elsewhere it clones the
`cli-v<version>` source release that matches your CLI, so it works only for a
CLI version with a published source release. `tedix setup --yes` selects
offline mode; `tedix dev` resumes the saved installation from anywhere. Local
startup does not require Tedix login. See [Skills, automations, flows, and
runs](./skills-flows-workflows.md) for the execution model.

## Install

macOS and Linux users can install the latest public release with:

```bash
curl -fsSL https://downloads.tedix.dev/install.sh | sh
```

The installer detects the operating system and architecture, downloads the
matching immutable release, verifies it against `SHA256SUMS`, and installs
`tedix` into `~/.local/bin` by default. Downloads retry bounded transient
failures, checksum tools run with a neutral locale, and the installer checks
that the destination is writable before downloading the binary.

The checksum protects against a corrupted or truncated download. It is not a
signature: `SHA256SUMS` is served from the same host as the binaries, and the
beta binaries are not yet code-signed or notarized. See [Verify a
release](#verify-a-release) for the build-provenance attestations.

`~/.local/bin` is not on the default macOS `PATH`, so a new shell cannot find
`tedix` until that directory is added. The installer detects this, appends the
directory to your shell profile (`~/.zshrc`, `~/.bash_profile`, or
`~/.config/fish/config.fish`), and prints exactly what it changed. Open a new
terminal afterwards, or run the export line it prints to use `tedix` in the
current one.

Set `TEDIX_NO_MODIFY_PATH=1` to keep the installer out of your shell profile. It
then only prints the line to add yourself:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify the installation in a new terminal:

```bash
command -v tedix
tedix --version
tedix auth status
```

## Set up Codex and Claude Code

After installing the CLI, run `tedix setup agents` in a terminal. It detects
Codex and Claude Code, shows the exact marketplace and plugin commands, asks
before installing, and checks that each host reports the Tedix plugin. Use
`--codex` or `--claude` to target one host; `--dry-run` previews without
installing. The Tedix plugin carries its skills,
remote MCP connection, and local lifecycle hooks. Each hook runs
`tedix hooks <name>` in this CLI, so the hooks need no other runtime. If the
`tedix` command is not installed, every hook exits immediately with no output.
The marketplace and plugin source ship in the public Tedix repository; the host
fetches them with Git.

Every hook does nothing until you opt in to its feature:

| Hook (`tedix hooks …`) | Runs at                                                                                            | Does, once opted in                                                                                                                                                                    | Opt in with                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-start`        | Session start, resume, clear, compaction                                                           | Reads auth and the bound Work Item from Tedix and adds a short brief to the session. Sends no session content.                                                                         | `tedix setup agents context bind`, or `TEDIX_PLUGIN_PREFLIGHT=1`                                                                                                                                                                                                                                        |
| `prompt-context`       | Each submitted prompt                                                                              | Reads the selected Work's latest comments, connected documents and the organization's approved team lessons for this repository and adds them as context. Never sends the prompt text. | A repository binding; `context select`, `connect-output` or `connect-preferences` add sources. Outside a bound repository, lessons and that organization's `connect-preferences` document, for `TEDIX_ORGANIZATION`, the `context set-default-organization` choice or the profile's single organization |
| `capture-stop`         | End of each turn (background)                                                                      | Sends the turn's final message, redacted and bounded to 6,000 characters, as a question in your organization.                                                                          | `tedix setup agents context enable-decision-capture`                                                                                                                                                                                                                                                    |
| `capture-reply`        | Each submitted prompt (background)                                                                 | Sends your reply to that question, redacted and bounded the same way.                                                                                                                  | Same as `capture-stop`                                                                                                                                                                                                                                                                                  |
| `await-reply`          | End of each turn; Claude Code only, background, up to four hours                                   | Polls that question and wakes the session when you answer it in Tedix OS or a tedi sends an automatic reply.                                                                           | Same as `capture-stop`                                                                                                                                                                                                                                                                                  |
| `await-draft`          | End of each turn; Codex only, may hold the turn up to 5 minutes                                    | Polls that question and continues the turn only for an automatic tedi reply.                                                                                                           | Same as `capture-stop`                                                                                                                                                                                                                                                                                  |
| `status`               | Prompt submit, tool use, permission request, notification, stop, failure, session end (background) | Records a local status line and macOS notification; with a profile, sends the state, session ID, repo/branch and a 160-character summary.                                              | `~/.tedix/agent-status.json` with `"enabled": true`, or `TEDIX_AGENT_STATUS=1`                                                                                                                                                                                                                          |

A tedi auto reply that lands after a Codex session's `await-draft` stopped
waiting reaches nobody, so the session idles. `tedix supervise` checks every
30 seconds and delivers such a reply: through `codex queue` to an open Codex
window, or, with none open, by resuming the session headless with
`codex exec resume`. It sends only drafts the server marked for automatic
delivery, once per question and at most three in a row, and records them like
the hooks do. For Claude Code it only logs a reply that arrived after
`await-reply` stopped waiting. `tedix supervise --once` runs one check;
`tedix supervise install` runs it at login as a user LaunchAgent on macOS
(no `sudo`), and `tedix supervise uninstall` removes it. Activity goes to
`~/.tedix/supervisor.log`.

Undo an opt-in with `context unbind`, `disable-decision-capture`,
`TEDIX_PLUGIN_PREFLIGHT=0` or `TEDIX_AGENT_STATUS=0`. To remove the hooks
entirely, disable or uninstall the Tedix plugin in the host. Codex runs a
plugin hook only after you trust it in `/hooks`.

Run `tedix setup agents --status` to see plugin and marketplace state and the
remaining host login, hook trust, and read-verification steps. An enabled plugin
does not prove an authorized read. To refresh an installed plugin, preview
`tedix setup agents --update --dry-run`, then run `tedix setup agents --update`.
Git marketplaces are refreshed through the host plugin manager. If a marketplace
points to a local checkout, update that checkout yourself first; setup keeps
its source and does not switch or delete it.

To teach Tedix from sessions you already had, run
`tedix learn import-sessions --dry-run`, review the counts and samples, then run
it without `--dry-run`. It reads your local Claude Code and Codex history and
sends only redacted pairs of the agent's last message and your reply, never a
whole transcript, to the organization each repository is bound to. Sessions
outside a repository go to your default organization; anything else is
skipped and counted. Re-running is safe. The pairs become personal lessons
your later sessions receive.

`tedix learn analyze-sessions --dry-run` reads the same sessions whole and
ranks three things per organization: requests you repeat (candidates for a
skill or command), recurring friction such as failing commands, retry loops,
denials and long stalls (candidates for automation or a hook), and decisions
you stated, which your local `claude` CLI extracts (`--no-model` skips them).
Without `--dry-run` it keeps one Work Item per list in each organization and
updates the same items on every run; pass `--project <id>` the first time so
they are filed under a project. Only counts and short redacted paraphrases are
sent.

Plugin installation does not authorize Tedix access. Complete the OAuth flow
in each host for the intended organization and scopes. Review the hooks in each
host's `/hooks` view; Codex skips them until you trust them. CLI login and host MCP
login use separate credentials. See the [Codex](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/chatgpt-codex.md)
and [Claude Code](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/claude-code.md)
guides for those host steps.

To install into another directory you own, such as one already on your `PATH`:

```bash
curl -fsSL https://downloads.tedix.dev/install.sh |
  TEDIX_INSTALL_DIR="$HOME/bin" sh
```

The installer never uses `sudo`. A system directory such as `/usr/local/bin`
works only if your user can already write to it.

## Supported platforms

| Platform    | Architecture            | Public artifact | Installer support |
| ----------- | ----------------------- | --------------- | ----------------- |
| macOS       | Apple silicon (`arm64`) | yes             | yes               |
| macOS       | Intel (`x64`)           | yes             | yes               |
| Linux glibc | `arm64`                 | yes             | yes               |
| Linux glibc | `x64`                   | yes             | yes               |
| Windows     | `x64`                   | experimental    | manual download   |

The beta artifacts are checksum-verified but not yet code-signed or notarized.
Windows remains experimental. Homebrew, Alpine/musl, and baseline pre-AVX2 x64
installations are not currently supported.

## Install an exact version

Pinning a version from `latest.json` or a release manifest makes installs and
rollbacks reproducible:

```bash
curl -fsSL https://downloads.tedix.dev/install.sh |
  TEDIX_CLI_VERSION="VERSION_FROM_MANIFEST" sh
```

The CLI does not silently update itself. For an installer-managed binary, use
the explicit lifecycle commands:

```bash
tedix update --check
tedix update
tedix update "VERSION_FROM_MANIFEST" --force
tedix rollback
```

Checks never change the installation. `tedix update --check <version>` verifies
that an exact release and its platform artifact are published, then compares it
with the current version. Updates fetch fresh bounded metadata, stream the
artifact with a strict size limit, verify its size and SHA-256 hash, smoke-test
it, and atomically replace the active macOS/Linux standalone executable under
an exclusive install lock. One verified previous binary is retained for
`tedix rollback`.

Source-checkout invocations may check releases but refuse update and rollback
mutations, so running `bun packages/cli/src/index.ts update` cannot overwrite an
unrelated standalone installation. Use the installer for the initial install;
use `tedix update <version> --force` for an intentional exact downgrade.

## Verify a release

Release metadata is public:

```text
https://downloads.tedix.dev/latest.json
https://downloads.tedix.dev/releases/<version>/manifest.json
https://downloads.tedix.dev/releases/<version>/SHA256SUMS
```

`manifest.json` records the exact source commit, version, artifact names, sizes,
SHA-256 hashes, and immutable download URLs. `latest.json` is the only mutable
release pointer and is updated after the immutable version files are uploaded.
The release workflow also creates GitHub build-provenance attestations for the
standalone binaries. These attest build provenance; they do not replace Apple
notarization, Authenticode, or the public SHA-256 verification path.

## Sign in

Run the login command. The authenticated Tedix OS launcher opens in your browser
and asks which organization this terminal should use:

```bash
tedix login
tedix auth status
```

Without an organization argument, the CLI opens Tedix Connect to choose
permissions and organizations. Pass a known slug directly with
`tedix login ORG_SLUG` to authorize that organization through Tedix OS. The CLI
resolves each organization's public MCP gateway and opens OAuth against that
resource. It does not require a platform-wide operator login or a
platform-administrator role.

OAuth credentials are stored per workspace under `~/.tedix`. The binary never
contains a Tedix account credential. Follow [Connect to Tedix
Cloud](./learning-paths/first-connection.md) for the expected status fields, a
read-only live gateway check, and recovery steps.

## Find a command

Start with the short command overview:

```bash
tedix --help
```

Then ask for only the command you need:

```bash
tedix code --help
tedix work --help
```

For a complete command index, use `tedix help --map`. The longer reference is
still available with `tedix help --all`. Scripts and coding agents can read the
same help without parsing terminal text:

```bash
tedix help --json
tedix help --json code
tedix help exit-codes
```

Use the exit-code reference when a script needs to distinguish a usage or
connection error from declined work or an operation that is still settling.

Help describes the CLI itself. The tools available inside your organization
can change, so discover those live through Code Mode instead:

```bash
tedix code 'async () => await discover.search({ query: "calendar", limit: 3 })'
```

## Uninstall

Tedix CLI is a standalone file. Removing it does not delete your Tedix
organization, cloud conversations, or locally saved sign-ins.

### Remove the command

If you used the default installer location, remove only the Tedix binary:

```bash
rm -f ~/.local/bin/tedix
hash -r
```

If you set `TEDIX_INSTALL_DIR` when installing, replace `~/.local/bin` with
that directory. Do not delete `~/.local/bin` itself or remove it from your
`PATH`: other tools may use it too.

The updater may retain one rollback binary. If you installed to the default
location and do not need to roll back, you can remove it too:

```bash
rm -f ~/.local/bin/tedix.previous
```

### Remove local sign-ins and history (optional)

By default, uninstalling leaves your saved workspace logins, conversation
metadata, command history, and update cache in `~/.tedix`. This makes a later
reinstall convenient.

To remove saved local OAuth credentials but keep the other local data, sign out
first:

```bash
tedix logout --all
```

To erase all Tedix CLI data from this computer after signing out, remove its
configuration directory:

```bash
rm -rf ~/.tedix
```

This is permanent local cleanup. It does not delete cloud conversations, runs,
or organization data. To install the CLI again later, follow [Install](#install).

## Troubleshooting

- `tedix: command not found`: open a new terminal first, because the
  installer's `PATH` change only applies to shells started after it. If it
  persists, add the install directory yourself with
  `export PATH="$HOME/.local/bin:$PATH"`.
- `install directory is not writable`: if the default `~/.local/bin` was
  previously created with `sudo`, run the exact ownership command printed by
  the installer. Otherwise, pass a writable directory to `sh` with
  `TEDIX_INSTALL_DIR`.
- A checkout alias or function shadows the installed CLI: run `type -a tedix`,
  remove the shadowing `tedix` definition, and give checkout execution a
  distinct name such as `tedix-dev`.
- Checksum failure: stop. Do not execute the downloaded file; retry later or
  install an exact known version.
- Unsupported platform: use a supported macOS/Linux artifact or run the CLI
  from a source checkout with Bun.
- Login failure: confirm the organization slug with your administrator, then
  run `tedix login ORG_SLUG` again. `tedix auth status` shows whether a saved
  workspace is already selected without printing its credential.
