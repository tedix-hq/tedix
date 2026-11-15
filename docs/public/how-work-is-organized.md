---
sidebar:
  order: 31
title: "How work is organized"
topic: "Platform"
resource_type: guide
description: "How a goal, project, epic, Work Item, Attempt and request fit together, who owns each, how new work is sorted, and how an agent finds the next Work Item to do."
summary: "One top-down page: areas and engagements, epics, Work Items and Attempts, triage, who completes Work, how runners pick work, and an example map of areas to code"
read_when:
  - Learning which Tedix record to create for a piece of work
  - Looking for the next Work Item an agent should pick up
  - Checking who may complete a Work Item
  - Finding which area of work owns a part of the code
visibility: public
---

# How work is organized

Tedix organizes work from the reason for it down to one try at doing it. Read
this page top to bottom once; the other guides link back here for these terms.

## The records, top-down

| Record    | What it is                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal      | Why work exists, with a statement of what success looks like. Projects and epics serve a goal. The API and tools call it an objective.                                                                                                                                 |
| Project   | Either an **area** or an **engagement**. An area is a standing part of the organization's work with no end date, such as Database, API or CLI. An engagement has an end date, such as a customer pilot, and is archived when it ends.                                  |
| Epic      | A bounded push toward one outcome, with an owner and a target date. Think of it as an agreement about a result. It groups Work Items, and they may sit in several areas. The API and the CLI call it a case.                                                           |
| Work Item | One piece of work with a "done when", an owner, a priority, a risk level and the person or agent assigned to do it. This is the unit agents pick up.                                                                                                                   |
| Attempt   | One try at a Work Item by one person or agent, under a time-limited lease. A Work Item can have several Attempts over its life; only one may be live at a time.                                                                                                        |
| Request   | A question, a request for input, a handoff or a coordination note addressed to a person. The Decisions page shows open requests as cards, one at a time. A request never gives authority to do Work; only an accepted Work Item does. The API calls it an interaction. |

Give every project one owner, a brief that says what it is for, and a goal.
Tedix stores areas and engagements as the same kind of record. What tells them
apart is how you use them: give an engagement a target date and archive it when
it ends; leave an area open.

Tedix has no sprints and no milestones. When a date matters, open an epic and
give it a target date. Before you close an epic, record on it what was
delivered, for example a link to the result. Tedix does not check that for you.

An Attempt is the Work-side record of a try. A run is the saved record of one
tedi turn or skill run. One Attempt can point at several runs.

## Triage: sort new work before accepting it

A new Work Item starts as `proposed`. A proposed Work Item is in triage: nobody
has agreed to it yet. For each one, a person or lead does one of these:

1. Sorts it into the area or engagement it belongs to
   (`tedix work move <id> --project <id>`), then accepts it with a "done when"
   and names who should do it:
   `tedix work accept <id> --done-when "<what done looks like>" --executor <exec>`.
2. Cancels it, with the reason, if it should not be done.

Triage is an inbox that should be empty, not a backlog. This is a working
practice: today Tedix does not refuse to accept a Work Item that has not been
sorted into a project.

## Why a Work Item exists: objective or work class

Every Work Item needs a purpose. Normally that is a goal: set `objectiveId`
(the API name for a goal), or create the Work Item inside a project or under a
parent that already has one.

When no goal applies, the Work Item has a **work class** instead:
`maintenance`, `incident` or `hygiene`. These are exceptions with an expiry.
The purpose exception lasts 7 days by default and at most 30 days. A project
without a goal defaults new Work Items to `maintenance`. Work with the
class `objective` is the normal case.

## States

A Work Item has one durable state, its **disposition**:

| Disposition | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| `proposed`  | Someone suggested it. It is in triage; nobody has agreed to it yet. |
| `accepted`  | An owner or admin (or a credential with `work:accept`) approved it. |
| `completed` | The accepted outcome is recorded as done.                           |
| `cancelled` | It will not be done.                                                |

A proposed Work Item is in triage, whether or not it has a project yet. Tedix
accepts it only when it has a project, a statement of what done looks like and
an accountable owner; otherwise the accept is refused and the message names
what is missing.

"Blocked" is not a disposition. It is a reading from the readiness check: an
accepted Work Item can be blocked by an unfinished dependency, a pending
approval, a live Attempt, an exhausted budget or no free capacity. Read it with
`tedix work readiness <id>`. It is a snapshot, not a grant.

An Attempt has its own state, separate from the Work Item: `queued`,
`running`, `waiting`, `retrying`, then `finished`, `failed`, `expired` or
`cancelled`. An executor settles an Attempt as `succeeded`, `failed` or
`cancelled`. Settling an Attempt does not complete the Work Item.

Epics move through `investigating`, `planning`, `executing`, `monitoring` and
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
3. For work a runner started, the runner requests completion under the original
   session once it has verified the commit or skill-run evidence. An agent's
   report that it succeeded is not itself verification.

