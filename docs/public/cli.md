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

**Do you need the CLI?** Most people use Tedix through the plugin in Claude or
ChatGPT; see [Use Tedix in ChatGPT, Codex and
Claude](./learning-paths/first-plugin.md). The CLI is for developers,
operators, and local hooks.

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
then only prints the line to add yourself. It does the same for any directory
you choose with `TEDIX_INSTALL_DIR`:

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

| Hook (`tedix hooks …`) | Runs at                                                                                            | Does, once opted in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Opt in with                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-start`        | Session start, resume, clear, compaction                                                           | Reads auth and the bound Work Item from Tedix and adds a short brief to the session. Sends no session content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tedix setup agents context bind`, or `TEDIX_PLUGIN_PREFLIGHT=1`                                                                                                                                                                                                                                        |
| `prompt-context`       | Each submitted prompt                                                                              | Reads the selected Work's latest comments, connected documents and the organization's approved team lessons for this repository and adds them as context, plus one line per open delegation this session registered with `tedix work delegate`. With decision capture on, it also lists up to five open requests from your request ledger. Never sends the prompt text. Reads run in parallel; the preferences document, the lessons and the organization check are cached for ten minutes per profile, organization and user under `~/.tedix/hook-cache/`. `TEDIX_HOOK_TRACE=1` prints per-step timings to stderr. | A repository binding; `context select`, `connect-output` or `connect-preferences` add sources. Outside a bound repository, lessons and that organization's `connect-preferences` document, for `TEDIX_ORGANIZATION`, the `context set-default-organization` choice or the profile's single organization |
| `capture-stop`         | End of each turn (background)                                                                      | Records the redacted turn and tool-failure digest in your private request ledger. Triage creates a question only when the turn needs attention; an explicit FYI classification creates no question. Deck routing then selects valuable decisions.                                                                                                                                                                                                                                                                                                                                                                   | `tedix setup agents context enable-decision-capture`                                                                                                                                                                                                                                                    |
| `capture-reply`        | Each submitted prompt (background)                                                                 | Sends your reply to that question, redacted and bounded the same way. It also uploads each message you type, redacted the same way, for your private request ledger; on Tedix a small model records its requests, questions and decisions in the background.                                                                                                                                                                                                                                                                                                                                                        | Same as `capture-stop`                                                                                                                                                                                                                                                                                  |
| `await-reply`          | End of each turn; Claude Code only, background, up to four hours                                   | Wakes the session with every answer you gave in Tedix OS to its questions (not only the newest), or a tedi automatic reply, and records each delivery once.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Same as `capture-stop`                                                                                                                                                                                                                                                                                  |
| `await-draft`          | End of each turn; Codex only, may hold the turn up to 5 minutes                                    | Continues the turn with your pending Tedix OS answers to the session's questions, or an automatic tedi reply, and records each delivery once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Same as `capture-stop`                                                                                                                                                                                                                                                                                  |
| `status`               | Prompt submit, tool use, permission request, notification, stop, failure, session end (background) | Records a local status line and macOS notification; with a profile, sends the state, session ID, the session's name (its Claude Code `/rename` title or Codex thread name, else folder · branch), the bound project and Work Item, and a 160-character summary.                                                                                                                                                                                                                                                                                                                                                     | `~/.tedix/agent-status.json` with `"enabled": true`, or `TEDIX_AGENT_STATUS=1`                                                                                                                                                                                                                          |

A tedi auto reply that lands after a Codex session's `await-draft` stopped
waiting reaches nobody, so the session idles. `tedix supervise` checks every
30 seconds and delivers such a reply: through `codex queue` to an open Codex
window, or, with none open, by resuming the session headless with
`codex exec resume`. It sends only drafts the server marked for automatic
delivery, once per question and at most three in a row, and records them like
the hooks do. For Claude Code it only logs a tedi draft that arrived after
`await-reply` stopped waiting; your own answers are delivered as described
next.

