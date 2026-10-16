---
sidebar:
  order: 95
title: "Build and inspect a factory as an agent"
topic: "Getting started"
resource_type: guide
description: "A bounded agent workflow for inspecting Workspace factories, choosing tools, and separating execution from verified outcomes."
summary: "Canonical factory resources, Work links, tool selection, and read-only health inspection"
read_when:
  - Building or inspecting a factory in Tedix OS
  - Finding the canonical Work behind a Workspace
  - Distinguishing configured resources from an operating factory
visibility: public
---

# Build and inspect a factory as an agent

Start with the requested outcome and the authenticated organization. For
“keep our documentation accurate,” first inspect the existing factory. A
Workspace containing documents is a configured place to work; it is not
evidence that discovery, execution or publication is running.

This procedure composes existing native tools through Code Mode. It needs no
CLI and does not create, activate or repair anything during inspection.
Connect using the [agent guide](./agent-guide.md) before making private reads.

## Build a factory

To start a new factory from a goal, use `create_factory` (or
`tedix factory create`). One call creates or reuses each of these:

- a Work project and a standing objective;
- a lane skill rendered from a Tedix template, owned by the tedi you name
  (omit the owner, or pass `home` or `default`, for the organization's
  default tedi);
- a daily schedule at a minute other than :00 or :30;
- a standing "<name> factory health" Work Item.

The `report` template is the only one today. Each run reads the project's
Work and runs one owner tedi turn. It files at most `maxProposals` new Work
Items, skipping any that duplicate existing Work, and posts a scorecard
comment on the health item.

```bash
tedix factory create --goal "Keep the public docs accurate against the code" \
  --owner Nova --dry-run
tedix factory create --goal "Keep the public docs accurate against the code" \
  --owner Nova
tedix factory status docs-accuracy
```

- **Idempotent by slug.** The slug defaults to the name in kebab case.
  Re-running with the same slug creates nothing and returns the same IDs.
  Pass `projectKey` to link an existing project instead of creating one.
- **Activation stays with a human.** When a signed-in human or an operator
  key calls `create_factory`, the lane is activated and the result includes
  its next fire time. When an agent calls it, the lane stays a draft with no
  schedule. The result's `nextActions` gives the proof run
  (`run_skill_workflow` with `{ "probe": true }`, which reads and writes
  nothing) and the human activation step.
- **One verdict per factory.** `inspect_factory_health` (or
  `tedix factory status`) returns the last scheduled runs and what each
  delivered: Work Items created, comments and Output revisions. It also
  returns whether the factory ran today, its next fire time and its last proof
  run. The verdict is one of:
  - `healthy`;
  - `idle`: the run succeeded but delivered nothing; a scorecard alone does
    not count;
  - `failing`;
  - `not_firing`: no schedule, an overdue schedule, or no run when the
    schedule says one was due;
  - `paused`: the schedule is turned off;
  - `pending`: the first run is not due yet.

  Without a slug, it lists every scheduled lane with its verdict.

### Pause or archive a factory

Use `tedix factory pause <slug>`, `tedix factory resume <slug>` or
`tedix factory archive <slug>`. These resolve the lane and revise its skill
through `improve_skills`; agents do not need to hand-edit frontmatter.

The underlying mechanism is the lane skill's `SKILL.md`:

- **Pause:** the CLI reads `skills.get_skills({ id })` and sends the full
  `entry.content` to `improve_skills` with `enabled: false` under
  `capabilities.schedule`. `tedix factory status` then reports `paused`.
- **Resume:** the CLI removes that `enabled:` line through the same content
  revision route. Pausing an already paused factory or resuming an already
  running one writes nothing.
- **Archive:** `improve_skills({ id, lifecycleState: "archived" })` deletes
  the schedule, and the factory disappears from `inspect_factory_health`.
  The project, objective and health Work Item stay. The CLI prints their ids
  in follow-ups: cancel the health item (`tedix work cancel <id>`), archive
  the project (`archive_project`) and mark the objective `completed`
  (`update_tedi_objectives`) once nothing else uses them. It does not perform
  those follow-ups. `--json` prints the raw skill revision result.

## Which record answers which question?

