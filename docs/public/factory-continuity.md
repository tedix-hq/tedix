---
title: "Keep factories moving"
description: "How Tedix detects stalled projects, requests a safe resume and measures delivery promises."
summary: "Project continuity policy, recovery evidence and coordinator morning briefs"
read_when:
  - Configuring a factory's idle threshold or delivery cadence
  - Explaining Stalled in Attention
visibility: public
---

# Keep factories moving

An unattended factory is a system problem. Tedix first asks its owning tedi to
resume useful work. A person is asked only for a specific decision, consent or
fact the worker cannot supply.

The existing commitment wake job checks active projects and objectives every
two minutes. It reads registered lanes, Work heartbeats, linked skill and
factory runs, and objective task activity. Paused, archived and finished
projects are excluded. Objectives already represented by an active project are
handled through that project, rather than receiving a second wake.

## Set a continuity policy

Factories use their canonical Work project for continuity. Link a Workspace's
factory to that project so its runs count as activity. Use the existing project
update operation to set `metadata.continuity`, preserving other metadata:

```json
{
	"continuity": {
		"idleHours": 24,
		"cadence": {
			"everyHours": 24,
			"minResults": 1,
			"description": "At least one delivered result each day"
		}
	}
}
```

The idle threshold defaults to 24 hours; allowed values are 15 minutes through
30 days. An unlinked objective can use the same policy under
`gateConfig.continuity`. A project uses its own policy.

The project lead, or its linked objective's tedi, owns recovery. Optional
`coordinatorTediId` names an active tedi in the same organization to take over
when the owner is missing or inactive. Without either, Tedix records `no owner`
in its learning ledger; it does not fabricate an owner or send a housekeeping
request to a human.

Cadence periods begin at project or objective creation and use elapsed hours
in UTC. The latest complete period is kept when at least `minResults` canonical
Work items reached `completed` during it. Model replies, successful skill runs
and heartbeat traffic alone do not count as delivered results. A missed promise
requests recovery even when activity is fresh. New activity during that same
missed period does not cause another resume request.

## Recovery and Attention

The resume turn reads pending Work, chooses the next useful item, and starts
it or dispatches a lane through the existing admission path. It must check
leases and existing requests first. A wake grants no additional approval,
budget or Work Attempt. With no open items, the tedi is instructed to propose
three next goals and continue an already authorized one.

Only an accepted recovery appears in **Stalled**. The copy says that a tedi
resume was requested, with its timestamp and observed cause. Acceptance is not
proof that execution started. If an open decision is addressed to the current
viewer, the panel instead names that decision and links to its request.
Another person's question is never shown as yours. Raw gaps and missed
promises awaiting a recovery acceptance do not become human to-dos.

Retries reuse one incident key and the runtime's durable wake deduplication.
If a scope remains idle, a fresh bounded recovery is requested after another
whole idle threshold; acceptance cannot suppress recovery forever. Cadence
misses receive at most one resume request per completed cadence period.
The coordinator must reuse an existing open request for the same scope and
blocker, creating one Needs-you ask only when the human is needed. The ask must
state the blocker, exact decision, options and evidence link.

Every incident records its observed one-line cause in the existing learning
ledger. A cause recurring in three distinct incidents produces one proposed
automation fix with those incidents as evidence. Proposals still require the
normal review; they do not change policy automatically. The resume turn is
instructed to record its verified cause and action receipt as follow-up evidence.

## Coordinator morning brief

Discover `get_project_continuity` through the CLI's tool catalog before using
it. This read-only operation returns `stalls`, `promises` and a `next` cursor.
Pass `next` as `after` until it is null. Each promise includes its name, period,
kept/missed status, delivered/required counts and project link. It performs no
wake or external action.

An installed coordinator's morning brief should include a short **Promises
kept/missed** line and name the affected factories with counts and links. Read
the canonical report, then verify any claimed recovery through Work and run
receipts. Do not infer completion from wake acceptance or from local log files.
Updating an installed coordinator skill and proving its next scheduled brief
are separate live operations; publishing source does not update that skill.
