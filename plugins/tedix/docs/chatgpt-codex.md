# Use Tedix in ChatGPT Work and Codex

The portable package has one canonical `tedix` identity and a remote HTTPS MCP
endpoint; its current version is the `version` field in
[`../plugin.json`](../plugin.json).
The default cloud artifact omits local hooks and registered `.app.json`
references. The local artifact adds opt-in hooks under the same plugin identity;
each hook runs `tedix hooks <name>`, needs only the installed Tedix CLI, and
exits silently when that CLI is missing.
OpenAI allows a plugin to combine MCP, skills and trusted local hooks; a web
installation cannot supply the local CLI.

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
context recovery; they run the installed Tedix CLI and cannot directly call
model-native plugin tools or borrow host OAuth credentials. Without the CLI
every hook exits silently and no Tedix context is added. Keep the
CLI when local automation or repo policy requires it. Ordinary Chat does not execute local hooks.

## Install from the Tedix marketplace

If the Tedix CLI is already installed, run `tedix setup agents --codex`. It
detects Codex, previews the host commands, installs the plugin, and verifies
the installed entry. Continue with the separate MCP login and hook trust steps
below. `tedix setup agents --dry-run` previews without installing.

Use `tedix setup agents --status` to inspect the installed state. For updates,
preview `tedix setup agents --codex --update --dry-run` and then run without
`--dry-run`. A local development marketplace stays local; refresh its checkout
before running the update. Review changed hooks again in `/hooks`.

Without the CLI, add the public Tedix repository as a marketplace and install
the plugin:

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

### ChatGPT on the web

ChatGPT on the web is not supported yet. The Tedix plugin is not published in
the ChatGPT plugin directory, and adding the Tedix Connect URL as a
developer-mode custom connector is not a tested or documented path. Use the
ChatGPT desktop app (ChatGPT Work) or Codex as described above.

The OpenAI compatibility manifest is
[`../.codex-plugin/plugin.json`](../.codex-plugin/plugin.json). It points to
the shared [`skills/`](../skills/) directory and the bundled
[`../.mcp.json`](../.mcp.json) connection. It does not reference hooks; the
plugin's [`../hooks/hooks.json`](../hooks/hooks.json) sits at the default
plugin hook location, and Codex runs those hooks only after you trust them in
`/hooks`. `.mcp.json` declares only the server type and URL. The connection targets
`https://connect.mcp.tedix.dev/mcp` and offers the same optional permissions as
ordinary `tedix login`: Tedix feature reads, changes and administration, plus
connected app reads, changes and destructive actions. Browser consent starts
with reads selected. Additional access requires your explicit selection.
Neither connection file lists scopes; the server offers them during consent.
The portable cloud package uses its remote HTTPS MCP connection and the host's
OAuth flow. Compare actual requested scopes in the consent screen; packaging
alone does not prove matching grants.
Provider grants, organization membership and Work admission remain enforced.

## Authorize the connection

For Codex CLI:

1. Enable the MCP 2026-07-28 protocol feature, which Tedix Connect requires.
   Check it with `codex features list`; if `mcp_2026_07_28` is disabled, run
   `codex features enable mcp_2026_07_28` and restart Codex. Without it, Tedix
   Connect rejects Codex's older handshake before OAuth starts. It is a
   Codex-wide setting, so review its status before changing it;
   `tedix setup agents --status` reports it separately from the login state.
2. Run `codex mcp list` and confirm the plugin's `tedix` server is listed.
3. Run `codex mcp login tedix` and complete the browser OAuth flow.

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

