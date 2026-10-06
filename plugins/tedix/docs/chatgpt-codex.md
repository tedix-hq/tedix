# Use Tedix in ChatGPT Work and Codex

The first public release remains **1.0.0** while preparing review. Its portable
package has one canonical `tedix` identity and a remote HTTPS MCP endpoint.
The default cloud artifact omits local scripts and registered `.app.json`
references. The local artifact adds opt-in hooks under the same plugin identity.
OpenAI allows a plugin to combine MCP, skills and trusted local hooks; a web
installation cannot supply the local script execution environment.

The Tedix plugin packages shared skills, a remote Tedix Connect MCP
server, and an optional local session preflight. Installation makes these
components available; an owner must separately authorize the MCP connection
before it can read Tedix data. A Work execution Attempt requires its own
accepted outcome and verified executor identity.

For an ordinary Tedix-related task, `tedix-session-guide` helps the host find
the relevant Work, choose between a direct tool, Home/tedi delegation, and a
Workspace Output, then check the result against current evidence. It stays
idle for unrelated work. This is skill routing, not a background monitor or an
automatic Work Item creator.

## Start without installing the CLI

Install or enable the complete Tedix plugin in the host and connect its Tedix
app through OAuth. The bare custom MCP connection alone has no bundled skills.
No local CLI or hook is needed for ordinary connected workflows. Start with:

- “Find the Work relevant to this task in my organization.”
- “Ask a tedi to help with this task and show the run's progress.”
- “Save this result as an Output in this Tedix Workspace.”

The guide discovers exact tools under the selected organization's namespace,
uses the actual grant, and asks when the organization or destination is unclear.
It does not require a shell just because the host has one. Expand capabilities
through the host's connection management and Tedix consent flow when a requested
operation needs them. A grant change does not repair a missing tool mapping.

Skills and remote tools supply the core workflow. Local hooks add repository
context recovery; they run command scripts and cannot directly call model-native
plugin tools or borrow host OAuth credentials. A CLI-free opted-in hook gives
only routing guidance. Keep the CLI when local automation or repo policy requires
it. Ordinary Chat does not execute local hooks.

## Install from the Tedix marketplace

If the Tedix CLI is already installed, run `tedix setup agents --codex`. It
detects Codex, previews the host commands, installs the plugin, and verifies
the installed entry. Continue with the separate MCP login and hook trust steps
below. `tedix setup agents --dry-run` previews without installing.

Use `tedix setup agents --status` to inspect the installed state. For updates,
preview `tedix setup agents --codex --update --dry-run` and then run without
`--dry-run`. A local development marketplace stays local; refresh its checkout
before running the update. Review changed hooks again in `/hooks`.

With Git access to the Tedix repository, add its marketplace and install the
plugin:

```sh
codex plugin marketplace add tedix-hq/tedix
codex plugin add tedix@tedix-repo
```

During plugin development, `codex plugin marketplace add .` from a local
Tedix checkout is also supported.

In the ChatGPT desktop app, open the Plugins Directory, select the `Tedix`
repo marketplace, install or enable `tedix`, then start a new **Work** chat.
If the marketplace does not appear, restart the desktop app and check
`codex plugin marketplace list`. Codex loads an installed copy from its plugin
cache; reinstall after changing the package locally. A repository marketplace
is a team distribution path, not publication to the universal plugin directory.

The OpenAI compatibility manifest is
[`../.codex-plugin/plugin.json`](../.codex-plugin/plugin.json). It points to
the shared [`skills/`](../skills/) directory, the bundled
[`../.mcp.json`](../.mcp.json) connection, and
[`../hooks/hooks.json`](../hooks/hooks.json). The connection targets
`https://connect.mcp.tedix.dev/mcp` and offers the same optional permissions as
ordinary `tedix login`: Tedix feature reads, changes and administration, plus
connected app reads, changes and destructive actions. Browser consent starts
with reads selected. Additional access requires your explicit selection.
The legacy connection file supplies the local Codex/Claude permission catalog.
The portable cloud package uses its remote HTTPS MCP connection and the host's
OAuth flow. Compare actual requested scopes in the consent screen; packaging
alone does not prove matching grants.
Provider grants, organization membership and Work admission remain enforced.

## Authorize the connection

For Codex CLI, inspect the connection and start its OAuth flow:

```sh
codex features list
codex features enable mcp_2026_07_28 # when disabled; restart Codex
codex mcp list
codex mcp login tedix
```

Codex v0.159.0 left this experimental host feature off by default; without it,
Tedix Connect rejected the legacy handshake before OAuth. `tedix setup agents
--status` reports the prerequisite separately from the login state. The feature
is a Codex-wide setting, so review its status before changing it.

