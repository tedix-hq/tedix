---
sidebar:
  order: 94
title: "Build, operate and tune a factory"
topic: "Getting started"
resource_type: guide
description: "The complete agent loop for turning a recurring goal into a factory, proving its first run, checking it daily and tuning it safely."
summary: "Goal, dry run, creation, proof, daily health, tuning, and the factory traps that still matter"
read_when:
  - Building a factory for the first time
  - Proving that a new factory can run and deliver
  - Checking or tuning an existing factory
visibility: public
---

# Build, operate and tune a factory

Use this page to take one recurring goal from an idea to a factory you can
check every day. Start by choosing the result, owner, cadence, Workspace and
Output. Then follow one loop: **goal -> dry run -> create -> proof run -> daily
health -> tune**.

A factory is a recurring lane owned by a tedi. It includes a Work project and
objective, a skill, a schedule, a Workspace and a durable result. These are
separate facts: a factory can be configured but not active, active but not yet
run, or completed without delivering a useful result.

Agents with the Tedix plugin can load `tedix-factory` for the same playbook.
Connect to the requested organization first, discover each callable and use the
namespace and inputs it returns. Reading a resource does not authorize changing
or running it.

## 1. Make the goal concrete

Write the result in one or two sentences. Choose:

- a short name and stable slug;
- the source Work project, or whether Tedix should create one;
- the owner tedi by ID or unambiguous slug;
- `daily`, `twice_daily` or `hourly` cadence;
- the Workspace UUID; and
- the document or sheet Output that keeps each result.

The current `report` template reads project Work and recent comments. It asks
the owner tedi for one report, proposes deduplicated Work, writes the summary to
the selected Output and posts a scorecard. If the goal mentions email, a
website or another outside source, bind a suitable tool or automation. Goal
text alone does not grant access.

## 2. Preview without writing

Discover `create_factory` and call it with `dryRun: true` and every chosen
input. This fictional factory summarises project comments into a daily document:

```json
{
	"goal": "Summarise new project comments into the daily review document",
	"slug": "sample-comment-review",
	"ownerTedi": "<verified owner tedi id or slug>",
	"projectKey": "<existing project key, when reusing one>",
	"workspaceId": "<Workspace UUID>",
	"cadence": "daily",
	"output": "Daily review",
	"outputKind": "document",
	"dryRun": true
}
```

CLI:

```bash
tedix -w <profile> factory create \
  --goal 'Summarise new project comments into the daily review document' \
  --slug sample-comment-review \
  --owner '<verified owner tedi id or slug>' \
  --project '<existing project key>' \
  --workspace-id '<Workspace UUID>' \
  --cadence daily \
  --output 'Daily review' \
  --output-kind document \
  --dry-run
```

Review the exact owner, project, Workspace, Output, UTC cron, steps, warnings,
skill lifecycle and next fire time. Stop if the preview names the wrong owner
or destination, finds an unexpected existing factory, or reports a warning
that changes the requested result.

## 3. Create exactly what you reviewed

After approval, repeat the same call with `dryRun: false`, or remove
`--dry-run` from the CLI command. Do not rebuild the inputs from memory. Keep
the returned factory slug, skill ID, owner-tedi ID, project, health Work Item,
Workspace and schedule state.

A successful call can still create a draft with no schedule. Check the skill's
lifecycle, the schedule action, warnings and `nextFireAt`. Creation and
activation are separate.

## 4. Run the first probe and proof

Run a probe against the returned **skill ID** first. A probe checks the source,
project and Workspace bindings without asking the owner tedi for a report or
writing a result.

```bash
tedix -w <profile> skill run '<returned skill ID>' \
  --as '<owner tedi slug>' \
  --params '{"probe":true}'
tedix -w <profile> skill status '<returned run ID>'
```

Then prove real delivery with a new cycle key:

```bash
cycle="manual-$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tedix -w <profile> skill run '<returned skill ID>' \
  --as '<owner tedi slug>' \
  --params "{\"cycleKey\":\"$cycle\"}"
tedix -w <profile> skill status '<returned run ID>'
tedix -w <profile> factory status sample-comment-review
```

For MCP, discover the current skill runner. Pass the returned `skillId`, the
returned `ownerTediId` when its input asks for `tediId`, and `params` containing
`probe: true` or a unique `cycleKey`.

A probe proves wiring, not delivery. A queued run, completed run or scorecard
alone also does not prove delivery. For a real proof, read the terminal run and
the exact new Output revision, Work Item or non-scorecard comment. Check an
outside publication separately.

## 5. Read health every day

```bash
tedix -w <profile> factory status
tedix -w <profile> factory status sample-comment-review --limit 7
tedix -w <profile> skill status '<run ID>'
```

In MCP, use `inspect_factory_health` with the exact factory slug. Its verdict
tells you the next useful check:

| Verdict      | What to do                                                |
| ------------ | --------------------------------------------------------- |
| `healthy`    | Confirm the recent delivery still matches the goal.       |
| `idle`       | Inspect the run; it completed without a durable delivery. |
| `failing`    | Read the exact run and error before retrying.             |
| `not_firing` | Check lifecycle, enabled schedule and next fire time.     |
| `paused`     | Resume only when the owner wants future runs restored.    |
| `pending`    | Wait for the first due run, or start one approved proof.  |

Post or preserve the daily summary in the named destination. Do not describe an
empty successful run as useful delivery.

## 6. Tune from evidence

Compare the goal with recent run and delivery receipts. Narrow noisy sources,
reduce unnecessary proposals, adjust cadence or change the Output only when
those receipts support the change.

```bash
tedix -w <profile> factory pause sample-comment-review
tedix -w <profile> factory resume sample-comment-review
tedix -w <profile> factory archive sample-comment-review
```

Pause keeps the current cadence and does not cancel a run already in progress.
Resume restores the old schedule and does not run immediately. Archive removes
the schedule and retires the lane while preserving its Work and Outputs.

Factory settings render once. Repeating the same slug is idempotent; it does
not update the goal, owner prompt, cadence or Output. To change those settings,
archive and recreate through the same dry-run and proof loop. Reuse the project
and selected Outputs when they still fit, and run the replacement's newly
returned skill ID.

## Traps and their current status

| Trap                  | Current fix status                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled-skill gates | Enforced. The owner and active skill must remain eligible for the schedule to fire. Creation can intentionally return a draft.         |
| Lane pattern          | Fixed in `create_factory`. The report lane uses one owner turn, polls pending work, deduplicates writes and posts one scorecard.       |
| Cron TTL              | Mitigated. In-chat tedi cron jobs expire; factory skill schedules do not. Use `create_factory` for persistent recurring work.          |
| 180-second call cap   | Mitigated, still sharp. One tool bridge call can stop at 180 seconds. The generated lane accepts a pending owner turn and polls later. |
| Egress                | Enforced. Report lanes have no ambient network. Use declared tools. GitHub or workstation work also needs an admitted Work Item.       |
| Owner tedi            | Fixed. Owners resolve by ID, slug or unambiguous name and remain checked at dispatch. Verify the returned owner before proving a run.  |
| Slug reuse            | Partly fixed, still sharp. A reused factory slug does not update settings. Archive and recreate, then use the newly returned skill ID. |

The daily agent-experience sweep should update this list when it finds a
repeatable factory-building problem. Record the symptom, affected surface and
whether the fix is shipped, covered by this playbook or still open.

For deeper inspection, custom factory patterns and Workspace resource details,
continue with [Build and inspect a factory as an agent](./factory-agent-guide.md).
