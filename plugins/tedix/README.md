# Tedix plugin

## Cloud package and first use

For Claude chat, Cowork and Claude Code, see the
[Claude setup guide](docs/claude.md). `--host claude` builds the native Claude
format from the same skills; `--local` adds opt-in context hooks. An explicit
`--mcp-url` selects a self-hosted or local gateway without changing CLI bindings.

Build a reproducible review ZIP from this source with Bun:

```sh
bun packages/cli/scripts/package-plugin.ts /tmp/tedix-public.zip
bun packages/cli/scripts/package-plugin.ts --local /tmp/tedix-local.zip
```

For the default OpenAI artifact, root `plugin.json` owns the canonical `tedix` identity. The builder imports
`review/cases.json` and `review/release-notes.md` as review expectations, not
recorded passes. The current plugin version is the `version` field in
[`plugin.json`](plugin.json); the host reports the installed one. The default cloud
artifact contains the manifest, portable MCP connection, skills and assets.
`--local` adds the opt-in `hooks/hooks.json` and host compatibility files to
the same plugin identity. The hooks contain no scripts: each runs
`tedix hooks <name>` in the installed Tedix CLI, which is their only
requirement, and exits silently when that CLI is not installed. Neither
artifact contains app registrations or credentials.
Building a ZIP does not install, submit or publish it.

OpenAI supports MCP, skills and trusted local hooks in one plugin. Omitting
hooks from the cloud artifact is a Tedix execution-environment choice, not an
OpenAI prohibition: a web installation cannot supply the separately installed
and authenticated Tedix CLI that runs the hooks. Review changed hook definitions
in the local host before enabling them. No second plugin is needed; the only
recorder is the opt-in decision-capture hook described in the Codex guide.

Portable `mcp.json` uses the Agent Plugins `streamable-http` schema. The
host-native `.mcp.json` declares the same remote server with type `http` and
the URL `https://connect.mcp.tedix.dev/mcp`, and nothing else. Neither file
lists scopes or holds credentials: the host's OAuth flow, browser consent and
server enforcement determine access.

`tedix-connect` is the packaged onboarding skill. First use verifies the current
account via `get_profile`, resolves the organization separately, and performs one
bounded read through Code Mode. Ordinary remote workflows need no CLI. Account
identity, organization selection and capability authorization are separate facts.
The profile is authenticated, read-only and independent of organization/scopes;
Code Mode remains the action and composition surface.

Run the scenarios in `validation.json` on a fresh installed chat. Record the
host, package hash, actual account/org, returned receipts and pass/fail per case.
Package tests do not prove OAuth, hook delivery or host behavior. Local hooks
require a local execution host and trust; cloud onboarding uses native tools.
Validate Claude Code separately when that host is in the release scope.

This directory is the shared source for Tedix skills used by ChatGPT Work,
Codex, and Claude Code. Each skill covers one bounded task. The
root portable manifest packages them for ChatGPT
Work and Codex. Claude Code uses `.claude-plugin/plugin.json`. Both hosts load
the same `.mcp.json` connection and skill directories. Host-specific
settings must not copy the procedures or create another credential, skill, or
approval store.

| Request                                   | Skill                                                            |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Find the right Tedix path for a task      | [tedix-session-guide](skills/tedix-session-guide/SKILL.md)       |
| Connect or diagnose Tedix access          | [tedix-connect](skills/tedix-connect/SKILL.md)                   |
| Review a local coding session             | [tedix-guardian-session](skills/tedix-guardian-session/SKILL.md) |
| Delegate a task or follow a tedi run      | [tedix-delegate](skills/tedix-delegate/SKILL.md)                 |
| Resume an existing governed Work Item     | [tedix-resume-work](skills/tedix-resume-work/SKILL.md)           |
| Create or update a Tedix Workspace Output | [tedix-workspace-output](skills/tedix-workspace-output/SKILL.md) |

Use these requests to check host discovery after packaging:

| Skill                    | Should activate                                                     | Should stay idle          |
| ------------------------ | ------------------------------------------------------------------- | ------------------------- |
| `tedix-session-guide`    | “Find the Work for this task”; “Was this Tedix change shipped?”     | “Summarize this Git diff” |
| `tedix-connect`          | “Connect my Tedix account”; “Why does Tedix login fail?”            | “Summarize this Git diff” |
| `tedix-guardian-session` | “Check this session's authority”; “Guardian checkpoint”             | “Run this one Tedix tool” |
| `tedix-delegate`         | “Ask a tedi to handle this”; “How is my tedi run going?”            | “Run this one Tedix tool” |
| `tedix-resume-work`      | “Continue Work Item 123”; “Pick up the admitted Tedix task”         | “List my Work Items”      |
| `tedix-workspace-output` | “Create a report in our Tedix Workspace”; “Update that Tedix sheet” | “Edit this local DOCX”    |

On a local Codex or Claude Code host, use the installed `tedix` CLI and run
`tedix auth status` before a live call. In a host without a local shell, use
its authenticated Tedix MCP connection. The owner completes browser sign-in
and consent; agents never request or store a copied token. Select a workspace
per command with `-w <workspace>` instead of changing the saved default.

