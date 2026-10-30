---
sidebar:
  order: 90
title: "Agent guide"
topic: "Getting started"
resource_type: guide
description: "A machine-readable entry point for agents researching or operating Tedix."
summary: "Public routing, source-priority, discovery, and evidence rules for agents"
read_when:
  - Giving an AI agent context about Tedix
  - Researching Tedix without repository access
  - Operating Tedix through the CLI or an MCP gateway
visibility: public
---

# Agent guide

New session with no context? Follow [Start here as an agent](./agent-start-here.md)
first; it orders the steps and points back here for detail.

Start here when an agent needs to research Tedix or operate a Tedix
organization. Choose the path that matches the task:

| Task                             | Start here                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Answer a public product question | Use the documentation endpoints below. No login is needed.                                                                    |
| Evaluate Tedix on one computer   | Follow the [local path](./getting-started.md#run-tedix-locally). It does not connect to Tedix Cloud or run remote tedis.      |
| Operate Tedix from an assistant  | Connect the host's Tedix plugin or connector; see [Use Tedix in ChatGPT, Codex and Claude](./learning-paths/first-plugin.md). |
| Run a Cloud tedi                 | Sign in to an invited beta organization, then follow [Give an AI assistant a task](./learning-paths/first-worker.md).         |
| Change the source repository     | Read the root and nearest scoped `AGENTS.md` files before editing.                                                            |

For a factory request, use [Build and inspect a factory as an agent](./factory-agent-guide.md).
It maps canonical resources and tool families, then gives one bounded
read-only inspection before setup or execution. To install or operate a
workspace app such as Card review, use
[Build a workspace app](./build-a-workspace-app.md).

## Documentation endpoints

Start with the smallest sufficient source:

| Need                         | Endpoint                                        |
| ---------------------------- | ----------------------------------------------- |
| Page inventory and summaries | `https://docs.tedix.dev/llms.txt`               |
| Complete public corpus       | `https://docs.tedix.dev/llms-full.txt`          |
| Human navigation             | `https://docs.tedix.dev/`                       |
| Page Markdown                | Follow the Markdown URL advertised on each page |
| Public REST API catalog      | `https://api.tedix.dev/openapi.json`            |
| Human API reference          | `https://api.tedix.dev/docs`                    |

Prefer `llms.txt`, select the relevant page, and fetch only that page's
Markdown. Use `llms-full.txt` when the task genuinely requires cross-document
analysis. Do not infer private implementation details from absent public
material.

The OpenAPI document describes only the curated public `/v1/*` REST surface.
It does not enumerate private oRPC procedures or authenticated MCP tools.

## First Cloud connection

An agent reaches a Tedix organization in one of two ways. The first needs no
CLI and is the default for Claude, Claude Code, Codex and the ChatGPT desktop
app. The second is for a local coding harness that needs hooks or repository
policy.

### Through the host's plugin or connector

The Tedix plugin gives the host a remote MCP connection to
`https://connect.mcp.tedix.dev/mcp` and packaged skills including `tedix-session-guide`,
`tedix-connect`, `tedix-delegate`, `tedix-resume-work`,
`tedix-workspace-output`, `tedix-guardian-session` and `tedix-factory`. In Claude chat and
Cowork, the same URL is added as a custom connector, which carries the tools
but not the skills. The human installs it and signs in once through the host's
own OAuth flow: a browser opens, the owner signs in, selects one or more
organizations in the organization picker and reviews the requested access. The
human completes this consent; the agent cannot. The host stores the grant, and
each host and device keeps its own grant, so signing in elsewhere does not
invalidate it; do not ask for a password, browser cookie, or token. The human
steps, per host, are in
[Use Tedix in ChatGPT, Codex and Claude](./learning-paths/first-plugin.md); the
packaged skills and host guides are in the
[plugin README](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/README.md),
and the published marketplace is
[tedix-hq/tedix-plugins](https://github.com/tedix-hq/tedix-plugins).

For Devin CLI, Desktop and cloud, install from the source subdirectory with
`devin plugins install tedix-hq/tedix#plugins/tedix -y`. Inspect it with
`devin plugins info tedix`, then use `devin mcp login tedix` locally or connect
through **Customize → MCPs** for cloud sessions. The Devin CIMD client ID is
pending; OAuth readiness remains unverified. The shared skills load across
surfaces; plugin hooks run only in CLI/Desktop and silently skip a missing
Tedix CLI. `tedix setup agents --devin --yes` remains the local fallback;
matching managed hooks take precedence to avoid duplicate capture. See the
[Devin plugin guide](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/devin.md).

On first use, run the `tedix-connect` skill, or follow its steps: confirm the
account and organization with `codemode.__runtime()` through the `code` tool,
and make one bounded read-only call through Code Mode. Account identity, organization
selection and granted capabilities are separate facts; the grant authenticates
the **owner**, not the agent.

A host that reaches Tedix only through the MCP plugin calls
`start_external_agent_session_for_host` once, then passes the returned session
id as `agentSessionId` on each `code` call that should run as that session. The
session is bound to the signed-in owner and counts as the same party as the
owner: it can start Work Attempts but never approves, corroborates or reviews
its owner's work. Start with a read-only tool discovery or a bounded task, then
inspect its result. The owner remains responsible for identity and any
human-required consent; an agent session does not become the organization
owner.

### Through the CLI

For a local coding harness that needs the opt-in session hooks or a
repository's Tedix policy, install the [CLI](./cli.md) and run `tedix login`.
The command opens the Tedix consent screen in a browser. Pause while the owner
signs in, accepts any invitation or consent request, and creates or selects an
organization in the organization picker (`tedix login ORG_SLUG` preselects
one). For each selected organization, the CLI saves a local connection profile
and receives its own tenant-bound grant through OAuth; a login on another
machine or host keeps a separate grant and does not disturb this one. Do not
ask for a password, browser cookie, or token. An approved new owner can create their own
organization without joining the inviter's organization. If beta approval is
pending, the owner may need to rerun `tedix login` after admission. If an
invited organization is missing, ask the inviter to confirm access. The CLI
login and the host's plugin sign-in are separate credentials; one does not sign
in the other.

Run `tedix auth status` to check the selected workspace and granted scopes.
That login authenticates the **owner**, not the agent. For continuing work under
an attributable agent identity, use `tedix agent start --help`, then start an
external-agent session from the owner's authorized workspace. Agents use the
CLI or plugin sign-in plus a machine identity of their own: the first
`tedix agent start` on a machine registers the agent and gives it an M2M client
limited to the MCP tools it may use. No API key is created for an agent. The
agent's own identity only opens its session; Work it starts, keeps alive,
settles and completes runs under that session and under nothing wider. API keys
remain for operations and CI jobs only. Profiles enrolled by CLI 0.17 or earlier
still carry an API key; the 0.18 release keeps accepting them, and the release
after it stops. Run `tedix agent start` once more on such a machine to move it
to its own identity, then revoke the "External agent …" key in Settings.
The CLI reads the
harness session id (`CLAUDE_CODE_SESSION_ID` or the Codex chat id); set
`--agent-harness` to select the matching native id when a launcher supplies
another harness's environment too. An explicit `TEDIX_AGENT_SESSION` override
takes precedence; its prefix must match the requested harness. A missing
matching id or conflicting prefix stops bootstrap before credential exchange.
A lane launched from another harness, such as Codex started from a Claude Code
shell, inherits the launcher's session id beside its own. The CLI then picks
the id of the nearest Codex or Claude Code process above it, so the lane
registers and starts Work as its own session rather than its launcher. Without
that proof, bootstrap asks you to choose instead of guessing, and Work writes
refuse an ambiguous inherited session. Choosing an id grants nothing: the
session must still be registered and exchanged for its own credential.
Set `TEDIX_AGENT_SESSION` to the returned full session key for subsequent calls
when detection cannot decide, or when no native id exists.
Pass `--model-version` when the harness reports a dated model snapshot. Codex
and similar harnesses report only a model name, so the session is recorded as
unpinned (`unpinned:<model>@<harness>/<version>`) instead of failing.
The first bootstrap names the profile's principal for the machine and user
(`local-<user>-<machine>`) unless you pass `--agent-key`; every later Claude
Code or Codex session on that profile gets its own Agent-Session under the same
principal. A profile whose principal is named for one harness (for example
`codex-…`) serves only that harness; another harness bootstraps its own
`<harness>-local-<user>-<machine>` principal on the same workspace. A session an
older CLI started under such a principal for another harness acts under the
stable successor key (the same harness and a UUID derived from the old key)
with its own principal instead. On the first bootstrap, pass `--agent-scopes` with only the MCP
capabilities the task needs; omitting it requests the default broad capability
set. Set `TEDIX_EXTERNAL_AGENT` to the principal key for subsequent CLI calls
and check `tedix agent status` before acting. `tedix work start` requires this
bootstrap: run without it, the refusal names the missing piece (no Agent-Session,
no identity on the workspace, a session not started, or a started session the
call did not use) and the command that fixes it.

For a first tedi run, do not bootstrap an external-agent identity. Use the
bounded [first-task tutorial](./learning-paths/first-worker.md), which targets
one named tedi and shows how to verify that the tedi actually ran.

## Follow Work changes with MCP events

An app administrator enables `metadata.mcpConfig.interactionEvents` on the
MCP app serving the connection, and `eventWebhooks` for Work webhook delivery.
For an aggregate gateway, configure that gateway as well as the source app.
With the subscription binding configured, MCP `2026-07-28` discovery advertises
`capabilities.events` and
`capabilities.extensions["io.modelcontextprotocol/events"]`. Use
`server/discover`: this protocol revision removes `initialize`.

Check the connected app before setting up a client:

```sh
tedix -w connect --organization <slug> mcp call server/discover
tedix -w connect --organization <slug> mcp call events/list
```

Choose how updates reach the assistant:

- **ChatGPT:** connect the Tedix plugin and rescan its events. In a Work chat
  on web, or desktop with Work and Cloud selected, ask: “Monitor this Work
  item's state changes and re-read it when it changes.” ChatGPT supplies the
  webhook URL and signing secret to `events/subscribe`. ChatGPT supports
  webhook delivery; see the [official MCP Events guide](https://developers.openai.com/plugins/build/mcp-events).
- **Claude Code:** register the local `tedix channel claude` stdio server and
  enable its development channel in an interactive session. It polls the
  remote events and forwards notices to Claude Code. Follow the
  [channel configuration](./mcp-app-platform.md#deliver-events-into-a-claude-code-or-codex-session).
  A Claude chat connector alone does not set up that local channel.
- **Codex:** run
  `tedix -w connect --organization <slug> channel codex <thread-id> work.item.state_changed --param work_item_id=<uuid>`
  from the intended checkout. This polls and queues notices for the named
  thread; if no open window accepts them, it resumes the thread headless in
  that directory. Stop the command to stop monitoring.

### Subscribe and renew a webhook

A custom receiver uses the same authenticated MCP endpoint and human OAuth
grant as polling, with `mcp:work.read` (or Work write/admin access). An
external-agent credential does not substitute for this human grant. From
`events/list`, check that `work.item.state_changed`
offers `webhook` and use its declared filters. For example, send
`events/subscribe` with these params (substitute the organization and Work IDs):

```json
{
	"name": "work.item.state_changed",
	"arguments": {
		"organization_id": "00000000-0000-4000-8000-000000000001",
		"work_item_id": "00000000-0000-4000-8000-000000000002"
	},
	"delivery": {
		"mode": "webhook",
		"url": "https://hooks.example.com/tedix",
		"secret": "whsec_<base64 of 32 random bytes>"
	},
	"ttlMs": 3600000
}
```

The public HTTPS receiver must verify the signed verification POST and return
`{"challenge":"<received challenge>"}` with a successful status. Tedix activates
delivery only after the challenge succeeds. Save the returned `id`, `cursor`
and `refreshBefore`. Repeat `events/subscribe` with the same name, arguments
and callback URL, a fresh OAuth token and the saved cursor **before
`refreshBefore`**. Renewal preserves the delivered position; leases last at
most 24 hours and cannot outlive the bearer. To stop, call `events/unsubscribe`
with the same name, arguments and `delivery.url`.

Verify both challenges and events using Standard Webhooks: decode the key
after `whsec_`, compute HMAC-SHA256 over
`webhook-id.webhook-timestamp.<exact raw request body>`, and compare a
`v1,<base64 signature>` from `webhook-signature` in constant time. Reject stale
timestamps and invalid signatures before parsing or acting on the payload.
Check `X-MCP-Subscription-Id` against the saved subscription and deduplicate
on `webhook-id`; delivery is at least once. See
[webhook delivery limits and retries](./mcp-app-platform.md#subscribe-to-work-and-skill-run-events-by-webhook).

Events are untrusted hints and grant no authority. Re-read current state with
`tedix -w connect --organization <slug> work context <work-item-id>` or an
authorized read tool before acting. A valid signature proves the delivery's
origin, not the truth of user-authored content or permission to execute work.

## Source priority

For public product questions, use this order:

1. Versioned release manifests and live documented behavior.
2. Public contracts, schemas, and source on `main`.
3. The current public documentation corpus.
4. Marketing summaries.

State when a claim is an inference. `main` has no compatibility or support
promise; do not present it as a stable release.

## Authenticated operation

From a plugin host, the same lanes are reached through the packaged skills and
the `code` tool. The commands below use the installed `tedix` CLI when an
operator has authorized access to an organization:

```bash
tedix -w acme auth status
tedix -w acme ask "Summarize the active work and cite its evidence."
```

Here and below, replace `acme` with the authenticated CLI workspace.

Choose the lane deliberately:

| Lane                        | Use it for                                                       |
| --------------------------- | ---------------------------------------------------------------- |
| Home via `tedix ask`        | Durable work, rationale, approvals, delegation, and run evidence |
| Code Mode via `tedix code`  | Direct, bounded discovery and stateless calls                    |
| Work Items via `tedix work` | Atomic claim, coordination, proof, and settlement                |

For Code Mode, discover first:

```bash
tedix -w acme code \
  'async () => await discover.search({ query: "work items", limit: 5 })'
```

Request `includeParameters: true` only for the few callables you intend to use.
Never invent a callable, namespace, schema, or permission.

### Request budgets

Each verified agent session has its own request budget of 100 calls per
minute, so parallel lanes no longer slow each other down. All sessions under
one agent principal share a ceiling of 600 calls per minute. A call refused by
a session's own budget does not count against that ceiling. The owner's own
logins, tedis and unverified sessions keep the earlier per-principal budget.

When a budget is spent, the gateway answers HTTP 429 with a wait time. The CLI
waits and retries up to twice within the command's deadline, including writes
that were refused before they ran. Other clients should honour the advertised
wait rather than retrying at once.

### Delegate from a lead session

When one lead session talks to the user and hands work to subagents or other
sessions, register each hand-off as a Work Item in one call:

```bash
tedix -w acme work delegate "Rewrite the CLI reference" \
  --done-when "docs:public:check passes on main" --via subagent --to docs-pass
```

The command reuses an open Work Item with the same title, or creates and
accepts one, then comments the brief. It is tagged with the lead session's
id, so with the Tedix plugin hooks on, each prompt in that session lists its
open delegations, at most eight. Other sessions do not see them. Settle one
with its outcome:

```bash
tedix -w acme work delegate --done <id> --note "Merged; docs check green"
```

For a registered local lane, always hand a result that needs the person back
through settlement, including a waiting-on-user question, a draft to send, or a
decision:

```bash
tedix lane done "Draft prepared: /docs/example-reply; Work /work/items/<id>" \
  --needs-user "Confirm the address and send the reply" --request-id <ledger-id>
```

Omit `--request-id` when no original ledger row is known. Tedix resolves the
requesting user from recorded lane ownership; it never guesses a recipient.
Settlement atomically creates one equivalent Needs-you ask and marks the
request ledger "waiting on you". Work stays open. The ask links the result and
has **Done** and **Snooze 1 day** actions. Include the document link in the note;
writing a report file alone does not hand off the result.

Unanswered asks older than 24 hours appear in the morning digest (08:00–12:00
UTC), at most once per day per ask, and remain once in Attention's **Waiting on
you** column. Snooze hides the ask for 24 hours. After seven days the original
owner rechecks relevance through the existing ask-review flow. A bound
`tedix channel claude` or `tedix channel codex <thread-id>` receives the private
Interaction event as **Needs you: …**, with a command to read the exact next
click. A channel delivery is not evidence that the human acted.

## Operate from workspace chat

For owner-enrolled external findings, see [Personal-agent findings](./personal-agent-inbound.md)
for the browser form, contract procedures, receipts and revocation.

Every app or factory build must update its agent guide with the actions,
permissions and checks needed to operate it from workspace chat. Include a
plain example request and the tools behind it; prove the chat path as well
as the screen. Start with [Build a workspace app](./build-a-workspace-app.md)
or the [factory guide](./factory-agent-guide.md).

For Card review, ask "Show my next card", "Mark it useful: saves time", or
"Carry out this card's action and show the result". The app guide explains
the output writes and skill run; marking a card done alone proves no outside
action. Gmail **Read** and **Read + organise** are separate owner grants;
neither allows sending, trashing, spam or deletion.

For a browser task, ask "Open the console as yourself, read this Workspace
and report what you can verify". An administrator must first grant the
tedi [read-only console access](./workers-and-governance.md#tedi-console-access).
Ask for a takeover when a step needs human presence; the human completes
sign-in or MFA in the live view.

### Session request ledger

With decision capture enabled, local Codex and Claude Code hooks upload
redacted messages you type and agent turn endings, including a digest of
tool failures, agents started and their reports. Events wait in a local
outbox until uploaded; analysis runs in the background on Tedix. It records
requests, questions, decisions, promises and unfinished follow-ups, and tracks
in progress, waiting on you, at risk and done. Done needs evidence from the
turn or its activity; it is not independent verification.

The ledger is private to its signed-in owner in the organization. It uses
the decision-capture opt-in, not ordinary read-only preflight; see the
[CLI hook controls](./cli.md#set-up-codex-and-claude-code).
Open **Work → Activity → Apps → Office → Your requests** to inspect it. The prompt hook's
**Open requests** block brings unfinished rows back before each prompt.

In workspace chat, ask "Show my open requests from my coding sessions" or
"What did the agent promise and leave unfinished?" An agent must discover
the private ledger read tool (`list_agent_session_requests`), read as you
and cite the source session. A tedi's own identity does not inherit your
private ledger access. Updating a row to done needs an evidence note, link
or commit; it does not settle a related Work Item.

### Corrections and preferences

On hosts that dispatch the opt-in capture hooks, a short correction such as
"I prefer short progress updates" is classified locally and sent through
`record_session_feedback` as a bounded personal lesson candidate with a quote,
source session, time and harness. Text and semantic duplicates are skipped.
Owner feedback becomes active immediately; project notes need review. Approved
lessons are refreshed on every prompt across harnesses. Neither installation
nor a saved lesson proves that a host dispatched the hook or read the result.

Today and the context rail show **Learned today**, with links to active rules
from your feedback. Open Memory to inspect their supporting quotes. Historical
notes can be previewed with `tedix learn import-memory --directory <path>`;
`--date YYYY-MM-DD --type feedback --apply` imports only the selected files.
Raw notes are processed locally; only extracted rules, quotes and file evidence
are uploaded. Reference and stale notes are skipped.

### Tedi follow-through

- **Action receipts:** after a write, read the changed record. The final
  reply includes durable action receipts with what was checked; report
  missing or failed verification plainly. In chat: "Do this and show the
  receipt and current result."
- **Commitment changes:** meaningful changes to owned Work, approvals,
  Interactions and factories can wake the tedi through the existing scan.
  Changes are batched and deduplicated; a wake grants no new authority.
  In chat: "Check what changed on this Work and take the next allowed step."
- **Quiet updates:** routine machine status updates to people use
  coordination Interactions and batch into digests. Failures, blocked
  approvals and deadlines under 24 hours bypass the batch. In chat: "Prepare
  quietly and put routine progress in the digest; interrupt for a blocker."
- **Needs you:** the original asking tedi or agent session owns the ask.
  By default, after three unanswered days it rechecks the source, closes
  the ask with a note or re-asks once. After an answer it must act within
  authority and record a continuation receipt tied to that exact answer
  and action evidence. Saved, delivered and acted on are separate states.
  In chat: "Check whether my answer was acted on and show the evidence."
- **Live refresh:** on ordinary turns, including "continue", the tedi
  refreshes referenced commitments from the message, memory and session.
  If a live read fails, it withholds task actions based on remembered state.
  In chat: "Refresh this Work's current state before continuing."

For external coding sessions, a directed inbox entry still needs a running
host hook or listener to reach execution. A queued wake is not proof of a
resumed turn.

### Server-owned coding lanes

Tedix owns lane lifecycle, readiness and follow-through. A Lead is a bound
execution session; it does not watch local report files or decide when another
lane is ready. Register inside the executing session with `tedix lane start`,
report liveness with `tedix lane heartbeat`, and report the outcome with
`tedix lane done` or `tedix lane fail`.

The server records a stale event after N without a heartbeat and retires the
Attempt at 2N. N is half the server-issued lease (currently 2.5 minutes); the
two-minute server tick bounds detection latency. Heartbeats can recover a
stale lane before expiry; expired Attempts need fresh admission. Killing the
local harness does not stop server detection. Attention shows a stale lane as
blocked and keeps expired Work available in its existing project's backlog.

Coordinators read the server's `workItems.listAttemptProjection` projection,
including `laneState`, and canonical Work readiness, request ledger rows and
Interactions. They never use a local `night-log.md` as lane state. A reported
success wakes the Work's owning, steward or project lead tedi to verify the exact settlement
against its claimed SHA, document or Work result and post a receipt. Configure
a tedi owner or steward on the Work, or a lead tedi on its project. The local
session reports success; the tedi completes Work after verification. A wake
grants no approval and does not itself prove verification or delivery.

The request tracker's timer can complete verified dispatcher coding Work only
when the organization's active policy pack explicitly configures
`kernelRequestCoordinator.workAttemptDelivery.completion` with `projectIds`
and a `repositoryTargetId` from its `repositoryTargets`. Omission leaves Work
open at `ready_to_complete`; platform defaults grant no completion authority.
This opt-in is an operator approval decision, separate from installing code.
The timer supports low- and medium-risk coding Work whose latest Attempt
settled successfully. It rechecks fresh main delivery, the API build, and the
configured surface's exact SHA receipt from a successful managed Ship before
completing. Policy revocation, a changed request or a newer Attempt fences the
write. Missing delivery or Ship proof stays pending until the verification
window closes, then produces one repair Work. No model or open chat is needed.

To limit verification to a canary cohort, set
`kernelRequestCoordinator.workAttemptDelivery.workItemIds` to those Work IDs.
Omit it for all dispatcher Work; an empty list processes none. This filters
intake before its batch limit and pauses reconciliation of excluded Work.
Leave `completion` absent to keep timer completion authority disabled.

To dispatch a Codex or Claude lane, Tedix opens a Work-linked `handoff`
Interaction for the executing user's canonical id, with
`metadata.laneRequest.harness` set to `codex` or `claude-code`. Bound
`tedix channel codex` and `tedix channel claude` sessions receive its
`lane.requested` event. Pending open requests replay when a channel binds.
The recipient reads the Interaction and server readiness, then obtains its
own Work admission before executing; concurrent recipients cannot share an
Attempt. Event content carries identifiers, never instructions or credentials.

### Local dispatcher

`tedix lane serve --executor <codex|claude-code|devin|any-local>` runs on a
person's machine and picks up Work assigned to that executor. It filters by
executor on the server before paging, so a large backlog for other executors
cannot hide its own Work. Each lane starts as its own agent session, with its
own Attempt and request budget.

If admission fails three times in a row for the same reason on the same Work
revision, the dispatcher stops retrying, posts one comment explaining why and
holds that Work until its revision changes. The hold survives a restart. Edit
the Work or fix the cause to release it.

When a coding lane finishes, the dispatcher records the commits that already
landed on `origin/main` with its settlement. Work accepted with
`metadata.artifactKind` set to `skill_revision`, `metadata.artifactSkillId` set
to the expected skill UUID and `metadata.artifactSkillRevision` set to the
expected revision can instead submit `skill_revision` evidence for the held
Attempt using `skill://runs/<runId>`. The dispatcher checks that the run
completed for that active organization skill and records its pinned skill and
revision. Coding Work with neither proof settles as failed, even when the
harness exited normally. After success the dispatcher requests Work completion
under its original session, retaining any denied or interrupted request for
bounded retry. Owner-only actions remain with the owner. A lane's report and
Work completion do not independently verify the result.

If dispatchable Work waits while no dispatcher has admitted an Attempt for a
while (45 minutes by default), the organization owner gets one attention item.
Only organizations whose active policy pack enables the request tracker
(`kernelRequestCoordinator.enabled`) get this item.
It is not repeated while the condition lasts and is withdrawn once a dispatcher
picks Work up again. An organization setting changes the wait or turns the
alarm off.

### Engineering shift

Tedix itself can drive the coding queue. An organization records a
tedi-owned scheduled automation (the Tedix organization's is the CTO's
`engineering-shift`, every ten minutes) whose `schedule.params` hold the lane
project, the target number of queued items per executor, the red threshold in
minutes, the CI and Ship workflows to read through the GitHub app, and the
Output for the morning summary. Each run keeps accepted coding Work assigned per
executor round-robin, files one scout item per short executor when the
unassigned pool is empty, files one high-priority fix item when the latest
finished CI or Ship run failed and the failing streak is older than the
threshold, and in the 06:30 Berlin slot inserts a dated section into the
summary document: Work completed in the last 24 hours, CI and Ship counts and
red minutes, the queue per executor and what runs next. Counts, cadence and
executors change through `improve_skills` on that skill, never through code.

The machine only executes: one `tedix lane serve --executor <name> --project
<lane project> --coordinated --accept-proposed` per executor under launchd,
with `--max` caps that fit the machine. A tedi's manifest cannot accept Work,
so a fix or scout item the shift files stays proposed until the dispatcher for
its executor accepts it from the item's `## Done when` section
(`--accept-proposed`). A local chat or script is no longer part of the loop;
when it stops, the schedule and the dispatchers keep running.

## Request an agent or connection

When an installation has released the agent-request path, its organization
owner can enable `metadata.agentRequestApprovals: { approver: "org_admin" }`
through `organizations.update`. Omission or `null` keeps it disabled. This
setting records the owner's choice of approver; an agent cannot enable it.

Use the existing Work approval tools. Discover the proposal tool and its
current schema before calling it. Bind the request to an open Work Item and
its exact version, and name an independent organization owner or admin as
the user approver. The requester and approver cannot represent the same person.

| Action           | Proposal kind      | What approval carries out                                                                                              |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `agent.create`   | `tedi`             | Creates a standard tedi using the installation's current defaults and limits.                                          |
| `agent.create`   | `external_agent`   | Registers an external agent against an existing machine identity (an M2M client or a CI key). It issues no credential. |
| `agent.connect`  | `connection`       | Creates a named organization account slot for an installed OAuth provider that supports multiple accounts.             |
| `resource.grant` | `connection_grant` | Applies the exact consumer policy to an existing organization account slot.                                            |

Each proposal carries `ownerUserId`, `justification` and `dataSensitivity`
(`public`, `internal`, `confidential` or `restricted`), plus an optional
`ownerTeam` label. The owner must be an active organization member. Provider
templates supply a default sensitivity of `confidential`; put the chosen
sensitivity explicitly in the proposal so the approver sees it.

For example, the proposal body for a tedi is:

```json
{
	"kind": "tedi",
	"name": "Research",
	"slug": "research",
	"ownerUserId": "<canonical-user-id>",
	"ownerTeam": "Research",
	"justification": "Prepare research for the team to review",
	"dataSensitivity": "internal"
}
```

Requests use the existing approval inbox and Deck. Approval and execution
have separate receipts: read `proposal.execution` to distinguish pending,
running, succeeded and failed execution. A failed execution needs an operator
to inspect the target before requesting another action. An interrupted running
execution also needs inspection; it is not automatically replayed.

A connection slot starts with no agent consumers and no provider grant. The
person still completes provider consent and redeems their own connect ticket.
Approve a separate `resource.grant` proposal when agents should use that account.

Connection owners can also limit which tedis or exact skill revisions may use
their personal credentials. Discover `connections.setConsumerGrants` and
`connections.getConsumerGrants`: `scope: "user"` reads or changes the signed-in
person's policy in the current organization; omitted scope means organization
credentials. Only the person can change their personal policy. A provider's
policy and a named account's policy must both allow the consumer. These limits
apply before credential lookup, including labeled providers and personal
fallbacks. The person's own direct use remains available.

When a tedi is refused, Tedix puts an access request in the connection owner's
existing inbox. Retries reuse one card for the same tedi, exact skill revision
and connection. Accepting the card adds that consumer while keeping the other
grants; declining leaves access blocked. A skill request allows only its exact
revision. The owner and consumer are checked again when the person accepts.
This approval changes Tedix access rules; provider sign-in and consent remain
with the person.
Creating an agent does not grant an Earned Delegation entrustment or recertify
one. Direct `tedis.create` remains available under its existing authorization.

## Limit a GitHub connection

An administrator can open **Accounts → Organization**, expand a GitHub account's
**Details**, and enable **Only these repositories**. Enter one `owner/repository`
per line, then save. An empty list blocks every repository. Limits on the default
connection also apply to its named organization accounts; an account's own limit
can narrow that list further. Consumer grants still decide which tedis and skill
revisions may use the connection.

Limited GitHub connections support issue updates (`issue_write` with
`method: "update"`), file reads (`get_file_contents`), and file updates
(`create_or_update_file`) through GitHub's official MCP endpoint. Other operations
and transports are refused when limits are set. Personal connections keep their
own access rules.

A pending approval does not preserve access. Execution checks the current limits
again, including a provider's approval continuation. Removing a repository while
its update awaits approval prevents that replay from making the update. Agents
must report a refusal and request the required access rather than switch accounts.

## Authority and evidence rules

- Read-only discovery does not authorize a mutation.
- Treat write-capable calls as production changes to the selected organization.
- Human-required consent, MFA and user presence belong to the human. Other
  approvals go to the designated independent principal, which may be a tedi.
- A queued automation run, green test, commit, or health check proves only itself.
- For completion, read the settled run or task, relevant artifacts, mutation
  receipt, and live target state.
- Preserve `supportedClaims`, `unsupportedClaims`, and evidence references from
  tool results. Do not upgrade partial evidence into a stronger claim.
- Never request, print, or persist browser cookies, OAuth grants, API keys, or
  secret-provider values.

A question to a person lands in their Needs you list, so send one only for a
decision or step that person alone can take, and give a one-line `reason`.
Never send housekeeping, such as closing or cancelling scratch Work or
confirming a cleanup: finish it yourself, or record it on your own Work Item.

## Record your autonomous decisions

When you decide something on your own that a person might later ask about,
such as pausing a lane, choosing between fixes, raising a limit or picking an
architecture, record it with `record_agent_decision` or `tedix decide`:

```sh
tedix decide '{"agentName":"Lead","decisionClass":"lane.pause","question":"Pause the idle review lane?","options":[{"id":"pause","label":"Pause it"},{"id":"keep","label":"Keep it running"}],"chosen":"pause","reason":"Idle for an hour while holding two slots.","reversibility":"two_way","confidence":0.8,"workItemId":"<uuid>"}'
```

The `agentSession` defaults to your session. Give the options you weighed, the
one you chose and why, how easy it is to undo, any protected effects (data,
contract, production, money, consent, message, commitment) and your confidence.
Link the Work item, commits, an Output, or an earlier decision with
`priorDecisionId` and `priorRelation` (`depends_on` or `supersedes`).

- The person you work for sees it in their Activity as "Decided by <agent>". Routine
  decisions are grouped into one digest per day.
- Once a day, after the organization's review hour, a Decisions card lists the
  decisions a person may want to check: those that touch protected effects,
  are hard to undo, or that you were unsure about.
- When you learn how a decision turned out, record it:
  `tedix decide outcome <decision-id> worked|reverted|partial '<evidence>'`.
  Add `person` when a person overrode or undid it; that is recorded as a
  correction and teaches agents which kinds of decision to leave to people.
- `tedix decide list` shows recent decisions, their outcomes and which
  decision classes have earned trust.

Recording a decision never grants authority. A decision that needs a person
still goes through an approval first. Record the decisions that matter, not
every step: each session may record a limited number per hour.

## Repository agents

The public [tedix-hq/tedix](https://github.com/tedix-hq/tedix) repository has a
root `AGENTS.md` with scoped repository rules, validation commands, and
architecture invariants. Read it and the nearest scoped `AGENTS.md` before
changing files. The [coding-agent operating manual](./AGENTS.md) is the same
guide on this site.

For a human first run, continue with [Getting started](./getting-started.md).

## Situational recall for local lanes

Approved memory lessons can carry `learningFeed.triggers`: `pathGlobs`,
`commands`, `keywords`, and optional `repos` and `organizations` constraints.
Use `update_lesson_triggers` to edit them, or `backfill_lesson_triggers` to
infer missing triggers in bounded batches with a small model. Existing triggers
are preserved. These are memory records, not repository rules or CI gates.

The local plugin's `PreToolUse` hook calls `tedix hooks situational-recall`
for file edits and shell commands. Matching happens locally against a catalog
cached for one hour per credential, organization, repository and harness. Local
matching uploads no target paths, commands or brief text. Lessons arrive with a
soft reminder to apply them; a failed recall never prevents the action.

Launchers should obtain their prompt with `tedix lane brief <brief-file>
--host codex` (or `claude`) and pass its output to the harness. `lane start`
also prints the recalled context and enriched brief in its JSON receipt;
`--brief-file` supplies the full brief instead of just the title. `work handoff`
prefixes the launch prompt automatically. This path works independently of
plugin hook trust. A missing catalog is reported as unavailable in the lane
receipt, and grants no execution authority.

Server dispatch also prefixes a lane-request Interaction with lessons matching
its prompt. The repository comes from `metadata.laneRequest.repo` or an explicit
`Repo <URL-or-path>` line in the brief;
`laneRequest.harness` selects the host. The recipient preserves that context
when launching the lane. Dispatch to another user never includes the sender's
private lessons. `metadata.lessonRecall` records which lessons were prefixed;
that is an offered brief, not proof the receiving model read it.

`lane fail` reports the failure reason to `record_lesson_incident`. Incident
fingerprints link recurring failures to lessons that already existed; the record
keeps the reported session, harness, hook trust, dispatch path and delivery state.
A suspected delivery gap creates proposed Work, once per fingerprint, lesson and
actor session. Unknown delivery stays unknown; an observed delivery does not
create a delivery-gap proposal. Other incident producers can use the same tool.

## Devin lanes

[Set up Devin](./cli.md#devin-cli) before assigning it local coding Work.
Choose executor `devin` in Work or run
`tedix lane serve --executor devin --workspace <profile> --organization <org>`.
`any-local` considers Devin only when `devin auth status` confirms it is usable.
The dispatcher obtains a persistent native session and resolved model through
ACP metadata before starting an Attempt; missing metadata stops before a model
turn. Its normal admission, heartbeat, lease expiry and settlement rules apply.
Devin receives the same accepted outcome, brief and revisioned standing rules
as the other local executors. Native identity is `devin:<session-id>`; word-pair
ids are accepted alongside UUIDs. Never invent a session or reuse another host's
identity. Include the repository's Work and Agent-Session commit trailers and
`Co-Authored-By: Devin <noreply@devin.ai>` when Devin authors a commit.

The runner changes into the worktree and uses `-p --prompt-file`, native resume,
`--respect-workspace-trust false`, mandatory `--sandbox`, a generated `--config`,
and `--export`. It retains the ATIF transcript in the
private lane temporary directory (or `--transcript <path>`), captures stdout as
the final message, and checks both the exported session identity and
`devin list --format json` before settlement.
Usage and cost remain unknown unless observed; stdout is a report, not verified
completion evidence.

The permission profile approves worktree file reads/writes, explicit development
command prefixes (`bun run`, `bun test`, `tedix`, `rg`, `ls`, `cat`, `sed`), selected
Git commands, `gh run list/view` and the documentation domains.
Sandboxing selects Devin's autonomous mode; the lane PreToolUse hook still rejects
commands outside the explicit scope, including compound shell commands. Raw Git pushes, Tedix login, Wrangler deploy,
`curl`, `wget`, `ssh`, `scp` and `env` are denied. Use guarded `bun run push`.
Read/write denies protect credential stores, SSH keys, user configuration and
dotenv files. The OS sandbox applies the read denies to exec processes too;
indirect runtime reads cannot bypass them. This also prevents commands needing
those credentials from reading them. Shared Tedix plugin MCP access is disabled
before discovery, so it cannot refresh the owner's OAuth grant.
For admitted Work, the runner asks Devin for a final `TEDIX_WORK_RESULT` JSON
line containing `outcome` (`succeeded` or `failed`) and `note`. The dispatcher
renews the exact Attempt and posts only that note to its admitted Work using
the lane's existing identity. It exposes no credentials or arbitrary tool proxy.
Missing or malformed results, incomplete outcomes, and delivery errors fail the
run. A saved note records the agent's report; it does not prove that report correct.
The lane also fails if the sandbox or permission hook fails.
The runner supplies a temporary Git config containing only author name and email;
credential helpers and owner config remain hidden.
The user-level setup installs lifecycle hooks without the lane permission hook.

Before ACP creation and every resumed launch, `.devin/` and `.claude/` must
match HEAD with no untracked or ignored additions. Executable project hooks are
rejected even when committed; use the generated lane hooks. Verification disables
Git fsmonitor and text conversion helpers. Inspect and remove unexpected changes
before retrying.
Conversation exports matching `*.devin.atif.json` are ignored by Git.

Devin's live hook dispatch, ACP persistence and MCP read must be checked after
login with the smoke test. Unlike Codex, Tedix does not queue or automatically
resume idle interactive Devin sessions to deliver supervisor replies; inspect
Tedix OS and continue the session yourself. ATIF token/tool import and historic
decision import are not implemented; lane liveness and final stdout are reported.