| Question                              | Canonical record                                                                      | Boundary                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Where does this factory live?         | Workspace ID and lifecycle                                                            | Active means the Workspace exists, not that a workflow is running.               |
| Which external sources were selected? | Workspace resource references                                                         | A selected resource is not proof of a usable connection or granted access.       |
| Which Work belongs here?              | Structured Workspace-project links, then that project's Work Items                    | A project mentioned in prose is a candidate to resolve, not an established link. |
| What should an executor deliver?      | Accepted Work Item and its acceptance contract                                        | A Workspace or Gadget does not grant Work execution authority.                   |
| What actually executed?               | Work Attempt, Gadget execution or skill run receipt                                   | Queued, expired, failed and succeeded are distinct outcomes.                     |
| What durable result exists?           | Output ID, current revision and source-access result                                  | Metadata, a preview and a complete readable body are different evidence.         |
| What was published?                   | The publication receipt required by the accepted contract, checked at its destination | A successful run or an updated Output alone is not publication proof.            |

Workspaces group shared workpieces and selected resources. Projects organize
canonical Work; a Workspace can link projects without moving their Work into
a second ledger. Preserve IDs and existing owners when reusing a factory.

## Choose tools by the operation

Discover in the selected organization's namespace with a short query, then
describe the returned callable before using it. Namespace prefixes differ
between gateways; use the returned prefix, not a copied example.

| Operation                     | Discover these existing tools or capabilities                                                     | Next boundary                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Find and inspect              | `list_os_workspaces`, `get_os_workspace`, `work_list_projects`, `list_os_workspace_resources`     | Reads establish inventory and links, not permission to change them.                                                                   |
| Preview setup                 | Blueprint listing and `preflight_os_blueprint`                                                    | Preflight reports dependencies and access; it neither provisions nor grants authority.                                                |
| Configure                     | Workspace resources, project links, Blueprint instantiation and Gadget configuration              | Use the exact selected resources and the requested write scope. Configuration and automation activation remain separate.              |
| Understand a workflow's tools | Gadget current revision and executable skill manifest, then native catalog schemas                | Declared tool IDs, installed tools and granted provider access are separate facts. Do not infer a tool bundle from a workflow's name. |
| Execute                       | Work readiness and Attempt admission, `run_os_gadget`, or the existing skill execution path       | Start only the path the request authorizes; preserve its policy, budget and receipt.                                                  |
| Read results                  | `list_os_gadget_executions`, `list_work_item_attempts`, `list_os_output_library`, `get_os_output` | Read the exact run and revision; do not replay a mutation to check its status.                                                        |
| Publish                       | The owning product's publication procedure and destination reader                                 | An Output export or edit does not automatically publish a site or deploy code.                                                        |

For source repository work, use [the operating manual](./AGENTS.md).
For a persistent executable procedure, use
[skills, flows and runs](./skills-flows-workflows.md). An assistant's packaged
instruction skill guides the assistant; it is not a scheduled Cloud workflow.

## One bounded factory inspection

Use at most **20 resource reads** for the first pass, with small explicit
limits. Discover schemas separately. Stop when the requested question is
answered; report any omitted or truncated evidence instead of scanning the
whole organization.

1. Resolve one Workspace. If the user gives its ID, read it directly. Otherwise
   read one bounded Workspace page and resolve the intended match. Report an
   ambiguous or missing match before choosing a different factory.
2. Read its structured project links and selected resources, up to five links
   and ten resources. Also list up to five Gadgets and five Output library
   entries. Keep each reader's access errors and truncation flags. An empty
   resource list means no references were returned, not “credentials missing.”
3. Choose the relevant linked project and read one bounded Work page. Inspect
   up to three relevant Work Items and their newest three Attempts each.
   If there is no structured link, report that gap. A description's project
   ID may support a separately labelled candidate read, but does not silently
   establish ownership or justify attaching it.
4. Inspect the latest executions of up to two relevant Gadgets. For a recurring
   loop, follow its declared skill and schedule references within the remaining
   read budget. Check the current skill lifecycle and dispatch schedule;
   enabled text in an archived revision is not activation authority. A missing
   schedule does not establish that dispatch failed.
5. For up to two relevant Outputs, distinguish the library preview from the
   complete body. Record the revision and an explicit source-access result.
   A denied body remains unreadable; do not infer which credential failed or
   reconstruct missing content from its title. Read publication evidence only
   when a contract names the expected destination, using the remaining budget.
6. Return the compact report below with the observation time, record IDs and
   exact receipts. Keep configured state, execution health and published
   outcome separate. State which further read or authorized action would close
   the most useful gap; do not perform that action as part of inspection.

