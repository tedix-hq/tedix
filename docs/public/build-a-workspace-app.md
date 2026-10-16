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

## How apps appear in a workspace

Apps are what people open a workspace for, so the OS puts them first:

- **Resources** lists apps at the top under **Apps**, one card per app,
  side by side when there are several. Sheets and documents follow under
  **Files**. Nothing in a workspace is labelled "Automations"; scheduled
  skill runs are managed on the skill, not in the workspace.
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

**Do it** never sends, posts or changes a mailbox. `approve` marks the done
column; the factory or the person carries the action out. `copy_and_open`
copies the draft, opens the source link and marks the done column.

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
				"doIt": "approve",
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
| `card_review_do_it`         | Presses **Do it**; it never sends or posts, and fails when the card has no action                                                                     |
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
unit tests, render it from `canvas-doc-panel.tsx` for its entry, and build the
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