Each answer you give in Tedix OS to a session's question is recorded as
saved, delivered, acknowledged (the session ran a turn on it) or handed off,
and the question page shows which. The supervisor also delivers answers no
hook delivered: a closed Claude Code session is resumed headless with
`claude -p --resume` in its directory (a session open in a terminal never is;
its hooks deliver there), and a Codex session gets `codex queue` or
`codex exec resume`. An answer still undelivered after two hours becomes a
delegated Work Item for your lead session, the one that registers
delegations with `tedix work delegate`. The supervisor reads a session's
context in that session's checkout without changing its own working
directory, and when a read fails its log names the exit code or signal and
the end of the child's error output. A session with no status update for 12
hours counts as ended, and `tedix supervise` and `tedix hooks status` remove
status files untouched for 7 days. `tedix supervise --once` runs one check;
`tedix supervise install` runs it at login as a user LaunchAgent on macOS
(no `sudo`) and reinstalls over a loaded agent by waiting for the old job to
unload and confirming the new one, and `tedix supervise uninstall` removes
it. Activity goes to `~/.tedix/supervisor.log`. On macOS the supervisor skips a
headless resume in a privacy-protected folder (Documents, Desktop, Downloads)
and logs why; [Full Disk Access for the supervisor](./supervisor-full-disk-access.md)
lifts that.

To hand accepted Work to an existing Codex chat, run
`tedix work handoff <id> --host codex --to codex:<chat-id> --launch`. The chat
must be bound to the same profile, organization and Work project; the
supervisor delivers the item once the chat is idle and the Work is ready.
Repeating the command keeps the delivery receipt. The chat still starts its
own Attempt; a handoff completes nothing.

### Answer delivery

The hooks and the supervisor use four `tedix work` verbs, which you can also
run yourself:

- `tedix work interaction-undelivered`: lists your answers that have not yet
  reached the session that asked.
- `tedix work interaction-ack`: records that an answer was delivered to its
  session.
- `tedix work interaction-draft-delivered <id>`: records that a tedi's
  automatic reply reached the session; this answers the question on the
  server in the tedi's name, so it leaves your "For you" inbox. A later reply
  of your own is still recorded and delivered to the session as a correction.
- `tedix work delegate "<title>" --done-when "…" --via subagent|session`:
  registers a lead session's hand-off as an accepted Work Item;
  `tedix work delegate --done <id> --note "…"` records the outcome and
  completes it.

`tedix work interaction-respond <id> --input "…" --no-deliver` answers a
question without delivering it to the asking session, for closures such as
"status update, not an ask". The question page shows "Closed (no delivery)".

`tedix agent rename` names a profile's agent after this machine and user (or
`--display-name`), so sessions on this machine no longer appear as whichever
agent first set the profile up.

Mint a bootstrap credential for a cloud agent from a signed-in owner's terminal:

```sh
tedix agent mint --platform claude-cloud --for me
tedix agent mint --platform codex-cloud --for person@example.com \
  --scopes contributor --expires 30d --name "Cloud contributor"
tedix agent mint --platform devin-cloud --for me --json
```

`--platform` accepts `claude-cloud`, `codex-cloud`, or `devin-cloud`;
`--for` accepts `me` or an active human member's email in the selected
organization. `--scopes` defaults to `read-only` (`mcp:work.read` and
`mcp:observe.read`); `contributor` adds `mcp:work.write`. An explicit
comma-separated list must use the current cloud enrollment capability scopes;
unknown scopes, broad capabilities, admin scopes, and settings scopes are refused.
Expiry defaults to `30d` and accepts whole days from `1d` through `90d`.

The command creates an expiring, bootstrap-only key with no direct API scopes
and a principal with a separate capability ceiling. It prints the raw key once,
followed by the platform setup block, and saves no agent credential to disk.
`--json` puts the key only in `rawKey`; `setup` contains instructions without
another copy. Keep the output private. A failed principal creation triggers
revocation of the newly created key.

In a Tedix source checkout, each platform's setup block runs the same one-line
repository bootstrap:

```sh
sh scripts/agent-bootstrap.sh
```

It installs the released Tedix CLI, adds its install directory to the setup
process's `PATH`, installs the repository's frozen Bun dependencies, and prints
the CLI version and read-only authentication status. Set `TEDIX_WORKSPACE` in
the cloud environment to keep later CLI calls on the same profile.

