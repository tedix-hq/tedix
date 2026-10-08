---
sidebar:
  order: 60
title: "Skills, automations, flows, and runs"
topic: "Platform"
resource_type: guide
description: "Choose the right Tedix execution surface, run a one-off flow, and inspect durable evidence."
summary: "Public guide to reusable skills, scheduled automations, one-off flows, and durable runs"
read_when:
  - Choosing between a skill, an automation, a flow, or a run
  - Moving multi-step MCP work out of an agent context window
  - Inspecting durable execution and engine health
visibility: public
---

# Skills, automations, flows, and runs

Tedix runs reusable skills, scheduled automations, and one-off flows on one
durable execution engine. The words describe different user intent; they are
not competing systems. Internally the engine is still called the skill-workflow
engine, and the read-only `tedix workflow` command keeps that name.

## Choose the surface

| Concept    | Meaning                                                                                                                                                      | Use it when                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Skill      | A persistent, revisioned procedure. It may contain guidance only or include an executable workflow script.                                                   | The organization should reuse, review, schedule, or improve the capability.                                             |
| Flow       | A one-off author-and-run convenience. A file-authored flow creates an ephemeral draft executable skill and runs it through the same engine.                  | You need several MCP or platform steps once, without replaying their intermediate data through an agent context window. |
| Run        | One durable execution of a pinned executable-skill revision, with status, steps, approvals, artifacts, costs, and terminal evidence.                         | You need to inspect what actually happened.                                                                             |
| Automation | A skill that runs on a schedule ("every morning at 08:00, do this"). Automations are ordinary skills with a schedule attached; there is no separate builder. | Work should happen without anyone starting it.                                                                          |
| Engine     | The durable execution engine and its definitions. Tedix owns static platform definitions; organizations own dynamic executable-skill definitions.            | You are observing engine definitions, health, or history through `tedix workflow`.                                      |

There is no separate workflow-builder object. Author a reusable executable
skill, schedule it as an automation, use a flow for one-off work, or change a
static platform definition in Tedix source.

### Reconnect a selected account during a run

A missing credential for an explicitly selected account can hold a run. Each
reconnect wait lasts up to 24 hours, with at most three checks per operation.
Run detail offers **Open connections** and **Check connection
and continue**. The server verifies the same account and required scopes before
waking the pending operation; it never substitutes another account. Earlier
completed steps remain complete. A wait is shown as running with a waiting gate,
not as a native engine pause.

Recovery is limited to a step whose first and only MCP operation failed before
execution, with no direct network calls already started. Put independent
provider operations in separate `step.do` callbacks. Approval requirements,
policy denials, lookup outages, unselected default accounts, and steps with
already-started effects do not become reconnect waits. A connection change or
revocation still takes effect at the next credential lookup. Recovery does not
grant background access to personal accounts.

## Run a one-off flow

Create `plan.ts`. The leading `/* tedix */` block is the skill manifest and
declares the exact MCP methods the workflow may call:

```ts
/* tedix
name: audit-tool-annotations
description: Count tools available to this organization.
capabilities:
  mcp:
    app_config: [list_app_tools]
*/
export default {
	async run(event, step, env) {
		const tools = await step.do("list", { timeout: "60 seconds" }, () =>
			env.MCP.app_config.list_app_tools({ limit: 200 }),
		);
		return { count: tools.length };
	},
};
```

The header is only for one-off `flow run` files; a recorded skill declares
its manifest in SKILL.md frontmatter and needs no header. Never write a
`*/` inside the header (a cron such as `*/5` ends the comment early); use
`0-59/5` or a comma list, or move the schedule to SKILL.md frontmatter.

Discover the exact callable and parameter schema before declaring a
capability; do not guess tool names. Then run and watch it:

```bash
tedix -w acme code \
  'async () => await discover.search({ query: "list app tools", limit: 2, includeParameters: true })'
tedix -w acme flow run --file plan.ts --watch
```

The command returns a `skillId` and `runId`. File-authored flows are draft
skills tagged `flow-ephemeral`; they never run on a schedule and auto-archive
after 14 unused days. Put large output in an artifact and return its reference:
only the bounded return value should enter the caller's context.

Use the returned run identifier for readback:

```bash
tedix -w acme flow status RUN_ID --watch
tedix -w acme flow inspect RUN_ID
tedix -w acme flow list
```

Status shows a short summary of where the run is. Inspect is the detailed evidence
view for failures, steps, calls, retries, approvals, and artifacts.

## Reuse an executable skill

An existing executable skill is persistent and revisioned. Running it does not
create or change a draft:

```bash
tedix -w acme skill list
tedix -w acme skill show SKILL_UUID
tedix -w acme skill run SKILL_UUID --watch
tedix -w acme skill runs
```

`tedix flow run --skill SKILL_UUID --watch` reaches the same execution path;
`tedix skill run` is the clearer spelling when reuse is the intent. Promotion,
activation, and scheduling remain governed skill lifecycle decisions, not
automatic consequences of a successful flow.

## Observe the engine

The `tedix workflow` command is deliberately read-only. Its name is the
internal engine name, not a separate product component:

```bash
tedix -w acme workflow list
tedix -w acme workflow health
tedix -w acme workflow runs
tedix -w acme workflow status WORKFLOW_ID
```

Definitions include static Tedix platform workflows and dynamic executable
skills available to the organization. A definition with no run history is
unobserved, not failed. For a dynamic skill run, use `skill status` or `skill
inspect` for the run's current status and detailed evidence.

## CLI, MCP gateway, and Tedix OS

All three surfaces use the same organization gateway, authorization, and
records:

| Surface                 | Best use                                                                                          | Important boundary                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| CLI                     | Human- and script-friendly authoring, watching, compact output, and exit codes                    | Thin commands call canonical gateway tools; they do not create a second capability model.                                  |
| MCP gateway / Code Mode | Agent-native discovery, exact schemas, direct composition, and typed calls                        | Use `discover.search()` and the returned namespaced callable; broad discovery and large returns waste context.             |
| Tedix OS                | Visual skill authoring, workspace references, approvals, run inspection, artifacts, and promotion | Gadgets and Blueprints are views and composition aids; Tedix remains authoritative for skills, runs, policy, and evidence. |

The canonical MCP families are `flow.*` for one-off convenience,
`skills.*` for persistent skill lifecycle and dynamic-run inspection, and
`workflows.*` for read-only engine observability. Identity-specific tedi
callables are equivalent execution owners, not a second workflow system.

Continue with [Getting started](./getting-started.md), [Install the Tedix CLI](./cli.md), or [Core concepts](./concepts.md).
