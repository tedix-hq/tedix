---
sidebar:
  order: 31
title: "How work is organized"
topic: "Platform"
resource_type: guide
description: "How an objective, project, epic, milestone, Work Item, Attempt and request fit together, who owns each, and how an agent finds the next Work Item to do."
summary: "One top-down page: what each work record is, the states a Work Item and an Attempt move through, who completes Work, and how ready Work is ranked"
read_when:
  - Learning which Tedix record to create for a piece of work
  - Looking for the next Work Item an agent should pick up
  - Checking who may complete a Work Item
visibility: public
---

# How work is organized

Tedix organizes work from the reason for it down to one try at doing it. Read
this page top to bottom once; the other guides link back here for these terms.

## The records, top-down

| Record    | What it is                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Objective | A directive a person sets: why work exists. It is one time, standing (for example "keep the docs current") or reactive. A project links to one, and its Work Items inherit that purpose.                                                            |
| Project   | A body of work that serves an objective, with its own Work Items, milestones and budget.                                                                                                                                                            |
| Epic      | A bigger piece of work inside a project, like an incident, an investigation or a feature. It groups several Work Items and has one accountable owner. Tools and the CLI call it a case.                                                             |
| Milestone | A group of Work Items due together, with an optional target date.                                                                                                                                                                                   |
| Work Item | One bounded outcome with a "done when", an owner, a priority and a risk level. This is the unit agents pick up.                                                                                                                                     |
| Attempt   | One try by one executor at a Work Item, under a time-limited lease. A Work Item can have several Attempts over its life; only one may be live at a time.                                                                                            |
| Request   | What a person asks for, in Home or from an agent. Tedix tracks each request with its next owner and next action, and answers it directly or turns it into a Work Item. A request never gives authority to do Work; only an accepted Work Item does. |

An Attempt is the Work-side record of a try. A run is the saved record of one
tedi turn or skill execution. One Attempt can point at several runs.

## Why a Work Item exists: objective or work class

Every Work Item needs a purpose. Normally that is an objective: set
`objectiveId`, or create the Work Item inside a project or under a parent that
already has one.

When no objective applies, the Work Item has a **work class** instead:
`maintenance`, `incident` or `hygiene`. These are exceptions with an expiry.
The purpose exception lasts 7 days by default and at most 30 days. A project
without an objective defaults new Work Items to `maintenance`. Work with the
class `objective` is the normal case.

## States

A Work Item has one durable state, its **disposition**:

| Disposition | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| `proposed`  | Someone suggested it. Nobody has agreed to it, so no agent runs it. |
| `accepted`  | An owner or admin (or a credential with `work:accept`) approved it. |
| `completed` | The accepted outcome is recorded as done.                           |
| `cancelled` | It will not be done.                                                |

"Blocked" is not a disposition. It is a reading from the readiness check: an
accepted Work Item can be blocked by an unfinished dependency, a pending
approval, a live Attempt, an exhausted budget or no free capacity. Read it with
`tedix work readiness <id>`. It is a snapshot, not a grant.

An Attempt has its own state, separate from the Work Item: `queued`,
`running`, `waiting`, `retrying`, then `finished`, `failed`, `expired` or
`cancelled`. An executor settles an Attempt as `succeeded`, `failed` or
`cancelled`. Settling an Attempt does not complete the Work Item.

Milestones are `proposed`, `planned`, `active`, `done` or `cancelled`. Epics
move through `investigating`, `planning`, `executing`, `monitoring` and
`closed`.

## Priority and risk

Priority (`critical`, `high`, `medium`, `low`) says how soon. Risk (`low`,
`medium`, `high`, `critical`) says how much could go wrong. Risk never lowers
to get past an approval; a higher risk can require one.

## Owner, steward and executor

| Role              | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Owner             | The accountable person or tedi. They accept the Work and can complete it.                                  |
| Steward           | A tedi or person who keeps the Work moving and verifies results for the owner. They can complete it too.   |
| Assigned executor | The agent or person whose Attempt is doing the work now. It holds the lease; it does not become the owner. |

## Who completes a Work Item

Completing is a separate step from settling an Attempt. The rule is the same on
every surface:

1. The executor settles its own Attempt with its result and, for coding, the
   full commit SHA.
2. The Work Item is then completed by its owner, its steward, or an organization
   owner or admin. An external agent may complete the Work Item itself only when
   it is accepted, its own latest Attempt settled as `succeeded` (coding also
   needs a commit) and the Work is not a credentials, money or external-message
   action; those stay with the owner.
3. For a lane started by the local dispatcher, the dispatcher requests completion
   under the original session once it has verified the commit or skill-run
   evidence. A lane's report that it succeeded is not itself verification.

Completion records that the outcome is claimed done. It does not prove the
result is correct; check the evidence on the Work Item.

## How an agent finds work

1. Read the Work Item you were given: `tedix work context <id>`. Or search by
   title with `tedix work find "<terms>"`.
2. To see what is waiting, list by disposition. `tedix work list --disposition
   proposed` shows what needs a decision. Never run a proposed item; ask the
   owner to accept it.
3. For accepted Work, ask for the ready list (the Work scheduler's `ready`
   view; discover the exact tool in your connection). It returns accepted items
   with no live Attempt, passing admission, and a score for each.
4. Check `tedix work readiness <id>`, then `tedix work start <id>` to open your
   Attempt.

### How ready Work is ranked

Ready Work is ordered by a score. Higher is picked first. These factors add up:

- **Priority**: critical 100, high 70, medium 40, low 10.
- **Deadline pressure**: rises as the deadline nears, up to a cap. A lapsed
  deadline counts for less each day, so old deadlines stop outranking live work.
- **Waiting time**: a small bounded credit so old Work is not starved.
- **Downstream work**: more for Work that unblocks other Work, and for Work on
  the longest dependency chain.
- **Risk**: subtracts 0, 5, 15 or 30 for low, medium, high and critical.
- **Cost**: subtracts for expensive Work.
- **Pending review**: subtracts when evidence for this Work is waiting to be
  checked.

The ranking is advice. Every start re-checks admission, so a high score never
admits a Work Item by itself.

## Related

- [Core concepts](./concepts.md)
- [Factories, Workspaces and Projects](./factories-workspaces-projects.md)
- [Start here as an agent](./agent-start-here.md)
- [Agent guide](./agent-guide.md)
