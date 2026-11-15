---
sidebar:
  order: 35
title: "Factories, Workspaces and Projects"
topic: "Platform"
resource_type: guide
description: "How a Work project, a Workspace and a tedi fit together into a factory, and which record answers which question."
summary: "Workspace holds Documents; the Work control plane tracks epics, approvals and requests; a factory is a recurring lane owned by a tedi"
read_when:
  - Deciding where a new initiative lives in Tedix
  - Telling a Workspace apart from a Work project
  - Setting up a repeatable "factory" for one kind of deliverable
visibility: public
---

# Factories, Workspaces and Projects

Three words come up as soon as an organization runs more than one initiative
in Tedix. They describe different layers.

| Term               | What it is                                                                                                                                                                                                                        | Where you see it                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Workspace          | The Tedix OS container for Documents: documents, sheets, presentations and videos, each with a revision history.                                                                                                                  | OS → Workspaces                                                |
| Work project       | A ledger of Work Items with one owner, one brief and a goal. It is either a standing area of work with no end date or an engagement with a target date, archived when it ends. Projects group Work Items; they do not hold files. | OS → Work → More views → Projects, then a project page         |
| Work control plane | The control plane around projects: epics, health, approvals, requests, admission and capacity.                                                                                                                                    | OS → Work → More views → Epics, Approvals, Admission, Capacity |
| A factory          | A recurring lane owned by a tedi: a Work project and goal, a skill, a schedule, a Workspace and a durable result.                                                                                                                 | All of the above, per initiative                               |

## Workspace: where the results live

A Workspace is organization-owned and holds the shared workpieces of one line
of work. A Document belongs to a Workspace and is one of four kinds: document,
sheet, presentation or video. Every save is an append-only revision; the
Document points at its current revision. Tools and the API call it an Output. A Workspace can also carry selected
external resources, installed apps and a Blueprint that created it.

A Workspace links to Work projects through an explicit link record, so a
project's Work Items stay in one ledger while the Workspace shows where
their results are. A project name typed into a document is not a link.

## Work control plane

The Work Item lifecycle (proposed, accepted, completed or cancelled) is one layer; Attempts record each try separately. See [How work is organized](./how-work-is-organized.md).
The factory records sit around it and are deliberately separate:

| Record                               | Answers                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Epic (a case in the API and the CLI) | A bounded push toward one outcome, with one accountable owner and a target date. It groups Work Items, which may sit in several projects. Stages: investigating, planning, executing, monitoring, closed. There are no sprints or milestones; a dated checkpoint is an epic with a target date. |
| Project health judgment              | On track, at risk, off track or paused, as judged at a point in time.                                                                                                                                                                                                                           |
| Approval proposal and decision       | Who proposed an action, who decided, and whether it was approved, rejected, cancelled or expired.                                                                                                                                                                                               |
| Request (an interaction in the API)  | A question, input request, handoff or coordination note between people and agents, with its responses, drafts and delivery receipts.                                                                                                                                                            |
| Admission                            | Whether a Work Attempt was admitted or rejected against policy, budget and capacity.                                                                                                                                                                                                            |
| Resource pool, budget envelope       | How much execution capacity and spend a project, epic or Work Item may consume, and the reservations held against them.                                                                                                                                                                         |

Receipt tables in this layer are immutable. A record there is evidence of what
happened, not a place to edit history.

### Give new Work a steward

An organization owner or admin can set `metadata.workStewardship` through
`organizations.update`. Set `enabled: true`, then supply project IDs and tedi
IDs in `projectStewards`, Work kinds and tedi IDs in `workKindStewards`, and
an optional `defaultTediId`. All IDs must belong to that organization.

For Work without an explicit owner or steward, creation chooses the configured
project steward, then the project's tedi lead, then the Work kind's steward,
then the organization default. Set `useProjectLead: false` to skip the project
lead. The chosen tedi must be active and not retired. An invalid choice leaves
the item unassigned. Human-owned Work and Work marked for human execution keep
their existing assignment. This rule applies to new Work, including support
intake; it does not reassign existing items, accept Work, or complete it.

Coding lanes only take coding Work. To have tedis start the rest, add
`autoRoute: { enabled: true }` to the same policy. Every ten minutes, accepted
Work that is not coding, has a done-when, has no executor and is not already
running goes to its steward tedi. If it has no steward, the order above picks
the tedi. Each item is handed over once, and a comment on the item names the
tedi and its run. Work that may need a person, such as payments, credentials or
messages to people outside, gets a comment and is left for a person.
`autoRoute.maxPerRun` (1 to 10, default 2) limits how many items each run hands
over per organization.

## A factory in practice

Most teams do not need every record above. A working factory is the pattern:

1. **One Work project** with a brief that says what the project produces and
   for whom. The brief is the project description; the project page shows it
   under "Brief".
2. **One Workspace** linked to that project, holding the Documents the project
   exists to produce.
3. **One tedi** that owns the Work Items and writes the Documents.
4. **Skills or a schedule** that produce the next Document without someone
   asking. The skill carries the procedure; the schedule decides when.

A new engagement, such as a customer pilot, gets a new project with a target
date; archive it when it ends. If it will produce files, give it a Workspace
too. A bounded push inside your standing areas, such as an investigation or a
feature, is an epic, not a project of its own.

## Which record answers which question

| Question                      | Look at                                      | Not at                     |
| ----------------------------- | -------------------------------------------- | -------------------------- |
| What is this initiative for?  | The project brief                            | A Workspace name           |
| What is being worked on now?  | Open epics and accepted Work Items           | Documents in the Workspace |
| What was produced?            | Documents and their current revision         | A Work Item marked done    |
| Who worked on it?             | Attempts and the project's Contributors list | The Workspace creator      |
| Why did an Attempt not start? | Its admission record                         | The Work Item status       |
| What is waiting on a person?  | Open requests and pending approval proposals | Comments on a Work Item    |

For an agent procedure that walks these records with native tools, read
[Build and inspect a factory as an agent](./factory-agent-guide.md). For how
sessions attach to a project, read
[Track sessions per project](./sessions-per-project.md).
