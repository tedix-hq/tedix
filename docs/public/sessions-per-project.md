---
sidebar:
  order: 36
title: "Track sessions per project"
topic: "Platform"
resource_type: guide
description: "How Claude Code and Codex sessions report into a Work project, and where Tedix OS shows who is working on what."
summary: "Opt-in session ingestion, private Your requests, live Attention and project contributors for every member"
read_when:
  - Running several coding sessions and wanting one view of them
  - Finding which session or agent touched a project
  - Deciding what a Work project page should show its owner
visibility: public
---

# Track sessions per project

A project is the purpose; sessions are the workers that come and go. Tedix
ties each local Claude Code or Codex session to a Work project so the owner
sees progress by project instead of by terminal window.

## What a session reports

These features work for every signed-in organization member with the Tedix
plugin and CLI hooks. No particular user, administrator role, coordinator
name or pre-seeded board is required. Install the plugin through your host,
select your organization, then opt in on this machine:

```sh
tedix setup agents context enable-decision-capture --project <project-id>
```

The project is your inbox for sessions outside a bound repository. Repository
bindings take precedence. This opt-in enables the private request ledger and
session status reporting in that organization; the first uploaded event or
status creates your own records. `TEDIX_AGENT_STATUS=0` or an explicit
`"enabled": false` in `~/.tedix/agent-status.json` disables status reporting.
Use `tedix setup agents context disable-decision-capture` to stop new session
ingestion; that does not delete records already uploaded. Status separately
enabled in `agent-status.json` remains independently enabled.

With the Tedix CLI (0.8.8 or later) and its `status` hook enabled, every
session reports a short status record to your organization at turn and
lifecycle events. Since CLI 0.8.8 the record carries:

| Field     | Source                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Name      | The name the owner gave the session: the last `/rename` title in Claude Code, or the thread name in Codex. Falls back to "folder · branch". |
| Project   | The Work project this checkout is bound to, from the local agent-context binding.                                                           |
| Work Item | The Work Item the session has selected, when one is selected.                                                                               |
| State     | Working, needs you, done, error, idle or ended, with a 160-character summary. Idle is derived from age when the board is read.              |

A change of name or binding is reported as its own event. The server keeps a
project or Work Item only when it belongs to the caller's organization. The
hook sends no transcript content; the summary is the last line it recorded.

Enable the hook with `TEDIX_AGENT_STATUS=1` or `"enabled": true` in
`~/.tedix/agent-status.json`. Bind the checkout with
`tedix setup agents context bind` and select an item with
`tedix setup agents context select <id>`; the [CLI reference](./cli.md) covers both.
Binding is correlation, not execution authority: a bound session still needs
an admitted Attempt before it may change a Work Item.

## Where Tedix OS shows it

| View                             | Shows                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Work (home) → Attention          | Live lanes, Work Attempts and runs in the selected organization, plus your own session activity and unfiled requests. Updates use the existing live connection, sampled every two seconds while open. Opening Work lands here. |
| Work → Portfolio                 | Projects grouped into buckets, each card with its brief line and next item. A "Needs you" strip lists open questions in your inbox and approvals you can decide.                                                               |
| Project page                     | The project's **Brief** (its description, verbatim) and **Contributors**: every session that reported into the project or held an Attempt on its Work Items, active first, with state, current item and Attempt count.         |
| Work → Agents                    | Your sessions grouped by project, most urgent project first. Sessions with no binding sit under "No project".                                                                                                                  |
| Work → Interactions              | The questions and handoffs those sessions raised, with their answers.                                                                                                                                                          |
| Work → Needs you → Your requests | Your private requests, promises and open loops across your local sessions, with status and evidence.                                                                                                                           |

Independent local sessions register with `tedix lane start "<title>"
--project <project-id>` after bootstrapping their own agent identity. Registration
uses ordinary Work admission and a bounded heartbeat; `lane done` or `lane fail`
settles that same session's Attempt. A host's subagents share its Attempt.
Transcript-reported lanes without registration appear as unconfirmed activity,
not as admitted or running workers.

For an optional scheduled document, install the repository's
`apps/skill-runtime/examples/living-status-board` example in a private workspace
owned by the member and grant that skill read access to **Session activity**.
Its parameters hold the destination, owner, time zone and schedule. The first
run creates that member's **Session activity** document; later runs reuse it.
It is a snapshot, not the live Attention feed. Installing the plugin does not
create or activate a scheduled skill.

## Session ingestion and privacy

With decision capture enabled, `capture-reply` uploads the message you type
and `capture-stop` uploads the assistant's turn text, delegated reports and a
bounded digest of tool failures and lane activity. Events also carry the host
session id, repository name and timestamp. Prompt text is bounded to 8,000
characters and activity to 4,000; assistant turns include the full redacted
turn text. This is content upload, not anonymous telemetry.

Before upload or storage in the local retry outbox, the CLI removes known
credential patterns and applies the decision-capture redaction rules. Redaction
is best effort: ordinary prose can contain private information. A failed upload
stays in a private local outbox for a later hook to retry. No capture occurs for
unattended runs. Disabling capture prevents new uploads, including pending
outbox retries, until capture is enabled again.

Uploaded message text, derived request text, session summaries and proposed
recovery lessons are private to you in the selected organization. Other members,
including organization admins, can see project lane titles, attention states
and explicit shared Work records, but cannot read your private message text or
summaries through Contributors, Attention or the request-ledger APIs. A failed
turn classification never copies the turn into a shared Work comment.

Sharing is a separate action. You may share information explicitly in Work or
grant a particular scheduled skill access to your **Session activity** resource.
That grant is checked against the actual run and can be revoked; a private
workspace keeps the derived document private too. Merely being an org admin
does not supply that grant. Opt-in capture also creates questions addressed to
you in Interactions; unrelated members cannot read their bodies.

A project's bucket on the Portfolio comes from the project's metadata field
`portfolioBucket`; archived and done projects, and projects with no recognised
bucket, fall under "Other". Placeholder briefs read as empty.

## A typical day

1. The owner opens Work. Attention shows active lanes, waiting work and
   unattended projects; Your requests holds their unfinished chat requests.
2. A session that cannot continue reports "waiting for you" and the question
   appears under "Needs you" and in Interactions.
3. The owner answers in Tedix OS; the session's host picks up the answer and
   the project page moves the contributor back to "working".
4. A new session in the same checkout inherits the binding and shows up as a
   second contributor on the same project.

## Limits

- Only sessions on machines with the CLI hooks installed report. Claude chat
  and the ChatGPT desktop app have no local hooks, so they do not appear as
  contributors unless they hold an Attempt.
- Contributors list sessions, not people. A session key is
  `<harness>:<host session id>`.
- Idle, and ended after 12 silent hours, are derived from age when read; nothing is swept.
  On a project page, a contributor with no report or Attempt heartbeat for 24
  hours reads as ended, whatever it last reported.

Related: [Factories, Workspaces and Projects](./factories-workspaces-projects.md),
[Core concepts](./concepts.md).
