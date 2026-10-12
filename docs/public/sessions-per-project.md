---
sidebar:
  order: 36
title: "Track sessions per project"
topic: "Platform"
resource_type: guide
description: "How Claude Code and Codex sessions report into a Work project, and where Tedix OS shows who is working on what."
summary: "The status hook reports session name, project and Work Item; project pages show Brief and Contributors; Work > Agents groups by project; Work opens on the Portfolio"
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

| View                    | Shows                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work (home) → Portfolio | Projects grouped into buckets, each card with its brief line and next item. A "Needs you" strip lists open questions in your inbox and approvals you can decide. Opening Work lands here.                              |
| Project page            | The project's **Brief** (its description, verbatim) and **Contributors**: every session that reported into the project or held an Attempt on its Work Items, active first, with state, current item and Attempt count. |
| Work → Agents           | Your sessions grouped by project, most urgent project first. Sessions with no binding sit under "No project".                                                                                                          |
| Work → Interactions     | The questions and handoffs those sessions raised, with their answers.                                                                                                                                                  |

A project's bucket on the Portfolio comes from the project's metadata field
`portfolioBucket`; archived and done projects, and projects with no recognised
bucket, fall under "Other". Placeholder briefs read as empty.

## A typical day

1. The owner opens Work. The Portfolio shows each project's next item and the
   questions waiting on them.
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

Related: [Factories, Workspaces and Projects](./factories-workspaces-projects.md),
[Core concepts](./concepts.md).
