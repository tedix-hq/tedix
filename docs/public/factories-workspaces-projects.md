---
sidebar:
  order: 35
title: "Factories, Workspaces and Projects"
topic: "Platform"
resource_type: guide
description: "How a Work project, a Workspace and a tedi fit together into a factory, and which record answers which question."
summary: "Workspace holds Outputs; the Work factory is the control plane; a factory in practice is one project, one Workspace, one tedi and its skills"
read_when:
  - Deciding where a new initiative lives in Tedix
  - Telling a Workspace apart from a Work project
  - Setting up a repeatable "factory" for one kind of deliverable
visibility: public
---

# Factories, Workspaces and Projects

Three words come up as soon as an organization runs more than one initiative
in Tedix. They describe different layers.

| Term         | What it is                                                                                                                                         | Where you see it                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Workspace    | The Tedix OS container for Outputs: documents, sheets, presentations and videos, each with a revision history.                                     | OS → Workspaces                                   |
| Work project | A ledger of Work Items with one owner and one brief. Projects group canonical Work; they do not hold files.                                        | OS → Work → Portfolio, then a project page        |
| Work factory | The control plane around projects: cases, milestones, sprints, health, approvals, interactions, admission and capacity.                            | OS → Work → Cases, Approvals, Admission, Capacity |
| A factory    | In practice: one Work project, one Workspace linked to it, one tedi that owns the work, and the skills or schedule that keep it producing Outputs. | All of the above, per initiative                  |

## Workspace: where the results live

A Workspace is organization-owned and holds the shared workpieces of one line
of work. An Output belongs to a Workspace and is one of four kinds: document,
sheet, presentation or video. Every save is an append-only revision; the
Output points at its current revision. A Workspace can also carry selected
external resources, installed apps and a Blueprint that created it.

A Workspace links to Work projects through an explicit link record, so a
project's Work Items stay in one ledger while the Workspace shows where
their results are. A project name typed into a document is not a link.

## Work factory: the control plane

The Work Item lifecycle (proposed, accepted, attempted, done) is one layer.
The factory records sit around it and are deliberately separate:

| Record                         | Answers                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Case                           | What is being investigated or driven right now. Stages: investigating, planning, executing, monitoring, closed. One accountable owner.     |
| Milestone and sprint           | Which Work Items are due together. Milestones: proposed, planned, active, done, cancelled. Sprints: planned, active, completed, cancelled. |
| Project health judgment        | On track, at risk, off track or paused, as judged at a point in time.                                                                      |
| Approval proposal and decision | Who proposed an action, who decided, and whether it was approved, rejected, cancelled or expired.                                          |
| Interaction                    | A question, input request, handoff or coordination note between humans and agents, with its responses, drafts and delivery receipts.       |
| Admission                      | Whether a Work Attempt was admitted or rejected against policy, budget and capacity.                                                       |
| Resource pool, budget envelope | How much execution capacity and spend a project, case or Work Item may consume, and the reservations held against them.                    |

Receipt tables in this layer are immutable. A record there is evidence of what
happened, not a place to edit history.

## A factory in practice

Most teams do not need every record above. A working factory is the pattern:

1. **One Work project** with a brief that says what the project produces and
   for whom. The brief is the project description; the project page shows it
   under "Brief".
2. **One Workspace** linked to that project, holding the Outputs the project
   exists to produce.
3. **One tedi** that owns the Work Items and writes the Outputs.
4. **Skills or a schedule** that produce the next Output without someone
   asking. The skill carries the procedure; the schedule decides when.

A new initiative gets a new project. If it will produce files, give it a
Workspace too. If it is a short investigation, open a case inside an existing
project instead of a project of its own.

## Which record answers which question

| Question                      | Look at                                          | Not at                     |
| ----------------------------- | ------------------------------------------------ | -------------------------- |
| What is this initiative for?  | The project brief                                | A Workspace name           |
| What is being worked on now?  | Open cases and accepted Work Items               | Documents in the Workspace |
| What was produced?            | Outputs and their current revision               | A Work Item marked done    |
| Who worked on it?             | Attempts and the project's Contributors list     | The Workspace creator      |
| Why did an Attempt not start? | Its admission record                             | The Work Item status       |
| What is waiting on a person?  | Open interactions and pending approval proposals | Comments on a Work Item    |

For an agent procedure that walks these records with native tools, read
[Build and inspect a factory as an agent](./factory-agent-guide.md). For how
sessions attach to a project, read
[Track sessions per project](./sessions-per-project.md).