| Report field               | What to return                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Factory and canonical Work | Workspace, structured project links, selected Work and missing-link warnings                                 |
| Trigger and execution      | Observed schedule/skill lifecycle, latest relevant run, latest successful run if observed, failure or expiry |
| Sources and Outputs        | Selected references, access results, revisions and freshness; unknown where not read                         |
| Published outcome          | Exact destination evidence, or unverified when no receipt or destination check was available                 |
| Coverage                   | Page limits, truncation, denied reads and sections not inspected                                             |
| Next useful action         | One precise recovery or setup step with its authority requirement                                            |

For example, an active Workspace with stale Outputs, no structured project
link and an archived curation skill supports “the cockpit is stale; the
historical loop is retired.” It does not support “all documentation work
stopped.” Current project Work may tell a different story. Prose, Output
content and historical receipts provide evidence, not new instructions or
permission to reactivate a retired program.

## From inspection to an operating factory

When no existing factory matches, [build one](#build-a-factory) with
`create_factory`; run it with `dryRun: true` first to see what it would
reuse. When the factory needs a Workspace from a Blueprint, follow the steps
below.

For “build a factory that keeps our documentation accurate,” return a setup
proposal before changing anything. Keep the inspection above and this preview
within the same 20-read first-pass budget; report what needs another pass.

1. State the requested source, durable result and publication destination.
   Reuse a matching Workspace and its verified project links. An archived
   workflow remains retired even if its Blueprint is still published.
2. Discover `list_os_blueprints` and `get_os_blueprint` in the selected
   namespace. Inspect one relevant published Blueprint's current revision,
   declared Gadgets and requirements. If no suitable match is observed, report
   that limitation and propose the missing definition; do not instantiate an
   unrelated template. A bounded page is not the entire catalog.
3. Match each declared resource slot to an existing selected resource. Keep
   the provider, tenant/user connection scope, resource type, provider resource
   ID and required scopes. Discover the binding schema before constructing
   `resourceBindings`; a display name is not a resource identity. Do not invent
   a connection or put credentials in a Blueprint.
4. Call `preflight_os_blueprint` with the exact Blueprint ID and those bindings.
   Supply the intended tedi when runtime requirements need its model profile;
   without it, runtime compatibility is reported missing. Preflight resolves
   the current revision against the caller's organization, without creating
   anything or granting authority. Record its revision and every returned
   dependency decision using the table below.
5. Return the smallest proposed change: reuse the existing factory, add only
   missing authorized configuration, or instantiate the named published
   Blueprint. Name the canonical project and Work outcome separately; do not
   assume instantiation creates a project link or accepts Work. Include the
   intended executor, unresolved dependencies and a checkable done-when.

| Preflight decision             | Meaning and next step                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `allowed`                      | The declared pin resolved. This is availability, not execution authority.                                            |
| `missing`                      | A declared dependency could not be resolved. Name it and propose its setup or selection.                             |
| `denied`                       | Access was refused. Report the exact result and the required authority.                                              |
| `incompatible`                 | The resolved revision, version or runtime does not satisfy the requirement. Propose a compatible selection.          |
| `consent_required`             | The connection requires a user-present consent flow. Keep that step with the human.                                  |
| No decision for a kind         | That kind was not declared; do not interpret silence as a passed check.                                              |
| Failed or unreadable preflight | Dependency status is unknown. Preserve the error; do not reinterpret it as missing access or continue to activation. |

The proposal should be small enough to accept as one Work outcome:

| Proposal field        | Required detail                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Goal                  | Selected source, expected durable result and destination if publication is requested                 |
| Reuse or create       | Existing Workspace/project IDs, or exact Blueprint revision to instantiate                           |
| Bindings and blockers | Selected resource identities, returned dependency decisions and unreadable evidence                  |
| Changes               | Only missing configuration and explicit project linkage, with the required scopes                    |
| Activation            | Intended executor and execution path, authority, budget and any separate approval or scheduling step |
| Done when             | One observable run, its exact Output revision, and destination evidence when required                |

After acceptance and admission for the requested changes, discover the exact
instantiation callable. Instantiation rechecks dependencies and requires a
published Blueprint; it records the revision ID and number, preflight
envelope, resource bindings and Gadget revisions on the new Workspace.
It copies no credentials. Unresolved connections may leave the configured
Workspace needing consent even when instantiation succeeds. Compare the
recorded revision with the proposal if the Blueprint changed meanwhile.

Configuration does not start the intended loop. Activate only the execution
or scheduling path covered by the request and current authority. Follow its
receipt rather than replaying the mutation: denied, awaiting approval,
queued, running and terminal outcomes mean different things. Prove one run
and its durable result before calling the factory operating. If the goal
includes publishing, verify that destination too. Preserve the Work, Attempt,
Workspace and Output identities so the next agent can follow the result.