The plugin's hooks run at session start, prompt submit, tool use, permission
requests, stop and session end. Each runs `tedix hooks <name>`, exits silently
when the CLI is missing, and does nothing until you opt in to its feature. The
[CLI guide](https://docs.tedix.dev/cli#set-up-codex-and-claude-code) lists every
hook, when it runs, what it sends to Tedix and how to turn it off. Codex runs
them only after you trust them in `/hooks`; to remove them, disable or
uninstall the Tedix plugin.

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
cannot install the local CLI the hook runs.

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

An optional organization-wide working-preferences document reaches every chat
of the same profile and organization, under the same ownership and revision
checks; `disconnect-preferences` removes it.

```sh
tedix setup agents context connect-preferences --os-workspace <workspace-UUID> --output <output-UUID>
```

Every bound chat also receives the organization's approved team lessons
(`agent.get_agent_session_lessons`): learning-feed memory facts that a person
confirmed, filtered to this repository and host and ranked by the
branch name's words, about 2,800 bytes at most, each with a short fact id.
Probation and superseded lessons never appear. Only the host kind, repository
(without credentials) and branch words are sent; no selection is needed.

The hook reads bounded host metadata (including `session_id`), discards prompt text,
and never uploads or saves it. It does not write updates, restore execution
authority or deliver a full transcript. Document text is bounded to 3,200
characters; each comment to 400; the whole briefing to 9,600 UTF-8 bytes.
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
unanswered turn is left open when the next one ends and expires after 24 hours;
the agents board shows which sessions are waiting now.

Before the question is created, the redacted turn is triaged by the bound
organization (`agent.triage_agent_turn`, at most 4 seconds) and the result is
stored on the question as `metadata.triage`; the reply is likewise labelled
(`agent.label_agent_reply`, at most 3 seconds) as `metadata.replyClassClef`
beside the coarse class. Both fall back silently when the tool is missing or
slow. With the turn-status reporter also enabled, decision capture owns the
`Stop` status for its chats: an urgent turn ("now") is marked needs you and
notifies once with a short reason (blocker, login or consent, risky action);
any other turn is marked done without a notification. `tedix hooks status`
skips `Stop` for those chats. Both hooks start together, so neither waits for
the other: each reads the same local opt-in for the chat. Without a triage
result, the reporter's own question classifier decides, as before.

#### Drafted replies and answers from Tedix OS

For a question triaged "later", the `Stop` handler also asks the organization
for a tedi-drafted reply (`agent.request_agent_reply_draft`, at most 3 seconds,
silent when missing). The organization marks each draft for review or for
automatic delivery (below). A review draft never reaches the chat directly.
Review it in the Tedix OS inbox, where it appears with its rationale, and
accept it or edit it there; that answer records which draft it started from as
`{draftId, draftOutcome, editRatio}`: `accepted` (unchanged), `edited`
(normalized edit distance at most 0.3) or `replaced`. A reply typed in the chat
answers the agent as typed and cites no review draft.

When you answer the question in Tedix OS, Claude Code is woken in the background
by `tedix hooks await-reply` (an `asyncRewake` `Stop` hook that polls the
question with 5 to 60 second backoff for at most four hours) and receives your
answer or an automatic reply (below). Codex has no background wake, so the local Codex
artifact omits that hook; Codex receives the OS answer with your next prompt,
through the prompt hook, which looks the question up by ID only. A question already answered in
Tedix OS is never answered again by the chat reply.

#### Automatic replies and their guardrails

The organization, not the local hook, decides whether a draft is sent
automatically (`latestDraft.delivery: "auto"`). It does so only when all of
these hold:

- the step is reversible;
- the turn was not triaged urgent ("now"); urgent turns are never answered
  automatically;
- the session has had fewer than 3 automatic replies in a row. The hooks keep
  the same limit of 3 locally, and a reply you type resets it.

An automatic reply reaches the agent as `Tedix <tedi> replied for the user
(auto, reversible step; the user can override at any time): "<reply>"`. The
reply is a quoted JSON string, framed as untrusted drafted content that stands
in for your answer, not as instructions. The question itself stays open: no
hook answers in your name. In Tedix OS the reply shows "Sent automatically by
<tedi>" with no Accept button; write an override there at any time and it
answers the question normally, recorded as `draftOutcome: "replaced"`. If you
instead reply in the chat to a question that received an automatic reply, that
answer records `{draftId, draftOutcome: "auto-sent"}`. The local record of an
automatic delivery holds only the question and draft IDs. A server without
automatic delivery, or a draft with no `delivery`, is treated as a review
draft. The turn-status reporter records an automatically continued session as
working, so no needs-you notification is sent; the turn that follows is
classified normally.

Claude Code receives an automatic reply through `tedix hooks await-reply`.
Codex receives it through `tedix hooks await-draft`, a synchronous Codex-only
`Stop` hook. Codex documents that a `Stop` hook returning
`{"decision": "block", "reason": "..."}` "tells Codex to continue and
automatically creates a new continuation prompt that acts as a new user
prompt, using your reason as that prompt text"
([Codex hooks](https://learn.chatgpt.com/docs/hooks)). `await-draft` waits up
to 5 minutes, polling every 5 seconds, for the question this turn opens. It
prints that continuation only for an automatic draft. It returns at once with
no output when no draft was queued, the draft is for review, or the question
was answered. The local Codex artifact registers it; Claude Code artifacts omit
it. If your Codex hooks live in `~/.codex/hooks.json` instead of the plugin,
add this beside the `tedix hooks capture-stop` entry under `"Stop"`:

```json
{
	"hooks": [
		{
			"type": "command",
			"command": "tedix hooks await-draft",
			"timeout": 320
		}
	]
}
```

Then restart Codex and trust the changed hook in `/hooks`. Without it, Codex
gets no automatic replies; the question stays open in Tedix OS.

Automatic goal continuations, tool returns and background work are not proven
`UserPromptSubmit` events. Use explicit checkpoint reads for those. To prove
actual delivery, use one controlled host session: ask for the supplied revision
without tool reads, revise the document through an authorized Tedix action, then
submit another prompt and verify the model receives the new revision without
repeating its contents. CLI readback and hook trust alone are not this proof.
Implementation: `tedix hooks prompt-context` in the Tedix CLI.

### Report turn status

The local artifact also carries the opt-in turn-status reporter described in
the [Claude Code guide](./claude-code.md#opt-in-turn-status). Enable it with
`~/.tedix/agent-status.json` containing `{"enabled": true, "profile":
"connect", "organization": "<selected org>"}`, restart Codex, and trust the changed hooks in `/hooks`. Codex
delivers `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop` and
`SessionEnd`; it has no `Notification` or `StopFailure` event, so Codex
failures surface only when the next turn starts. The status `Stop` hook prints
nothing, which Codex accepts; only `await-draft` prints, and only its
continuation JSON.

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