For Claude cloud, paste the key into Network secrets for host
`connect.mcp.tedix.dev`, header `X-API-Key`, with an empty prefix. For current
Codex cloud environments, use network secret `TEDIX_AGENT_KEY` and allow
`connect.mcp.tedix.dev`; legacy environments that strip secrets before the
agent phase are unsupported. For Devin cloud, add `TEDIX_AGENT_KEY` to Secrets
and reference `${TEDIX_AGENT_KEY}` in the CLI path; never use the MCP Auth Header.
Devin runtime access remains unverified until its pilot. The printed variables
are for the cloud profile consumer; minting alone does not verify a cloud
session or install the CLI. Owner login still requires a human terminal.

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

To bring a new member's history in, run `tedix learn onboard --dry-run`, then
`tedix learn onboard`. The dry run quickly shows session counts per host and
organization, preference-note counts and topic candidates from titles, without
a model or board matching; nothing is saved or sent. For the full model
preview, use `tedix learn onboard --dry-run --with-model`; it runs in the
foreground and takes a few minutes.

Onboarding runs the four steps below in order, in the
background (`--wait` keeps it in the foreground; running it again resumes a run
that stopped), and creates nothing on the shared board until you accept it.
Its proposals arrive in your Tedix inbox (Work > Interactions).

