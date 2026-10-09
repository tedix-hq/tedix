# Use Tedix in Claude Code

## Quick start

1. Add the Tedix marketplace: `claude plugin marketplace add tedix-hq/tedix-plugins`.
2. Install the plugin: `claude plugin install tedix@tedix-plugins --scope user`.
3. In Claude Code, open `/mcp`, select the Tedix server and sign in through the
   browser; pick your organization and review the requested access.
4. Say "Connect my Tedix account" and follow the prompts.

If the [Tedix CLI](https://docs.tedix.dev/cli) is already installed, run
`tedix setup agents --claude` instead of steps 1 and 2; it installs the same
plugin plus the optional local hooks. Use one route, not both. The
plain-English version is at
<https://docs.tedix.dev/learning-paths/first-plugin>.

**Reference.** The rest of this page is detail: install routes, the
authorization model, hooks, turn status and troubleshooting.

For online Claude chat, Cowork and local-only or hybrid package choices, start
with [Tedix in the Claude family](./claude.md). Code's local hooks and Claude's
remote connectors have different execution and authentication boundaries.

The Tedix plugin gives Claude Code six skills (`tedix-session-guide`,
`tedix-connect`, `tedix-delegate`, `tedix-guardian-session`,
`tedix-resume-work`, and `tedix-workspace-output`), a remote Tedix MCP
connection, and opt-in lifecycle hooks (see [Hooks](#hooks)). It does not sign
you in or grant Work execution authority. Complete Tedix sign-in yourself when
prompted.

## Install

If the Tedix CLI is already installed, run `tedix setup agents --claude`. It
previews the Claude Code commands, installs the plugin at user scope, and
verifies the installed entry. Continue with Claude's MCP login and hook review
below. `tedix setup agents --dry-run` previews without installing.

Use `tedix setup agents --status` to inspect the installed state. For updates,
preview `tedix setup agents --claude --update --dry-run` and then run without
`--dry-run`. A local marketplace stays local; refresh its checkout first, then
restart Claude Code or use `/reload-plugins` and review the hook again.

Use a current Claude Code release. Tedix's MCP gateway uses the 2026-07-28 MCP
protocol; Claude Code's v2 client negotiates that protocol with HTTP servers.
The v2 client is the default from Claude Code 2.1.274, including sessions that
do not fetch feature flags. See Anthropic's [MCP client runtime reference](https://code.claude.com/docs/en/mcp#mcp-client-runtimes).

Without the CLI, add the published plugin repository as a Claude Code
marketplace, then install the plugin for your user account:

```sh
claude plugin marketplace add tedix-hq/tedix-plugins
claude plugin install tedix@tedix-plugins --scope user
claude plugin list
```

[tedix-hq/tedix-plugins](https://github.com/tedix-hq/tedix-plugins) carries the
skills and the MCP connection only, with no hooks; it is generated from
`plugins/tedix` on each plugin release. `tedix setup agents` installs the same
plugin with the optional local hooks. Use one route, not both. To test a
local checkout for one Claude Code session instead of installing it, run
`claude --plugin-dir ./plugins/tedix` from the repository root. A session
already open before installation can load the new plugin with
`/reload-plugins`.

## Connect

In Claude Code, open `/mcp`, select the plugin's Tedix server, and complete
the browser OAuth flow. Select the Tedix organization in the Connect consent
flow. The plugin offers the same optional permissions as ordinary `tedix login`:
Tedix feature reads, changes and administration, plus connected app reads,
changes and destructive actions. Browser consent starts with reads selected.
Choose additional access explicitly and review the organizations before approving.
The checked-in `.mcp.json` declares only the server type and URL; the server
offers the permissions during consent. Compare the actual scopes in the host
consent screen.
Updating the plugin does not change an existing grant. Reconnect to review
new choices. Provider grants and organization policy remain enforced.
The bundled server points to Tedix Connect, which serves tools from the
organizations selected in that grant. Its OAuth grant belongs to Claude Code.
Connect does not serve static app tools or catalog resources; use the selected
organization's CLI workspace when those capabilities are needed. Never paste
an access token into the plugin configuration or chat.

For local Tedix work, also install the [Tedix CLI](https://docs.tedix.dev/cli)
and check its own login:

```sh
tedix auth status
tedix login <organization-slug>
tedix -w <cli-workspace> auth status
```

The CLI and Claude Code's MCP connection have separate credentials. Bare
`tedix login` also supports a multi-organization Connect grant; the command
above creates a tenant-bound CLI workspace. Use the workspace name reported by
`tedix auth status` with `-w` for direct calls instead of changing the saved
default. A plugin installation, an OAuth screen, and an MCP tool listing do
not prove that a particular Tedix operation is authorized.

## Check first use

Start a new Claude Code session and invoke `/tedix:tedix-connect`. Ask it to
verify the selected workspace, credential kind, scopes, and one bounded,
read-only call for your task. The other packaged skills are
`/tedix:tedix-resume-work` for an existing Work Item and
`/tedix:tedix-workspace-output` for a Workspace Output. Claude can also load
them when their descriptions match your request.

The session-start hook stays silent unless `TEDIX_PLUGIN_PREFLIGHT=1` is set in
the local session or a valid local chat binding exists. Set `TEDIX_WORKSPACE` to choose a CLI profile and optionally
`TEDIX_WORK_ITEM_ID` to include one read-only Work Item summary. The hook reads
through the installed `tedix` CLI at startup, resume, clear, and compaction and
gives Claude bounded context. With a Work Item id it also reports the newest
bounded Attempt state and lease expiry; it does not create a Work Item, start an
Attempt, or record a conversation. Review the hook command with `/hooks` before
enabling it. A governed Work Item still needs its own accepted outcome, executor
identity, admission, lease, and settlement.

The prompt hook reads current shared preferences, team lessons, project context and recent
Work updates only from the selected CLI binding. It supplies fresh factual
context on a submitted prompt, including supported autonomous turns. It does
not store or upload the prompt. Invalid or conflicting context stays unavailable.

With [decision capture](./chatgpt-codex.md#record-decisions-with-explicit-opt-in)
enabled, Claude Code also runs `tedix hooks await-reply` as a background
`asyncRewake` `Stop` hook. When you answer the waiting question in Tedix OS,
including by accepting a tedi-drafted reply there, it wakes the session with
your answer; a reply typed in the chat, expiry or four hours end the wait.

A tedi-drafted reply is either for review or sent automatically; the
organization decides per draft. Review drafts are accepted or edited only in
Tedix OS and never reach the chat until you answer there. An automatic reply
wakes the session the same way, as `Tedix <tedi> replied for the user
(delegated answer; the user can override any time): "<reply>"`, with the reply
quoted as your delegated answer. The agent acts on it, including routine
bookkeeping, and holds back only for steps that need you yourself.
The [guardrails](./chatgpt-codex.md#automatic-replies-and-their-guardrails)
are the same for Claude Code and Codex: reversible steps only, never an
urgent turn, at most 3 automatic replies in a row, and you can override at
any time. The turn-status reporter records the session as working, so an
automatic reply sends no needs-you notification.

Invoke `/tedix:tedix-guardian-session` at the start, at a material checkpoint,
or before closing a local Claude Code session. It reports current authority,
evidence, and next action from bounded CLI and repo reads. It does not monitor
turns between invocations.

## Hooks

Installing the plugin registers these hooks in Claude Code. Each runs
`tedix hooks <name>` behind a guard: when the `tedix` command is not installed,
the hook exits 0 with no output, so Claude Code shows no error. With the CLI,
each hook still does nothing until you opt in to its feature.

| Event                                                                                                                    | Hook             | Once opted in                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` (startup, resume, clear, compact, fork)                                                                   | `session-start`  | Reads your auth and bound Work context from Tedix and adds a short brief. Sends no session content.                                            |
| `UserPromptSubmit`                                                                                                       | `prompt-context` | Reads selected documents and Work updates. Never sends the prompt text.                                                                        |
| `UserPromptSubmit` (background)                                                                                          | `capture-reply`  | Decision capture: sends your redacted reply, bounded to 6,000 characters.                                                                      |
| `Stop` (background)                                                                                                      | `capture-stop`   | Decision capture: sends the turn's redacted final message, bounded to 6,000 characters, as a question in your organization.                    |
| `Stop` (background, `asyncRewake`, up to four hours)                                                                     | `await-reply`    | Decision capture: wakes the session with your Tedix OS answer or an automatic tedi reply.                                                      |
| `Stop` (up to 320 seconds)                                                                                               | `await-draft`    | Codex only. It is registered when you install from the marketplace and exits at once in Claude Code.                                           |
| `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` (background) | `status`         | Turn status: a local status line and macOS notification; with a profile, sends the state, session ID, repo/branch and a 160-character summary. |

Opt in to the context reads with a repository binding or
`TEDIX_PLUGIN_PREFLIGHT=1`, to decision capture with
`tedix setup agents context enable-decision-capture`, and to turn status as
described [below](#opt-in-turn-status). Undo them with `context unbind`,
`TEDIX_PLUGIN_PREFLIGHT=0`, `disable-decision-capture` and
`TEDIX_AGENT_STATUS=0`. To remove every hook, disable or uninstall the plugin
with `/plugin`. Review the exact commands with `/hooks`.

## Opt-in turn status

`tedix hooks status` reports one status line per local Claude Code or
Codex session at turn boundaries: `working`, `needs_you`, `done`, `error` or
`ended`. It is off until you opt in:

```sh
mkdir -p ~/.tedix
printf '{"enabled": true, "profile": "connect", "organization": "<selected org>"}\n' > ~/.tedix/agent-status.json
```

Restart open sessions afterwards. `profile` names the `tedix` CLI workspace
used for the remote report; without it the hook keeps local state and
notifications only. A Connect profile spans organizations, so set
`organization` to the ID `tedix auth status` lists; otherwise the report goes
to the profile's default organization. `"notify": false` turns off macOS notifications.
`TEDIX_AGENT_STATUS=1` or `0` and `TEDIX_AGENT_STATUS_PROFILE` override the
file for one shell.

A notification appears only when a session starts needing you (a permission
prompt, a question in its last message) or fails. Local state lives in
`~/.tedix/agent-status/`, with failures logged to `report.log` there. The
remote report runs as a detached `tedix code` call and sends only the host,
session ID, state, a 160-character summary and the repo/branch label. The hook
never prints, prompts or waits for the network.

Review the new hook entries in `/hooks` after updating the plugin.

## Troubleshoot

If a skill is missing, check `claude plugin list`, open `/plugin` to inspect
the installed components or errors, then run `/reload-plugins`. If `/mcp`
shows an authentication prompt, complete it in the browser. If an older Claude
Code release cannot connect to Tedix's modern MCP gateway, update Claude Code
and retry. If CLI access fails while MCP access works, check `tedix auth
status`; the two logins are independent.

Anthropic's references: [install plugins](https://code.claude.com/docs/en/plugins/install),
[plugin components](https://code.claude.com/docs/en/plugins/components),
[MCP authentication](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers),
[pinned OAuth scopes](https://code.claude.com/docs/en/mcp#restrict-oauth-scopes),
and [hook lifecycle](https://code.claude.com/docs/en/hooks#hook-lifecycle).
