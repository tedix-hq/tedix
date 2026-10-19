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
| Run a Cloud worker               | Sign in to an invited beta organization, then follow [Your first digital worker](./learning-paths/first-worker.md).           |
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
`https://connect.mcp.tedix.dev/mcp` and six skills: `tedix-session-guide`,
`tedix-connect`, `tedix-delegate`, `tedix-resume-work`,
`tedix-workspace-output` and `tedix-guardian-session`. In Claude chat and
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
account with `get_profile`, resolve the organization separately, and make one
bounded read-only call through Code Mode. Account identity, organization
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
external-agent session from the owner's authorized workspace. The CLI reads the
harness session id (`CLAUDE_CODE_SESSION_ID` or the Codex chat id); set
`--agent-harness` to select the matching native id when a launcher supplies
another harness's environment too. An explicit `TEDIX_AGENT_SESSION` override
takes precedence; its prefix must match the requested harness. A missing
matching id or conflicting prefix stops bootstrap before credential exchange.
With multiple native harness ids and no explicit selection, bootstrap asks you
to choose rather than attributing the worker to its launcher.
Set `TEDIX_AGENT_SESSION` to the returned full session key for subsequent calls
when the environment contains multiple harnesses, or when no native id exists.
The first bootstrap names the profile's principal for the machine and user
(`local-<user>-<machine>`) unless you pass `--agent-key`; every later Claude
Code or Codex session on that profile gets its own Agent-Session under the same
principal. On the first bootstrap, pass `--agent-scopes` with only the MCP
capabilities the task needs; omitting it requests the default broad capability
set. Set `TEDIX_EXTERNAL_AGENT` to the principal key for subsequent CLI calls
and check `tedix agent status` before acting.

For a first worker run, do not bootstrap an external-agent identity. Use the
bounded [first-worker tutorial](./learning-paths/first-worker.md), which targets
one named tedi and shows how to verify that the worker actually ran.

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
Open **Work → Feed → Apps → Office → Your requests** to inspect it. The prompt hook's
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

To dispatch a Codex or Claude lane, Tedix opens a Work-linked `handoff`
Interaction for the executing user's canonical id, with
`metadata.laneRequest.harness` set to `codex` or `claude-code`. Bound
`tedix channel codex` and `tedix channel claude` sessions receive its
`lane.requested` event. Pending open requests replay when a channel binds.
The recipient reads the Interaction and server readiness, then obtains its
own Work admission before executing; concurrent recipients cannot share an
Attempt. Event content carries identifiers, never instructions or credentials.

## Authority and evidence rules

- Read-only discovery does not authorize a mutation.
- Treat write-capable calls as production changes to the selected organization.
- Human-required consent, MFA and user presence belong to the human. Other
  approvals go to the designated independent principal, which may be a tedi.
- A queued workflow, green test, commit, or health check proves only itself.
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

## Repository agents

The public [tedix-hq/tedix](https://github.com/tedix-hq/tedix) repository has a
root `AGENTS.md` with scoped repository rules, validation commands, and
architecture invariants. Read it and the nearest scoped `AGENTS.md` before
changing files. The [coding-agent operating manual](./AGENTS.md) is the same
guide on this site.

For a human first run, continue with [Getting started](./getting-started.md).

## Situational recall for local lanes

Approved brain lessons can carry `learningFeed.triggers`: `pathGlobs`,
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
Git commands, `gh run list/view`, Tedix MCP tools and the documentation domains.
Sandboxing selects Devin's autonomous mode; the lane PreToolUse hook still rejects
commands outside the explicit scope, including compound shell commands. Raw Git pushes, Tedix login, Wrangler deploy,
`curl`, `wget`, `ssh`, `scp` and `env` are denied. Use guarded `bun run push`.
Read/write denies protect credential stores, SSH keys, user configuration and
dotenv files. The OS sandbox applies the read denies to exec processes too;
indirect runtime reads cannot bypass them. This also prevents commands needing
those credentials from reading them; use the configured MCP connection for
Tedix access. The lane fails if the sandbox or permission hook fails.
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