`tedix learn profile` writes "What Tedix knows about you", a document in your
private Tedix workspace, "<Name> (private)": only you and your own tedis and
agents can see it, and it cannot be shared. It opens with your week in plain language, then three
things it can do for you now: a task handed to a tedi, a factory, or a
drafted document, chosen by your goals, what is at stake (a customer, a
deadline, revenue, someone blocked) and how recent it is. Each is a
proposal in your inbox, and earlier proposals it no longer picks are
withdrawn. Accepting one starts it straight away: a task is created and handed
to the tedi it names (or your organization's default tedi), a factory is
planned for you to switch on with `tedix factory create`, and a document is
drafted in your space. The answer in your inbox says what started and links to
it; accepting again starts nothing twice. The week names only products,
people, numbers and versions found in your sessions. Then come at most 12
workstreams, weighted by the days you worked on them and what shipped, each
with its threads, where it stands, and a board
project only when your sessions show one (its Work, its key, or a repository
path it names). Then the open loops you left, with the session to resume or
the commit; workflows Tedix could take over as a skill or a scheduled
factory; the people and customers you work with; and how you like to work. It reads
every local transcript in full, sub-agents and supervisor runs included, and
your local `claude` (haiku, else `codex`) summarises each session, then each
body of work, then you. Summaries are cached, so a re-run only reads new
sessions. A workstream keeps its name and its place in the document across
runs while its project, repository or sessions stay the same, so a re-run
updates the same sections. Transcripts stay on your machine; only the
document and the proposals are uploaded, without secrets, email addresses or phone numbers.
People's names appear only in your document, never in a proposal. `--dry-run`
counts sessions and model calls without a model; `--no-upload` writes the
document only to a local preview.

To teach Tedix from sessions you already had, run
`tedix learn import-sessions --dry-run`, review the counts and samples, then run
it without `--dry-run`. It reads your local Claude Code and Codex history and
sends only redacted pairs of the agent's last message and your reply, never a
whole transcript, to the organization each repository is bound to. Sessions
outside a repository go to your default organization; anything else is
skipped and counted. Re-running is safe. The pairs become personal lessons
your later sessions receive. Preference notes your agents already keep (Claude
Code memories of type `user` or `feedback`, and the preference section of
Codex's memory summary) join them; project memories stay on your machine.

`tedix learn analyze-sessions --dry-run` reads the same sessions whole and
ranks three things per organization: requests you repeat (candidates for a
skill or command), recurring friction such as failing commands, retry loops,
denials and long stalls (candidates for automation or a hook), and decisions
you stated, which your local `claude` CLI extracts, or `codex` when Claude Code
is not installed (`--no-model` skips them).
Without `--dry-run` it keeps one Work Item per list in each organization; each
person's run replaces only their own section of it. Pass `--project <id>` the
first time so the items are filed under a project. Only counts and short
redacted paraphrases are sent.

`tedix learn context` finds the work your sessions show (tasks, goals and
projects, from session titles, Codex goals and your first requests) and checks
each against the organization's projects and Work, open and recently finished.
Work already on the board is reported, not filed again. A task that fits a
project but is not on the board becomes a proposal in your Tedix inbox, with the
sessions it came from and the closest item already on the board. A project or
goal with three or more of its own tasks and no project or epic on the board
becomes one epic proposal with those tasks under it. Accept or decline each
proposal in Tedix OS, in chat, or with `tedix learn review` (which also takes
`--accept all`, `--accept 1,3`, `--reject 2`). Accepting creates the Work; a
declined proposal is never asked again, and running both commands again creates
nothing twice. Only short paraphrased titles and redacted session titles leave
your machine; the names of people your sessions mention are removed from both.

Plugin installation does not authorize Tedix access. Complete the OAuth flow
in each host for the intended organization and scopes. Review the hooks in each
host's `/hooks` view; Codex skips them until you trust them. CLI login and host MCP
login use separate credentials. See the [Codex](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/chatgpt-codex.md)
and [Claude Code](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/claude-code.md)
guides for those host steps, and the
[Claude chat and Cowork](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/claude.md)
guide for a connector without the CLI. The short human walkthrough for every
host is [Use Tedix in ChatGPT, Codex and Claude](./learning-paths/first-plugin.md).

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

Run the login command in a human terminal outside Claude Code or Codex. Login
refuses agent harnesses and noninteractive terminals because another consent
can replace the shared CLI grant. The authenticated Tedix OS launcher opens in your browser
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
read-only live gateway check, and recovery steps. During macOS dark wake,
renewal is deferred before sending a request; wake the Mac fully and retry.

Several terminals and hooks can share one login safely. The CLI records each
renewal before sending it and never reuses an old token when the result is
unknown, for example after a lost reply, a killed process or a failed save.
Reusing one would make the sign-in service end the whole login for every
session. In that case the command asks you to run `tedix login` again;
ordinary renewals continue without any action.

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

## Read your Deck and Feed

Use the same ranked attention view as Tedix OS:

```bash
tedix deck list --json
tedix deck show <card-id> --json
tedix feed --json
```

`deck list` returns the full gated queue's `count`, a bounded `cards` list and
`complete`. A false `complete` means a source is truncated; it must not be
treated as an exact total. Unavailable sources fail the request. Choose an app
when several visible Work apps have the same role:
`tedix deck list '{"gadgetId":"<uuid>"}'`. Pass a viewer timezone with
`{"timeZone":"Europe/Berlin"}` for scheduled cards. Without an override,
the reader uses your saved OS timezone preference.
Reads inspect the authenticated caller's inbox, OS app configuration, ranking
model and learning history. An agent credential does not become its owner's
login. Inspection records no impression and consumes no attention budget.

`tedix deck decide <card-id> '<decision-json>'` saves bounded, unprotected
interaction responses using the original response payload and expected version.
The server refuses critical questions, protected or irreversible decisions,
executable effects, handoffs and governed approvals before saving a response.
Use the linked OS card or ask Home for the human approval flow. Factory feedback uses
`kind: "factory"`, `cardId`, `expectedRevision`, `verdict` (`useful` or
`not_useful`) and `reason`; it saves the configured sheet cells and learning
signal without executing its proposed action. Provider actions and factory skill
execution retain their owning tools.
Use `tedix deck --help` and the configured tool schema to inspect the payload.
The CLI resolves the configured native MCP wire name through the authenticated
catalog before invoking a tool; it refuses mismatched endpoints and schemas.

Native `decide_deck_card` calls wrap the typed domain payload as
`{"decision": {"kind": "interaction", "decision": {"requestId": "…"}}}`; the CLI
adds this envelope while keeping the command syntax above.

For connected agents the corresponding configured RPC tools are
`list_deck_cards`, `get_deck_card`, `decide_deck_card` and `list_feed_for_you`.
Read tools require messaging read scope plus the scopes of their OS, Work and
learning sources. Decisions require messaging write scope and the original
resource's designation and mutation authority. These tools must be installed
in the operator's catalog; a source checkout does not install them.

## Needs-you decisions in local hosts

With the optional context hooks active, Claude Code, Codex CLI and Devin CLI
receive a compact **Needs you** block at session start.
It reads the signed-in person's Deck through `tedix deck list`, using the same
valuable-only gate and ranking as Tedix OS. Up to three new cards include an
ask, why now and a Deck deep link. The block has at most five lines and 1,800
UTF-8 bytes; private draft bodies and source text are excluded, and displayed
text is redacted. Empty, unavailable or ambiguous reads produce no block.

Delivery receipts contain hashes only, scoped to this chat, signed-in person,
gateway and freshly verified organization. Cards already shown in this chat
stay quiet, including after an organization switch and return. A new chat can
show still-relevant cards again. Prompt hooks do not reload the Deck. Links use
the active organization's hostname and the card's source path; self-hosted
installations can set `TEDIX_OS_URL` to their OS origin.
External-agent credentials do not read the owner's personal Deck.

Set `TEDIX_NEEDS_YOU=0` to silence this block while keeping other context.
`TEDIX_PLUGIN_PREFLIGHT=0` silences both context hooks. Neither switch enables
decision capture or any write permission.

The injected hint allows the agent to discover and call `show_deck` when the
connected catalog provides it. MCP App hosts can render the interactive view;
terminal hosts use text and links. Remote Claude, ChatGPT and Codex cloud use
MCP server guidance and the bundled session guide to discover `show_deck` or
`show_feed` when asked what's next, at a Tedix session's start, or after a task.
They must respect quiet requests and skip repeated or empty results. This is
guidance during active turns, not a background wake-up or proof of host render.

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

## Devin CLI, Desktop and cloud

Install the Tedix plugin in your personal Devin scope first:

```sh
devin plugins install tedix-hq/tedix#plugins/tedix -y
devin plugins info tedix
devin mcp login tedix
```

Skills and MCP declarations follow your personal account to CLI, Desktop and
cloud sessions. Connect cloud MCP access through **Customize → MCPs**; complete
OAuth yourself. Local plugin hooks need the Tedix CLI and run only in CLI and
Desktop. Installation does not prove MCP authorization or hook execution.
The Devin CIMD client ID is pending; OAuth readiness remains unverified.
See the [Devin plugin guide](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/devin.md).

Use the following local setup as a fallback when you need hooks and MCP
configuration without installing the plugin's skills:

Install [Devin CLI](https://docs.devin.ai/cli), then complete its browser login
yourself. With an existing authorized Tedix CLI workspace:

```sh
devin auth login
tedix setup agents --devin --yes
devin mcp login tedix
```

Setup merges `~/.config/devin/config.json` and `mcp_config.json`, preserving
unrelated hooks, settings and servers. A conflicting `tedix` server or invalid
JSON stops setup. It installs opt-in Tedix session, prompt, capture and status
hooks, turns off automatic commit attribution, and disables Claude configuration
imports in Devin to prevent duplicate Tedix hooks and incompatible Claude-only
hooks. Existing Claude files remain intact. Repository `AGENTS.md` loads natively.
Each host's MCP OAuth grant remains separate from the CLI login.

From a source checkout, after both browser logins, run this read-only smoke test
with a project in your selected organization:

```sh
tedix lane run --executor devin --brief packages/cli/examples/devin-smoke.txt --project <project-id>
```

The smoke test uses a model turn and reports lane telemetry. It asks Devin to
read its MCP profile and selected organization, without changing Work or files.
Check for `DEVIN_TEDIX_SMOKE_OK`; a successful process exit alone does not prove
the MCP read succeeded. Source development can substitute
`bun packages/cli/src/index.ts` for `tedix`.

Use `tedix setup agents --devin --dry-run` to preview setup. To enable context
reads, bind the repository using `tedix setup agents context bind` or launch
Devin with `TEDIX_PLUGIN_PREFLIGHT=1`. Decision capture and status keep their
existing explicit opt-ins; setup alone does not enable uploads.

Plugin hooks defer to matching setup hooks marked `tedix-managed-devin-hook`
and to governed lane hooks. This requires a CLI with Devin plugin support;
older CLIs fail open for plugin hooks. Setup remains a local fallback so it
does not change your personal Devin Cloud plugin scope.