The account owner completes browser sign-in, selects the intended Tedix
organization, and reviews the consent screen. In ChatGPT Work, connect the
plugin's Tedix MCP server through the host's authentication prompt. Check the
requested organization and scopes there too. Do not paste tokens into chat or
the plugin files. An installed plugin or a visible MCP server row does not
prove an authorized tool call.

Updating an installed plugin does not replace an existing OAuth grant. Reconnect
to review the common permission choices. Reviewed connected app reads need
`connections.read`; ordinary writes and unreviewed reads need
`connections.execute`; destructive actions additionally need `connections.admin`.
Discovery alone does not prove access.

The local `tedix` CLI has a separate login. When the task uses local files or
the CLI, run `tedix auth status` first, then `tedix -w <workspace> auth status`
for the intended workspace. Use `tedix login <organization-slug>` if that CLI
profile needs owner sign-in. The MCP grant and CLI login do not grant a coding
agent Work execution authority by themselves.

## Check first use

In a new Codex or ChatGPT Work chat with the plugin enabled, ask: “Use
`tedix-connect` to check my Tedix organization and read Work Item
`<existing-id>`. Report the credential kind, relevant scopes, exact read tool,
and result; do not change the item.” This checks skill activation and one
bounded authorized call. A successful tool listing alone is insufficient.
Use an existing Work Item that the signed-in owner is allowed to read.

After the connection check, ask “Find the Tedix Work relevant to this task” or
“Was this Tedix change shipped?” to exercise `tedix-session-guide`. An exact
Work Item ID takes precedence; without one, the guide uses a bounded search
or actor inbox and shows up to three candidates. If several fit, choose one
before execution. The guide separates implementation, commit, release, live
state, and Work completion; it does not write a status merely because the
question was asked. An unrelated coding request should not activate it.

For ordinary connected workflows, the skill uses native MCP tools even when
a shell is available. When a user or repository requires the CLI, it first
checks `tedix auth status` and uses the task-scoped profile. The other packaged skills
are `tedix-session-guide`, `tedix-delegate`, `tedix-guardian-session`, `tedix-resume-work`, and
`tedix-workspace-output`; invoke them only for their described tasks. A read
check must not start an Attempt or write data.

## Optional local preflight

For ordinary sessions in a repository, opt in once with an installed CLI:

```sh
tedix setup agents context bind --workspace <profile> --project <project-uuid>
tedix setup agents context show --json
```

The local binding pins the Git repository, origin, single-organization CLI
profile and engineering project. It lives in `~/.tedix/agent-contexts.json`
(or `TEDIX_CONFIG_DIR`), outside repository-controlled files. This enables
read-only context in that repository's Git worktrees without handoff environment
variables. Existing governed worktree markers supply the Work ID. In an ordinary
checkout, select a task explicitly with `tedix setup agents context select <id>`;
`context clear` removes that branch-scoped choice. `context unbind` revokes the
repository opt-in. Unconfigured repositories perform no Tedix network read.

A changed branch, origin or saved profile produces a local context warning.
The selected Work must match the bound project before its details are briefed.
Explicit handoff targets take precedence over local recovery, and
`TEDIX_PLUGIN_PREFLIGHT=0` disables even a configured brief. Local pointers
never restore an executor credential or lease; current Work state is read on
each delivered lifecycle event. An expired lease requires fresh admission.

The bundled `SessionStart` hook is silent unless a repository binding or
`TEDIX_PLUGIN_PREFLIGHT=1` opts in. Review and trust the
exact hook in Codex's `/hooks` browser before enabling it. Set
`TEDIX_WORKSPACE` to choose a CLI profile and, optionally,
`TEDIX_WORK_ITEM_ID` for one read-only Work Item summary. The hook reads
through the installed `tedix` CLI at startup, resume, clear, and compaction;
with a Work Item id it also reports the newest bounded Attempt state and lease
expiry. It does not log turns or change Work state. A web plugin installation
cannot deploy the local script.

When launching an interactive Codex CLI session with this preflight enabled,
use `codex --no-daemon`. On Codex CLI v0.159.3, a normal TUI launch reported no
briefing while `--no-daemon` delivered the Work Item at startup and after
`/clear`. `tedix work handoff <id> --host codex --launch` uses this launch mode.
The hook remains advisory: verify its result in the new session before acting.

The brief reports its lifecycle source and UTC observation time. Accepted
outcomes up to 800 characters are delivered in full; longer or missing outcomes
are explicitly incomplete and require a full Work context read before execution.
A running Attempt includes its ID and recorded executor, without transferring
its authority. Fresh Codex v0.159.3 checks on 2026-10-02 observed startup,
`/clear`, and manual compaction delivery; each host version still needs its own
delivery check.

For a daily guardian check, invoke `tedix-guardian-session` in a local Codex
chat at the start, at a material checkpoint, or before closing. It reads the
selected CLI profile and any named Work Item, compares current evidence with
the session outcome, and reports the next action. The startup hook supplies optional lifecycle context. For selected shared
context, the separate prompt hook described below reads current facts before
submitted user prompts; neither hook records transcripts or writes updates.
Recording is a third, separate hook that stays off until you opt in.

