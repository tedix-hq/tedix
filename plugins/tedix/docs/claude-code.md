# Use Tedix in Claude Code

For online Claude chat, Cowork and local-only or hybrid package choices, start
with [Tedix in the Claude family](./claude.md). Code's local hooks and Claude's
remote connectors have different execution and authentication boundaries.

The Tedix plugin gives Claude Code the `tedix-connect`, `tedix-guardian-session`,
`tedix-resume-work`, and `tedix-workspace-output` skills, a remote Tedix MCP
connection, and an optional session-start preflight. It does not sign you in or
grant Work execution authority. Complete Tedix sign-in yourself when prompted.

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

Add the Tedix repository as a Claude Code marketplace, then install the plugin
for your user account:

```sh
claude plugin marketplace add tedix-hq/tedix
claude plugin install tedix@tedix --scope user
claude plugin list
```

The marketplace command needs Git access to the Tedix repository. To test a
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
The checked-in `.mcp.json` supplies the local permission catalog. Compare
the actual scopes in the host consent screen.
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

The prompt hook reads current shared preferences, project context and recent
Work updates only from the selected CLI binding. It supplies fresh factual
context on a submitted prompt, including supported autonomous turns. It does
not store or upload the prompt. Invalid or conflicting context stays unavailable.

Invoke `/tedix:tedix-guardian-session` at the start, at a material checkpoint,
or before closing a local Claude Code session. It reports current authority,
evidence, and next action from bounded CLI and repo reads. It does not monitor
turns between invocations.

## Opt-in turn status

`hooks/agent_status.py` reports one status line per local Claude Code or
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
