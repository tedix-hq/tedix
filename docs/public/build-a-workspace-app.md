---
sidebar:
  order: 96
title: "Build a workspace app"
topic: "Getting started"
resource_type: guide
description: "How an agent declares, installs, configures and operates a first-party Tedix OS workspace app, with the Card review app as a worked example."
summary: "App manifest entry and config, reading and writing outputs, install from chat or MCP, traps"
read_when:
  - Installing or configuring a workspace app such as Card review
  - Reviewing factory cards from chat or MCP instead of the app screen
  - Letting a browser agent operate an open app through WebMCP
  - Adding a new built-in OS app
visibility: public
---

# Build a workspace app

A workspace app (called a gadget in code and in API names) is a versioned
record in one Workspace. Its manifest says what the app is; its revisions are
append-only. There are three kinds of app, chosen by the manifest `entry`:

| `entry`                         | What renders                                             |
| ------------------------------- | -------------------------------------------------------- |
| `tedix:app/<id>`                | A built-in OS app, rendered first-party with no iframe   |
| `ui://widgets/mcp-app/<slug>/…` | An MCP App widget, rendered in the sandboxed widget host |
| a skill slug (or `skillSlug`)   | A governed skill run from the app's **Runs** view        |

A built-in app keeps every tenant choice in the manifest `config`, never in
code. The OS validates `config` against the app's schema when a revision is
written, so a wrong setting fails the write with the exact path that is wrong.

Office (`tedix:app/office`) and Agents (`tedix:app/agents`) are built-in apps.
Both require `config: {"version": 1}`. Office shows the viewer's live activity,
reply outcomes, leaderboard and notebook. Agents accepts optional `projectId`,
`states` (`needs_you`, `error`, `done`, `working`, `idle`, `ended`) and
`harnesses` (`codex`, `claude-code`, `tedi`, `skill`). Its screen filters narrow these
settings; counts and delegation totals use the same filtered sessions.
The organization and viewer access checks remain authoritative; app filters
never grant access. Install and opt these apps into Board to make them visible.

## Install and configure an app

From chat or MCP, use the OS app tools in the organization's namespace
(discover the exact callable first):

1. `create_os_gadget` with `workspaceId`, `name` and an optional
   `description`. This creates the record only. The name is the app's
   title in the workspace, so make it say what the app is ("Card review").
2. `revise_os_gadget` with `workspaceId`, `gadgetId` and the `manifest`
   (`entry`, `config` and a one-line `description`). Pass
   `expectedRevision` (0 for a new app). Each change of settings is a new
   revision; nothing is edited in place.
3. Read it back with `get_os_gadget` and give the user the app link:
   `https://<org>.tedix.dev/workspace/<workspaceId>?workpiece=gadget:<gadgetId>`.
   Add `&pane=workpiece` to open it full screen on a phone.

In the OS, the same settings are editable under the app's **Code** view
(`manifest.json`).

For one read-only consent button covering several personal accounts, use
`entry: "tedix:app/personal-read-consent"`. Its `config` contains `version: 1`,
the scheduled skill's `skillId`, its Workspace `resourceId`, a `workerName`,
and `providers: [{id, name}]` (for example, `google-gmail` / `Gmail` and
`google-calendar` / `Calendar`). The person must click the button while signed
in as the Workspace owner. Each provider is checked against the skill's
declared, reviewed read tools; an unconnected account links to Settings →
Connections. Partial consent remains visible and can be retried. Revoke each
account's access in Resources. Installing the app grants no access.

Set `navigation: {"board": true}` in a manifest to show that active app on
**Work → Board**. Its stored name becomes the link label; it opens the same
workspace resource. Only apps in workspaces the viewer can access appear.
Omit the setting, set it false, or archive the app to remove the Board link.

`tedix:app/outbound-review` lists outbound Work drafts with status and search
filters and the existing review, feedback and human approval/send controls.
Its `config` is `{"version": 1, "limit": 50}` with optional `projectId` and
`initialStatus` (for example `waiting_on_you`). Omitting `projectId` shows the
viewer's organization-wide list. Configuration never grants permission to
send; the existing API checks and version fences still apply.