### Receive shared decisions before a user prompt

After binding a repository, select the existing Tedix document for this chat:

```sh
tedix setup agents context connect-output --os-workspace <workspace-UUID> --output <output-UUID>
tedix setup agents context show --json
```

The CLI reads the current Codex chat UUID from its host environment. To select
from another terminal, add `--session <chat-UUID>` to `select` or
`connect-output`, then use the same flag on `show`. Two chats sharing a checkout
keep separate choices. After the checkout has chat choices, missing identity is
invalid and an unselected chat receives no checkout Work/Output choice. Existing
legacy checkout choices remain readable until the first chat selection. A
selection grants no Attempt or execution authority.

Review and trust the plugin's `UserPromptSubmit` hook. Before a submitted
user prompt it retrieves that document's current revision and, when Work is
selected, the latest two comments with author, receipt and time. It checks the
profile and gateway, Workspace/Output ownership and current revision linkage;
Work must match the bound project. An unavailable source is reported explicitly
without repeating an older briefing as current. `context disconnect-output`
removes the document selection; the selection is scoped to this checkout,
branch and chat and leaves Work selection and sibling chats/worktrees unchanged.

The hook reads bounded host metadata (including `session_id`), discards prompt text,
and never uploads or saves it. It does not write updates, restore execution
authority or deliver a full transcript. Document text is bounded to 3,200
characters; each comment to 400; the whole briefing to 6,000 UTF-8 bytes.
Truncation is explicit. It checks every submitted user prompt rather than
caching a successful read that may never have reached the model.

### Record decisions with explicit opt-in

Decision capture lets Tedix learn how you steer agents. When an agent finishes a
turn, the `Stop` hook opens an Interaction addressed to you in the bound
project's inbox (or on the selected Work Item) with the turn's final message.
When you reply, the `UserPromptSubmit` capture handler answers that Interaction
with your reply and a coarse reply class. The pair is one durable decision
record; open Interactions are the sessions waiting on you.

```sh
tedix setup agents context enable-decision-capture
tedix setup agents context disable-decision-capture
```

The opt-in applies to every bound repository of the current profile and
organization, in Codex and Claude Code alike. Both handlers run in the
background, never block or steer the session, and stay silent on any failure.
Text is redacted for common secret shapes and bounded to 6,000 characters before
it leaves the machine, and is sent only to the bound organization as the signed-in
user. Host re-entries such as task notifications are not treated as replies. A
turn that ends with background work pending is not marked as waiting, and an
unanswered turn is closed as superseded when the next one ends. Unanswered Interactions
expire after seven days.

Automatic goal continuations, tool returns and background work are not proven
`UserPromptSubmit` events. Use explicit checkpoint reads for those. To prove
actual delivery, use one controlled host session: ask for the supplied revision
without tool reads, revise the document through an authorized Tedix action, then
submit another prompt and verify the model receives the new revision without
repeating its contents. CLI readback and hook trust alone are not this proof.
Implementation: `hooks/user_prompt_submit.py`.

If a skill is missing, check that the plugin is enabled and start a new chat.
If `codex mcp list` says `Not logged in`, complete the owner OAuth flow before
testing a read. If CLI access fails while the host MCP connection works, check
`tedix auth status`: the credentials are separate.

OpenAI references: [package a plugin](https://developers.openai.com/plugins/build/plugins),
[connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt),
and [hook trust and lifecycle](https://learn.chatgpt.com/docs/hooks).

## Keep agreed work moving

When the user explicitly requests a Goal for a multi-step task, use the host's
native Codex Goal when available. Continue executable steps until the accepted result is proved
or a concrete dependency prevents progress. Do not replace Goals with model
heartbeats or messages to another chat. A Goal does not override permissions,
leases, user decisions or a completed task.

When you genuinely need an answer, ask one clear question with a recommendation
and the consequence of each useful option. Save it on the existing Tedix request
when that surface is available. A safe, obvious and reversible choice within the
agreed task can be made autonomously; do not ask merely to create bookkeeping.

A supported Cloud Work host can subscribe to a Tedix reply through
[MCP Events](https://developers.openai.com/plugins/build/mcp-events) when the
server advertises that capability and the exact event. Subscribe only to the
existing request in the selected organization. A webhook acknowledgment proves
delivery to the host, not that the chat resumed or finished its task; verify those
separately. Unsubscribe when the wait ends. An installed plugin, hook trust or a
readable inbox does not prove this event route is active.

Local startup and prompt hooks restore bounded context; they do not wake an
idle desktop chat. If the host or gateway lacks event support, say so once and
leave the exact request link. Do not simulate automatic continuation with
periodic model calls, repeated probes or cross-chat “continue” prompts.