Completion records that the outcome is claimed done. It does not prove the
result is correct; check the evidence on the Work Item.

## How an agent finds work

A person or lead accepts work and names who should do it. Runners then take
accepted work assigned to them, most important first:

1. Priority: critical, then high, medium, low.
2. Then the nearest due date. Work without a due date comes after dated work.
3. Then the oldest.

Anything that cannot start says why: `tedix work readiness <id>` lists what is
in the way.

If you are an agent working by hand instead of through a runner:

1. Read the Work Item you were given: `tedix work context <id>`. Or search by
   title with `tedix work find "<terms>"`.
2. To see what is in triage, run `tedix work list --disposition proposed`. Do
   not start a proposed item; ask the owner to accept it.
3. Check `tedix work readiness <id>`, then `tedix work start <id>` to open your
   Attempt.

### The scheduler's ready list

A lead that plans across many Work Items can also ask the Work scheduler for
its `ready` view (discover the exact tool in your connection). It returns
accepted items with no live Attempt that pass admission, each with a score.
Higher scores come first. These factors add up:

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

## Example: one organization's areas

Each organization chooses its own areas. This is how the team that builds Tedix
divides its work. Every area is a project with one owner and a goal, and the
paths show which code and docs belong to it.

| Area                    | Goal: what good looks like                                                            | Code and docs                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tedix OS                | People can see their work, decide what needs them and find results without help.      | `apps/os`, `apps/workspace-do`, `apps/session-broker`, `apps/artifact-gateway`, `apps/widget`, `packages/chat-transport`, `packages/design-tokens`, `packages/widget-ui`, `packages/widget-i18n`, `packages/workspace-feed`, `packages/voice`                                                                         |
| Work and runners        | Accepted work reaches the right agent, and every Attempt ends with a recorded result. | Runner and Work code in `packages/cli/src` (files whose names start with `lane-` or `work-`), the Work routers in `apps/api/src/rpc/routers` (names starting with `work-`), `examples`                                                                                                                                |
| Tedi runtime            | A tedi finishes its turn reliably, within its permissions and budget.                 | `apps/tedi`, `apps/tedi-runtime`, `apps/tedi-workstation-runtime`, `apps/tedi-workstation-egress-broker`, `apps/skill-runtime`, `packages/agent-runtime`, `packages/tedi-session`, `packages/context-core`, `packages/workers-ai`, `packages/container-runtime`, `packages/provisioning`, `packages/agent-governance` |
| CLI and plugins         | A developer installs Tedix in minutes, and each command does what its help says.      | The rest of `packages/cli`, `plugins/tedix`, `packages/api-client`                                                                                                                                                                                                                                                    |
| MCP and gateway         | Agents find the tools they may use, and calls to those tools are fast and safe.       | `apps/mcp`, `packages/mcp`, `packages/mcp-client-core`, `packages/tedi-codemode-core`, `packages/webmcp-core`, `packages/ssrf-guard`                                                                                                                                                                                  |
| App marketplace         | An organization can find, install and trust an app.                                   | `apps/mcp-ui`, the catalog and listings routers in `apps/api/src/rpc/routers`                                                                                                                                                                                                                                         |
| Sign-in and permissions | The right people and agents get in, and nobody gets more access than they were given. | `packages/auth`, `packages/tenant-directory`, the sign-in code in `apps/api/src`                                                                                                                                                                                                                                      |
| Database                | Data stays correct and available, and schema changes are safe.                        | `packages/db`, `scripts/db`                                                                                                                                                                                                                                                                                           |
| API                     | Every screen and tool has a stable, documented way to read and change data.           | The rest of `apps/api`, `packages/api-contract`, `packages/worker-kit`                                                                                                                                                                                                                                                |
| Billing and usage       | Usage is measured correctly, and customers are charged what they expect.              | The billing and usage routers in `apps/api/src/rpc/routers`, `apps/api/scripts/billing`                                                                                                                                                                                                                               |
| CI and releases         | A good change reaches users quickly, and a bad one is stopped before it does.         | `.github`, `.githooks`, `.changeset`, `scripts/ci`, `scripts/release`, `scripts/oss`, `scripts/dev`                                                                                                                                                                                                                   |
| CMS, landing and docs   | Visitors and readers find accurate, current pages.                                    | `apps/cms`, `apps/cms-runtime`, `apps/landing`, `apps/docs`, `apps/docs-runtime`, `docs`                                                                                                                                                                                                                              |
| Accountancy             | The books are current and filings go out on time.                                     | No product code                                                                                                                                                                                                                                                                                                       |

A customer pilot or a programme is not an area. It is an engagement: its own
project with an end date, archived when it ends.

## Related

- [Core concepts](./concepts.md)
- [Factories, Workspaces and Projects](./factories-workspaces-projects.md)
- [Start here as an agent](./agent-start-here.md)
- [Agent guide](./agent-guide.md)
