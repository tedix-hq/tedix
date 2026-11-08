---
sidebar:
  order: 36
title: "Workspaces"
topic: "Platform"
resource_type: guide
description: "What a workspace is now, what happens when you ask it something, what it records, how approvals appear, and what running workspaces yourself needs."
summary: "An operator's guide to the workspace object: the data it owns, the agent it runs, its records and approvals, and self-hosting needs"
read_when:
  - Operating workspaces for an organization
  - Understanding what a workspace records and where its approvals appear
  - Checking what a self-hosted installation needs for workspaces
visibility: public
---

# Workspaces

A workspace is the place in Tedix OS where one line of work keeps its
things: its documents, sheets and presentations with their revision
history, its conversations, and its memory. Each workspace is one object —
it holds its own data and runs its own agent in the same place. A question
asked in a workspace is answered next to its data, not relayed to a shared
service and back.

Workspaces belong to the organization. A workspace still links to Work
projects, carries installed apps and connected resources, and a tedi can
work inside one as a guest under its own name and permissions. The things a
workspace does not own — the organization's Home conversation, its Work
board, the directory of workspaces — stay in the organization's shared
store.

## Ask a workspace something

Open a workspace in Tedix OS and use its chat. An agent connected to your
organization can ask the same workspace through its workspace tools.

Use **Workspace resources** beside the message box to select up to five
native documents, sheets or presentations for your next message. You can
remove a selection before sending. The workspace checks access again when
you send and includes the saved contents, up to 64 KB in total. The message
records the selected file names and revision numbers; opening a file shows
its current version. The conversation retains the contents used for that turn.

Uploading a file saves it to the workspace but does not attach its bytes to
your message. Workspace chat cannot yet read uploaded file bytes, videos or
connected-source content through this selector. Selecting an unsupported or
unavailable file shows an error and does not start a turn. Use a native file
containing the material you want the workspace to read.

When you send a message, the workspace's agent answers in steps:

1. It reads your message and decides what it needs: the workspace's
   documents, its apps, its connected resources, or the Work items of the
   projects the workspace is linked to.
2. For each step it writes a small program that runs inside the workspace.
   The program cannot reach the network; the only things it can call are
   this workspace's own data and tools.
3. Every call is checked before it runs. Reads just run. A change is
   recorded, and when policy says a person must decide, the call waits for
   approval.
4. You watch the steps as they happen, then read the answer. The exchange
   is saved as a turn you can read back later.

## What the workspace records

The workspace keeps its conversations and change records next to its data.
Its Activity view shows recent recorded file changes that you can access.
That list can be incomplete; it does not show every agent action. Open the
conversation to review its steps and approval results. The workspace stays
the source of truth for its own data.

- **Conversations and turns.** Each question, the steps the agent took and
  the answer, with who asked: a person, a tedi or an external agent.
- **Change records.** One record per action: what was called, the revision
  before and after, who or what did it, and how to undo it. The record is
  append-only; nothing edits history.
- **Approvals.** What the agent asked to do, the reason and policy it
  cited, who approved or denied, and when.
- **Revisions.** Every save of a document, sheet or presentation is a new
  revision; older ones stay readable.

## How approvals appear

When a step would change something and policy says a person decides, the
turn pauses and a card appears in the conversation. It shows what the agent
wants to do, why, and under which policy. Approve applies the change and
the agent continues; Deny stops that action, and the agent does not retry
it. The decision is recorded with the name of who made it.

Reads never ask. Sign-in, consent and the other steps reserved for a person
stay with the person, as everywhere in Tedix; see
[What an AI assistant may do and who says yes](./workers-and-governance.md).

## What self-hosting needs

Workspaces are part of the tenant product, not an add-on: the same
installation that serves Tedix OS hosts them. An installation needs:

- the Cloudflare products its installation manifest declares — the paid
  Workers plan covers what workspaces use; see
  [Self-hosting and the managed service boundary](./self-hosted-boundary.md);
- a region for workspace objects, set by the installation
  (`DO_JURISDICTION`; Tedix Cloud uses `eu`);
- a configured Azure OpenAI deployment and an authenticated AI Gateway for
  workspace chat. The model selector offers only the configured deployment;
  reliable cost estimates are not available;
- for the one-time move of existing workspaces, the runbook and the
  migration token in
  [Move workspaces into workspace objects](./workspace-migration.md).

Locally, `bun run-local` gives you workspaces with their data on your own
machine and no account. Answers need model calls; add
`--inference --workers-ai-account=<account-id>` as in
[Getting started](./getting-started.md).