## How apps appear in a workspace

Apps are what people open a workspace for, so the OS puts them first:

- **Resources** lists apps at the top under **Apps**, one card per app,
  side by side when there are several. **Runs on a schedule** follows, then
  sheets and documents under **Files**. Nothing in a workspace is labelled
  "Automations".
- Each card shows a small preview of the app, its name, its purpose and a
  status line, with an **Open app** button. Card review previews the next
  open card; other apps show an app icon.
- A workspace link with no workpiece or pane opens the first app in the
  Editor. An app whose `entry` is one of the workspace's outputs opens that
  output's editor instead. A link that names a workpiece or pane always
  wins.

The card's purpose line comes from, in order: the manifest `description`
(at most 160 characters, versioned with the app), the app record's
`description`, then a line derived from the settings (for Card review,
"Decide on today's Inbox and Social cards" from the source labels). Write
it as what a person does in the app:

```json
{
	"entry": "tedix:app/card-review",
	"description": "Decide on today's Inbox and Social cards",
	"capabilities": [],
	"config": { "version": 1, "sources": [] }
}
```

The status line is computed by the OS from live data; the manifest does
not set it. Card review counts the open cards across its sources ("29
cards waiting"), without subtracting a viewer's snoozes. Other apps show
their kind: "Built-in app", "Interactive app" or "Runs a skill".

**Runs on a schedule** lists the scheduled skills that fill the workspace,
such as the factory that writes an app's cards. Each row shows the skill's
name and purpose, when it runs in the viewer's own clock ("Every day at
8:17, 13:17 and 18:17"), the last run ("Last run 13:17: made 4 cards" or
"Last run failed: <reason>"), the next run and a **See runs** link. A skill
is listed when the workspace has a resource with `providerId` `tedix`,
`resourceType` `skill` and the skill ID as `providerResourceId`;
`create_factory` with a Workspace adds it. Its `name` is the row title.
Optional metadata: `purpose` (one line) and `runsAt`
(`{"timeZone": "Europe/Berlin", "times": ["08:17"]}`) for a skill whose UTC
cron fires at both daylight-saving hours and skips the one that is not its
local time. Runs whose result `status` is `off_slot` are not shown; a
result's `cards` count or one-line `summary` becomes the last-run text. The
section is hidden when a workspace has no scheduled skill, and these links
are not listed under **Connected sources**.

When a scheduled skill reads its owner's own account, the row also shows,
to the workspace's owner only, **Let this read my Gmail (read-only)**. One
click picks the owner's connected Gmail account (or links to Settings →
Connections when there is none), attaches it to the workspace and lets the
skill's worker search that mailbox, read-only, until the owner clicks
**Stop** on "Reads your Gmail (read-only) · Stop". The skill says what it
needs in its own manifest: a provider tool such as `google_gmail:
[search_threads]` whose installed tool uses a personal connection and is a
reviewed tool of the account. Editing the skill keeps the grant.

Attaching your own account to a workspace is the permission. Its row under
**Attached resources** has one choice, **What this workspace's skills may do
with it**: **No access**, **Read**, or **Read + organise (archive, label,
unsubscribe; never sends or deletes)**. Only the account's owner can change
it (`osWorkspaces.schedules.setPersonalAccess`). The choice covers every
skill the workspace runs that declares tools for that account, each with
exactly its declared tools of that level; the schedule row then says "Reads
your Gmail (read-only)" or "Reads and organises your Gmail (never sends or
deletes)". For Gmail, read is `search_threads`, `get_thread`,
`get_message` and `list_labels`; organise adds `label_thread`,
`unlabel_thread` (archive and mark read), `create_label` and `create_draft`.
No level reaches a send, trash, spam or delete tool, and every delegated call
that would add the Trash or Spam label is refused. A private
workspace can be given to a member: its owner, or an organization admin for
an org workspace, updates it with `visibility: "private"` and that member's
`ownerUserId`. Afterwards only that member sees it, and a scheduled skill
linked to it can read and write its outputs only while a run is going.