The canonical Work execution procedure is the Tedix organization skill
`work-item-operating-protocol`; the
[public agent guide](https://docs.tedix.dev/agent-guide) explains first use.
The session guide chooses a useful Tedix path for a relevant request. It reads
bounded Work state before suggesting execution, asks for a selection when more
than one item fits, and keeps unrelated chats quiet. It does not create Work,
record a conversation, or grant authority by loading a skill.
The host skill format follows the
[OpenAI](https://developers.openai.com/plugins/build/skills) and
[Claude Code](https://code.claude.com/docs/en/skills) guides.

## Use Tedix without the CLI

Connect the plugin through the host's OAuth flow, select your organizations,
and start with the task you want done. The native connection and bundled skills
support Work reads, scoped tools, tedi delegation, and Workspace Outputs without
a local CLI, subject to the actual grant and organization policy. The repository
connection offers the shared human Connect permission catalog, with reads selected
initially in browser consent. Writes and destructive actions require explicit
selection. Review the scopes in the host consent screen; `.mcp.json` declares
only the server type and URL.
`connections.read` permits reviewed reads through verified provider connections.
Provider writes require explicit `connections.execute` consent; destructive actions require `connections.admin`. Platform writes still need their relevant consent.

`tedix-session-guide` chooses the useful path. `tedix-delegate` submits an
explicitly requested task to Home and follows its durable run receipt. Neither
skill silently creates Work, starts a local Attempt, or records unrelated chats.
The CLI adds repository context recovery, shell automation and governed local
execution. A repository policy can require that path.

## ChatGPT Work and Codex installation

See the [ChatGPT Work and Codex first-use guide](docs/chatgpt-codex.md) for
host-specific installation, consent, verification, and troubleshooting.

With an installed Tedix CLI, run `tedix setup agents` to detect Codex and
Claude Code, install this plugin through each host's marketplace, and verify
the installed entries. The CLI does not authorize either host's MCP connection
or trust a Codex hook; complete those steps in the host.

`tedix setup agents --status` reports the plugin and remaining host steps.
`tedix setup agents --update --dry-run` previews a refresh; run without
`--dry-run` to apply it. Git marketplaces refresh through their host manager.
For a local marketplace, update its checkout first: setup preserves that source.

The repo marketplace at `.agents/plugins/marketplace.json` offers the `tedix`
plugin. Add this checkout as a local marketplace with
`codex plugin marketplace add <repo-root>`, then install `tedix@tedix-repo` from
the Plugins Directory or `codex plugin add tedix@tedix-repo`. For a Codex CLI
read-only check, first enable the MCP protocol feature Tedix Connect requires
(`codex features enable mcp_2026_07_28` when `codex features list` shows it
disabled, then restart Codex), run `codex mcp login tedix --scopes mcp:work.read`
and complete the owner OAuth flow. In ChatGPT Work,
enable the local marketplace in the desktop app and start a new Work chat with
the plugin enabled. Register or authorize the bundled remote Tedix MCP
connection through the host's OAuth flow; the plugin contains only the gateway
URL, never a bearer token. A web installation cannot install the Tedix CLI the local hooks run.
ChatGPT on the web is not supported yet: the plugin is not in the ChatGPT
plugin directory, and a developer-mode custom connector is not a tested path.

The plugin's lifecycle hooks are declared in `hooks/hooks.json`, the hosts'
default plugin hook location. Review them in the host's `/hooks` view; Codex
runs them only after you trust them. Every hook runs `tedix hooks <name>`
behind a guard: without the `tedix` command it exits 0 with no output, so a
host without the CLI sees no error and no live authentication or Work facts
are read. With the CLI, each hook still does nothing until you opt in to its
feature. The [CLI guide](https://docs.tedix.dev/cli#set-up-codex-and-claude-code)
lists every hook, when it runs, what it sends and how to turn it off; disabling
or uninstalling the plugin removes them all.

The `SessionStart` hook stays silent unless a repository binding or
`TEDIX_PLUGIN_PREFLIGHT=1` opts in. Set `TEDIX_WORKSPACE` to
choose a CLI profile and `TEDIX_WORK_ITEM_ID` to include one read-only Work
Item summary. It reads auth and board context through the installed `tedix`
CLI at startup, resume, clear, and compaction, so the context is restored after
a host context reset. It does not log turns, start Attempts, or change Work
state. With `TEDIX_WORK_ITEM_ID`, it also shows the latest bounded Attempt state
and lease expiry, which still must be verified before a write. Command hooks
cannot invoke the agent's native MCP tool session through the documented host
interface, and ordinary Chat does not run local hooks.

The source `hooks/hooks.json` registers both `await-reply` (Claude Code) and
`await-draft` (Codex); a marketplace install from this directory gets both, and
each exits at once on the other host. Packaged `--host` artifacts ship only
their host's hook.

The opt-in turn-status reporter is described in the
[Claude Code guide](docs/claude-code.md#opt-in-turn-status). It is silent
until `~/.tedix/agent-status.json` enables it.

Invoke `tedix-guardian-session` for an explicit start, checkpoint, or close
review. It reads current CLI and repo evidence and reports state, evidence,
and next action. The preflight only points to this routine when opted in; it
does not run in the background.