## Card review

`tedix:app/card-review` shows a factory's card sheets one card at a time:
who and where, what happened and what Tedix suggests, any draft, and the
buttons **Useful**, **Not useful**, **Do it**, **Snooze** and **Skip**. Rule
ids stay behind **Details**. Swipe right or left on a phone; on a keyboard
use ←/→, D, S, K, the number keys for reason chips and Z to undo.

Write each card in plain words, at most two short lines: who, what happened
and what Tedix suggests ("Mia asked if Tuesday works. Tedix suggests a short
yes."). Rule ids may follow in the why cell, for example `(R4)`; the card
hides them.

Verdicts go into the card sheet's own cells: the useful column gets `yes` or
`no`, the reason column gets the chips and note as `Chip, Chip: note`, and
the done column gets `yes` from **Do it** (`no` from **Not useful**). A
factory that already reads those cells keeps working unchanged. Snooze is
per viewer and writes nothing.

**Do it** is named after the card's action cell, a short concrete label of
at most 40 characters such as "Draft a reply to Mia" or "Add to calendar".
A card with an empty action cell has no **Do it** button. A sheet without
the action column, or a longer action sentence, uses `doItLabel` (default
"Do it", or "Copy draft and open" for `copy_and_open`).

**Do it** never sends mail, posts, trashes or deletes. `approve` marks the
done column; the factory or the person carries the action out.
`copy_and_open` copies the draft, opens the source link and marks the done
column.

`run_skill` carries the action out at once. The button shows "Doing it: …"
while a run of `run.skillId` works on that card
(`osWorkspaces.schedules.runNow`), then the outcome: **Done ✓**, **Draft
ready**, **Filed as Work** with a link to the item, or **Failed:** and the
reason. The run writes the outcome into the result column (default
`Result`, added to a sheet that lacks it) and, when it worked, `yes` into
the useful and done columns, so the card leaves the queue. A failed card
stays with "Last try: Failed: …". The skill must be linked to the source
workspace under **Runs on a schedule**.

`run.actions` maps a card to a kind; the first entry whose `match` text is in
the card's type cell, then its action cell, wins, and anything else is
`work`:

| Kind          | What the run does                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archive`     | Removes the Inbox label from the card's threads                                                                                                                                              |
| `mark_read`   | Removes the Unread label                                                                                                                                                                     |
| `label`       | Adds the label named in the action ("Label as Receipts"), creating it if needed                                                                                                              |
| `unsubscribe` | Uses the sender's one-click unsubscribe when the mail offers it, then archives                                                                                                               |
| `reply_draft` | Saves the card's draft as a reply draft in the same thread; it is never sent                                                                                                                 |
| `bundle`      | Runs each tidy-up a housekeeping card lists ("3 tidy-ups: Unsubscribe (Weekly News); Label as Receipts (Shop)") on its own thread, mapped by these same rules; the rest become one Work item |
| `work`        | Files a Tedix Work item in `run.workProjectId` with the card's context and links                                                                                                             |

Every kind except `work` changes the owner's mailbox, so it needs **Read +
organise** on their account. Without it nothing runs and the card shows
**Allow organising first** with the owner's own button, **Let this organise
my Gmail (archive, label, unsubscribe; never sends or deletes)**. A Work
item names the source's tedi as steward, so that tedi or a local Claude or
Codex agent picks it up.

Rules-sheet rows with status `proposed` appear above the cards under
**Suggested change**, with **Yes, change it** and **No, keep as is**, which
set the status to `accepted` or `rejected`. Write the rule as one plain
sentence starting "Stop showing…" or "Also show…", then "Why: …", under 35
words in all. The rule id stays behind **Details**.

### Example config

```json
{
	"entry": "tedix:app/card-review",
	"description": "Decide on today's Inbox and Social cards",
	"capabilities": [],
	"config": {
		"version": 1,
		"sources": [
			{
				"label": "Inbox",
				"workspaceId": "11111111-1111-4111-8111-111111111111",
				"cardSheetPrefix": "Inbox cards ",
				"maxRuns": 3,
				"columns": {
					"number": "#",
					"type": "Card type",
					"source": "Thread",
					"action": "Proposed action",
					"why": "Why",
					"draft": "Draft",
					"useful": "Useful?",
					"reason": "Reason",
					"done": "Approve action?"
				},
				"doIt": "run_skill",
				"run": {
					"skillId": "inbox-actions",
					"workProjectId": "33333333-3333-4333-8333-333333333333",
					"actions": [
						{ "kind": "bundle", "match": ["housekeeping", "tidy up"] },
						{ "kind": "unsubscribe", "match": ["unsubscribe"] },
						{ "kind": "label", "match": ["label"] },
						{
							"kind": "reply_draft",
							"match": ["reply draft", "draft a reply"]
						},
						{ "kind": "archive", "match": ["archive"] },
						{ "kind": "mark_read", "match": ["mark read", "mark as read"] }
					]
				},
				"rules": {
					"sheetTitle": "Rules",
					"idColumn": "Rule id",
					"textColumn": "Rule",
					"statusColumn": "Status"
				},
				"feedbackSheetTitle": "Feedback log",
				"reasonChips": {
					"useful": ["Good catch", "Saves time"],
					"notUseful": ["Wrong person", "Not timely", "Keep this mail"]
				}
			},
			{
				"label": "Social",
				"workspaceId": "22222222-2222-4222-8222-222222222222",
				"cardSheetPrefix": "Social cards ",
				"columns": {
					"number": "#",
					"type": "Type",
					"source": "Source",
					"who": "Who",
					"why": "Why",
					"action": "Action",
					"draft": "Draft",
					"useful": "Useful?",
					"reason": "Reason",
					"done": "Did it?"
				},
				"doIt": "copy_and_open",
				"channels": [
					{ "label": "LinkedIn", "match": ["linkedin.com", "linkedin"] },
					{ "label": "X", "match": ["x.com", "twitter.com"] }
				]
			}
		]
	}
}
```

Column names match sheet headers case-insensitively, exactly or as the start
of a header, so `Thread` finds `Thread (sender · subject · Gmail link)`. One
app may read several Workspaces; the viewer must be able to open each one.

### Review cards from chat or MCP

The app holds no data of its own, so an agent reviews with the output tools:

- "Show my next card": `list_os_outputs` for the source Workspace, take the
  newest sheet whose title starts with `cardSheetPrefix`, then
  `get_os_output` and pick the first row whose useful, reason and done cells
  are all empty.
- "Mark it useful: great angle": `set_os_sheet_range` on that sheet with the
  row index as `startRow`, the useful column's index as `startColumn`, and
  `cells: [["yes", "Great angle"]]` when the reason column follows it. Pass
  the revision you read as `expectedRevision`; on a conflict, read again.
- "Carry out this card's action and show the result": read the app's
  current source config and card row first. For `run_skill`, discover the
  callable for `osWorkspaces.schedules.runNow` and pass its Workspace,
  `run.skillId`, card params described in the [factory guide](./factory-agent-guide.md),
  the mapped kind, and a fresh UUID `idempotencyKey`. Set `needs: "organise"`
  for mailbox actions. Reuse that key only to retry the same request. A
  `needs_access` result means nothing ran: point the owner to **Attached
  resources → Read + organise**. Chat cannot grant another person's account.
  Follow the run and read the result cell and provider record before
  reporting success. For `approve` or `copy_and_open`, explain that the
  decision or draft was recorded rather than claiming execution.
- "Do the housekeeping card": use the same run with `kind: "bundle"` and
  the source's `run.actions`. Check each listed tidy-up's result and the
  linked Work for anything the skill could not map. Do not turn the bundle
  into a request for the person to clean up agent Work.

Every app build must update its agent guide with these chat operations,
required access and result checks. Test the chat path alongside the app's
buttons; a WebMCP tool is available only while its app is open.

## Expose WebMCP tools

A built-in app registers its own WebMCP tools while it is open, so a browser
agent in the person's Tedix OS tab can work the app with them. The person
watches each action: the card changes, the chips light up and the count moves,
because every tool calls the same state and callbacks as the app's buttons.
The tools disappear when the person closes the app or opens another
workpiece.

Card review registers these tools:

| Tool                        | What it does                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `card_review_next_card`     | Reads the open card (source, type, who, why with its rules, action, draft, link, sheet and row), the Do it label, cards left, filter and reason chips |
| `card_review_set_verdict`   | Marks the open card `useful` or `not_useful`, with optional reason chips and text                                                                     |
| `card_review_do_it`         | Presses **Do it**; for `run_skill` it waits and returns the outcome as `result`. It never sends or deletes, and fails when the card has no action     |
| `card_review_snooze`        | Snoozes the open card until tomorrow for this viewer                                                                                                  |
| `card_review_skip`          | Moves the open card to the end of the queue                                                                                                           |
| `card_review_undo`          | Undoes the last action, like the **Undo** button                                                                                                      |
| `card_review_filter`        | Shows `all` cards or one channel (for example `linkedin` or `x`)                                                                                      |
| `card_review_pending_rules` | Lists the suggested rule changes                                                                                                                      |
| `card_review_decide_rule`   | Accepts or rejects one suggested rule change                                                                                                          |

The verdict, **Do it** and skip/snooze tools take the `cardKey` that
`card_review_next_card` returned and fail if a different card is open, so an
agent never writes onto a card the person has just moved past.

To give a new app tools:

1. Put the tool set in `apps/os/src/components/<app>-webmcp-tools.ts` as a
   pure builder that takes a `current()` getter for the app's live state and
   callbacks. Name every tool `<app_id>_<verb>…` in snake_case, give it a
   plain description and an input schema, and set `readOnlyHint` on reads
   and `untrustedContentHint` on reads that return tenant content.
2. In the app component, pass that state and the same callbacks the buttons
   use to `useAppWebMcpTools("<app-id>", controller, build, deps)`
   (`apps/os/src/lib/webmcp/use-app-webmcp-tools.ts`). `deps` lists only
   what changes the tool shape, such as a filter enum.
3. Return each callback's outcome so a tool can report a failed write as an
   error; `execute` never throws.
4. Test it by rendering the app with a mocked `osApi`, executing each tool
   and checking the screen and the written cells.

`window.__tedixWebMcp.status()` in the page lists the registered tools and
whether the browser offers a WebMCP host.

## Add another built-in app

Put the settings schema in `packages/api-contract/src/schemas/` and check it
in `OsGadgetManifestWriteSchema`, put the engine in `apps/os/src/lib/` with
unit tests, register its entry in `workspace-app-renderer.tsx`, and build the
screen from `@/components/kumo/*`. Read and write through the existing OS
queries and the generated `osQuery` keys. Expose its actions as WebMCP tools
as described above.

## Traps

- Tenant choices belong in `config`. Hardcoding a workspace, sheet id or
  column in code breaks the next tenant.
- Reads stay lenient: only writes check `config`, so an old revision never
  becomes unreadable after the schema changes.
- A range write must fit the sheet's current columns. Write one rectangle
  and copy the current values of any column between the ones you change.
- Write verdicts with `expectedRevision` and retry once on a conflict; a
  factory may add a sheet or row at the same time.
- In chat, a bare follow-up such as "mark it useful: great angle" right
  after Home showed a card writes that card's row directly, without a
  delegation: Home takes the card named at the top of its previous answer
  and the sheet that answer cites by output id or `Sheet:` title line. When
  the answer names neither, name the sheet in the request.
- Never claim an action happened because the done column says `yes`. It
  records a decision; the provider's own record is the proof.
