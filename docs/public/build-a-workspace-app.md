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

| `entry`                         | What renders                                                    |
| ------------------------------- | --------------------------------------------------------------- |
| `tedix:app/<id>`                | A built-in OS app, rendered first-party with no iframe          |
| `tedix:runtime/v1`              | An app with its own code: `client.js` in the sandbox, see below |
| `ui://widgets/mcp-app/<slug>/…` | An MCP App widget, rendered in the sandboxed widget host        |
| a skill slug (or `skillSlug`)   | A governed skill run from the app's **Runs** view               |

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
never grant access. Install and opt these apps into the Activity’s Apps list to make them visible.

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
(`manifest.json`). The Code view also lists `README.md`, generated from the
current manifest: what the app shows, how people use it, its connections,
where its code lives (built in, a widget view, or a skill) and the manifest
`notes`. Runtime apps may instead carry their own `README.md` in the revision's
files. Write `description` and `notes` so that the generated README reads well.

The app's **Connections** tab starts with **Used by this app**: one row per
`resourceGrants` slot, with the attached resource's name, "Referenced in code
as `<slot>`", the allowed operations and whether its account is connected.
**Connect** opens the workspace's connected apps. A slot is filled when the
app is installed from its blueprint.

To reuse a workspace, choose **Workspace actions → Save as blueprint** and
name the draft. Agents use `save_workspace_as_blueprint` with `workspaceId`
and `name` (API: `osWorkspaces.blueprints.saveWorkspace`). This captures active
apps at their committed revisions, including runtime source files, manifests,
resource-slot shapes and the workspace's pinned blueprint requirements. It
excludes app storage, documents and chats. Publish the draft in **Blueprints**
when it is ready; each installation creates fresh apps with independent storage
and asks for new resource selections. Uncommitted drafts are not captured.

Each read an app makes through a connection slot adds a **Connection read**
receipt to the app's **Runs** tab: the resource, the account (organization or
the reader's own), the reader, what the access check found, and **Contains
restricted data** when the result may include something the reader could not
open in the provider themselves. Receipts never store the data read.

Organization accounts have a **Check each person's access** setting under
Settings → Connections. It is on by default for document stores (Notion, and
apps catalogued as productivity or storage) and off for service accounts such
as billing or analytics; an org admin can turn it on or off per account.
When it is on, Tedix checks the reader's own linked account for that provider
before the read. A reader with no linked account is asked to link one.
Notion is checked against the exact page. Until 2 November 2026 the check is audit-only: reads
are served and the receipt records "would be refused". After that a failed
check refuses the read.

The app's **Share** dialog shows **People with access** (the workspace owner
and, for an organization workspace, everyone in the organization) above its
share links. Admins get a link to invite people to the organization.

For one read-only consent button covering several personal accounts, use
`entry: "tedix:app/personal-read-consent"`. Its `config` contains `version: 1`,
the scheduled skill's `skillId`, its Workspace `resourceId`, a `workerName`,
and `providers: [{id, name}]` (for example, `google-gmail` / `Gmail` and
`google-calendar` / `Calendar`). The person must click the button while signed
in as the Workspace owner. Each provider is checked against the skill's
declared, reviewed read tools; an unconnected account links to Settings →
Connections. Partial consent remains visible and can be retried. Revoke each
account's access in Resources. Installing the app grants no access.

Set `navigation: {"board": true}` in a manifest to show that active app in
**Work → Activity → Apps**. Its stored name becomes the link label; it opens the same
workspace resource. Only apps in workspaces the viewer can access appear.
Omit the setting, set it false, or archive the app to remove the app link.

`tedix:app/outbound-review` lists outbound Work drafts with status and search
filters and the existing review, feedback and human approval/send controls.
Its `config` is `{"version": 1, "limit": 50}` with optional `projectId` and
`initialStatus` (for example `waiting_on_you`). Omitting `projectId` shows the
viewer's organization-wide list. Configuration never grants permission to
send; the existing API checks and version fences still apply.

## How apps appear in a workspace

Apps are what people open a workspace for, so the OS puts them first:

- **Resources** lists apps at the top under **Apps**, one card per app,
  side by side when there are several. **Skills and schedules** follows, then
  sheets and documents under **Files**. Nothing in a workspace is labelled
  "Automations".
- Each card shows a small preview of the app, its name, its purpose and a
  status line, with an **Open app** button. Card review previews the next
  open card. Other apps can show a saved screenshot from their manifest's
  `preview: {image, alt}`. Use a PNG, JPEG or WebP data URL of at most 100,000
  characters and describe the picture in `alt`. Review the screenshot with
  each app revision; it is visible to everyone who can read the app, so omit
  private viewer-specific information. The overview never runs the app to
  generate a preview. Apps without a preview use a compact card.
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

**Skills and schedules** lists the skills that run the workspace, such as
the factory that writes an app's cards. Each row shows the skill's name and
purpose, when it runs in the viewer's own clock ("Every day at 8:17, 13:17
and 18:17", "Paused", or "Runs when asked" for a skill with no schedule),
the tedi that runs it and whether it runs an automation, the last run ("Last
run 13:17: made 4 cards" or "Last run failed: <reason>"), the next run, a
**See runs** link and **Unlink**. A skill is listed when the workspace has
a resource with `providerId` `tedix`, `resourceType` `skill` and the skill
ID as `providerResourceId`. A link never changes the skill or its schedule.

Links are made in four ways, all idempotent:

- **Link skill** in the section: suggested skills first, linked in one
  step, then any organization skill by search.
- `link_os_workspace_skill` (`workspaceId`, `skillId`) and
  `unlink_os_workspace_skill`, for example from a workspace conversation.
- `record_skills` with `workspaceId` links the new skill. Without one, a
  skill recorded, or given a schedule, in a workspace conversation is
  linked to that workspace by the platform. `create_factory` with a
  Workspace links its lane skill.
- `link_os_workspace_factory_skills` (`workspaceId`, `dryRun`, default
  `true`) finds the lane skill of every factory project bound to the
  workspace (`metadata.factory.workspaceId`) or linked to it as a Work
  project, and every skill whose runs wrote the workspace's Outputs, and
  links the ones not linked yet. Repeating it reports `already_linked`.

Linking a skill also links the tedi that runs it (`tedix`/`tedi`) and each
app whose tools it declares (`tedix`/`connection`, by app slug).
**Tedis and connections** lists them below the skills, each with
**Unlink**; unlinking removes only the reference. Its `name` is the row title.
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

To offer **Re-score these cards**, add `replay` to a source's settings:

```json
{
	"skillId": "<scoring-skill-id>",
	"tediId": "<owner-tedi-uuid>",
	"columns": { "url": "Source", "title": "Title", "text": "Text" }
}
```

Open **Waiting → Inspect all cards → Re-score cards…**, choose a sheet,
and select up to 200 cards, including decided cards. **Select all cards in
this sheet** selects the loaded cards from that sheet. The console reads
the sheet again and starts the configured skill's active workflow with
`{mode: "replay", items: [{url, title, text}]}`. The URL column must contain
the same source link the card shows. **View run** opens its progress and
result; starting a run does not mean scoring has finished.

The console does not change verdicts, feedback or scores itself. Configure
only a replay workflow that updates existing cards by URL, changes their
scores and validation status, and preserves decisions and feedback. Check
that behavior in the workflow's tests before enabling this action. Running
it requires the same permission as **Run now** on a skill.

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
workspace under **Skills and schedules**.

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

## Decisions

While the app is open, `get_decision_deck_card` reads the displayed card,
options, answer field, consequences, reasoning, cited lessons, readiness and
the upcoming card ids. The other tools act on the card on screen through its
own controls, so the person watches each change:

| Tool                           | What it does                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `set_decision_deck_card`       | Shows a card the person named                                                    |
| `set_decision_card_answer`     | Fills the answer or draft; nothing is saved                                      |
| `set_decision_card_option`     | Selects an option for the person to review; nothing is saved                     |
| `set_decision_card_later`      | Puts the card aside, like **Later**                                              |
| `set_decision_card_not_useful` | Marks the card not useful with a reason; Decisions shows **Undo**                |
| `respond_decision_card`        | Submits the selected option; needs `confirmedByUser: true` and keeps the dialogs |

Every action names the card id and fails for any card other than the one on
screen. `respond_decision_card` submits only an option already selected with
`set_decision_card_option`, and only when the person explicitly asked in chat
to submit it. Cards that ask for confirmation still open the dialog for the
person.

The OS quick chat can use the same tools for the person, with Home or a
directly chosen tedi. When Decisions is on screen the chat's status reads
**Can act on this page**; elsewhere it reads **Can see this page**. The chat
sends the tool descriptions with each turn, and the model's calls come back
to the page, which runs them: the server never does. Each action shows a
short line in the chat, with **Undo** for a filled answer or a selected
option. Before `respond_decision_card` runs, the chat shows **Submit** and
**Don't submit**, and nothing is submitted until the person taps **Submit**.

`tedix:app/decision-deck` uses the same workspace renderer. Its manifest
settings are `version: 1`, optional `projectId`, `limit` (default 50),
`unchangedThreshold` (5), `dailyAttentionBudget` (10) and `auditSampleRate`
(0.1). `defaultLowStakesToDelegate` (true) makes **Decide for me** the primary
response for reversible taste choices with no protected effects. Optional
`examples` hold up to twelve fictional decision envelopes
for the separate **Try examples** preview. Practice choices stay in the
preview and never train the person's profile or approve real work.

Decisions reads the viewer's existing Interaction inbox and approvals.
Existing outbound cards retain their reviewed-version and consent checks.
Architecture and strategy requests can supply `metadata.decisionDeck`:
proposal, why now, recommendation, reversibility, protected effects, blast
radius, confidence, cost of waiting, reasoning, cited lessons and 2–4
options with consequences and costs. The versioned schema is
`packages/api-contract/src/schemas/os-decision-deck.ts`.

An option can carry a typed `effect`: `accept_work`, `complete_work`,
`record_adr`, `record_review`, `file_request`, `publish_docs` or
`publish_support`. These reuse the original product's permissions. A card
can show the exact draft in `preview.body`; a Support draft pins the ticket
version, a document review pins its revision, and a filing correction pins
its previous destination. The server saves an action claim before starting.
An unconfirmed result leaves the request open and blocks another execution;
check the saved receipt and target before preparing a new decision.

New Support drafts create Outbound cards for the configured human admin.
Automatic filing creates reviews only for uncertain matches. The owner's
`decision-filing-reviews` setting in the organization's user-config namespace
controls `enabled` (true), `confidenceBelow` (0.8), and `limit` (10).
Choosing **No, refile it** returns the request to Unfiled and records the
correction for the existing learning process. Decisions retain the proposal,
project, timing, waiting cost and outcome with the person's feedback;
explicit feedback can teach immediately, while an isolated approval remains
an observation rather than a general rule.

Open Decisions to finish a short batch of decisions, then get back to your day.
Set `navigation.work` to `"deck"` on the installed Decisions app and to `"feed"`
on the Activity app. Work opens Activity on phone and desktop; **Decide** opens
Decisions. Both use the generic workspace app renderer and the
viewer's existing access.

The batch has a fixed list: new arrivals wait for the next batch instead
of extending it. `batchTimesUtc` defaults to `["09:00", "16:00"]`; the
completion message displays the next time in the viewer's timezone.
`dailyAttentionBudget` caps each person's remaining batch. Set
`gamification: false` to hide the streak and daily goal; `dailyGoal`
defaults to 7. The current browser tab remembers deferred cards for that
batch. These attention controls do not replace server permissions.

Swipe or use the visible buttons. Desktop shortcuts are Left for Not this,
Right or Enter for Approve, E for Change, L for Later, D for Decide for me,
J and K for the next and previous card, and ? for the shortcut list, when
that action is available. Typing in a field never triggers these shortcuts.
Right always means Approve, even when Decide for me is the primary button.
Consequential choices retain their confirmation.

Each card names what it asks of you: **Send**, **Decide**, **Approve draft**,
**Answer** or **Consent**, with its deadline. Overdue cards come first, longest
overdue at the top. The Kind filter selects one of these, or **Drafted, not
sent** for ready message drafts older than the Decisions' `staleDraftHours`
(default 24). Every card face says why now and, when its source states them,
what waiting costs and what yes costs. A face that drops one is rewritten once
from the source facts; otherwise no summary face is saved for it.

The card keeps one action row. **Later**, **Why this** and **Not useful** sit
in it in the same quiet style; **Not useful** asks for a short reason, such as
already decided, duplicate or "agent could do this", removes the card and
teaches Decisions; **Undo** puts it back. A tedi's runtime
approval also offers **Always allow this**: after a confirmation it allows that
action type for every tedi in the organization, and you can turn the rule off
in Approvals.

On a phone Decisions keeps its size when the keyboard opens, and Activity and
Decisions bar stays at the bottom of the screen. On a short screen Decisions takes
its natural height and the page scrolls, so the card's actions stay visible.

Readiness counts distinct recorded human decisions for this person and
class. In the person's organization-scoped reply policy,
`classPolicies.<class>.autoApprove` enables earned delivery for reversible
classes without protected effects or strategy decisions. The class's
`unchangedThreshold` defaults to 5 and `auditSampleRate` to 0.1. A rejection
or correction resets the count. Audit samples return to review. Existing
`autoSend` permission, session limits and independent delivery checks still
apply; the immutable reply draft remains the receipt. This does not enable
automatic approval of money, messages, production or consent.

The Decisions' `classPolicies` settings control its readiness display; changing
that display alone cannot enable delivery. The weekly learning digest in
Office and decision history links back to the choices. Agents and Office
show time to decide, Decide-for-me rate, cards today, return visits today and
correction rate from recent personal activity. Loaded history is bounded
and is labeled as such. Cost of waiting comes from the decision's source;
expiry uses the request's deadline, or its decision envelope's `expiresAt`.
The live "nobody is carrying this" signal requires a current Work read:
no accountable owner and no holding Attempt. A failed, pending or older
read does not imply missing ownership. This is separate from whether a
person is online.

From chat, discover the Interaction inbox/detail tools and read the exact
request and version. Explain the offered responses and consequences; do
not answer or approve a human's card. A saved response proves the choice
was recorded. Follow the originating Work and provider receipt to check
execution. History is read-only in Decisions. **Why this?** shows reasoning
and cited lessons; the account profile remains the style-profile surface.

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
| `revise_review_card_draft`  | Asks the factory to rewrite the open card's draft in the person's words, like **Ask for changes**; each round is a new version, no verdict is written |
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
   plain description and an input schema, and set `readOnlyHint` on reads,
   `untrustedContentHint` on reads that return tenant content, and
   `consequentialHint` on writes that are significant or hard to undo, so
   the browser confirms every call.
2. In the app component, pass that state and the same callbacks the buttons
   use to `useAppWebMcpTools("<app-id>", controller, build, deps)`
   (`apps/os/src/lib/webmcp/use-app-webmcp-tools.ts`). `deps` lists only
   what changes the tool shape, such as a filter enum.
3. Return each callback's outcome so a tool can report a failed write as an
   error; `execute` never throws. The registry turns an error result into the
   rejection the WebMCP spec expects.
4. Test it by rendering the app with a mocked `osApi`, executing each tool
   and checking the screen and the written cells.

`window.__tedixWebMcp.status()` in the page lists the registered tools and
whether the browser offers a WebMCP host.

## Activity

`tedix:app/activity-feed` reads Work changes, settled lane and tedi results,
the viewer's decisions and approvals, and personal corrections. Configure
`version: 1` and `projects: [{id, label}]`. Optional `factorySources` reuse
Card review sources as `{projectId, source}` to read existing factory sheets.
They read the latest configured runs, with their output revision and row as
evidence. Activity never runs a sheet's action.

`pageSize`, `attentionBudget`, `digestBelow`, `quietHours` (start/end hours in
the viewer's timezone), `weights` and `deckUrl` control presentation. Work,
result and inbox readers have independent cursors; personal ranking applies
to loaded records. Low-importance updates form an expandable digest. Pending
decisions and critical events remain visible during quiet hours.

On desktop each row shows **Receipt** and **Comment**; other actions are in
its menu. Long previews wrap rather than being cut off. Keyboard shortcuts act
only while Activity or one of its rows has focus, and open or react only on
the focused row, so typing elsewhere never triggers them.

Reactions record personal learning events. With decision learning enabled,
More like this and Not for me adjust the next ranking from those events;
otherwise they save personal preferences in the existing OS preference store.
Comment records a correction for the existing reflection process. Turn into
Work creates proposed Work with its source link. Activity does not approve
decisions, send messages or change admission. Its WebMCP tools read visible
cards and use the same personal reaction callbacks.

### Learn from decisions

An administrator can enable `decisionLearning` in organization settings with
`configure_decision_learning`. Decisions and Activity then use the same learning score.
A person's choices stay personal; shared signals and approved lessons provide
team context. Deadlines and waiting costs change the score as time passes.
Repeated deferrals and negative reactions reduce a class, source or proposer's
weight; quick responses raise the weight of a project.

Open **Why this?** to see the signals and applicable lessons behind the rank.
After a decision, the learning line says what changed. **Undo learning** records
a correction and recalculates the model; reversing the original action uses
that action's own controls.

`unchangedThreshold` defaults to five; `autoApproveClasses` explicitly selects
eligible reply classes. A rejection resets the counter. `auditSampleRate`
keeps a stable sample for review. Automatic replies still require the existing
reply policy, reversibility checks, delivery checks and session budget. A
learned preference never grants permission to send an email or perform another
protected action. The stored reply receipt names the supporting signals.

`halfLifeDays`, `fastDecisionMs`, `minimumPreferenceExamples`, `shorteningRatio`,
`deadlineWindowHours`, `timezone`, `quietHours` and `weights` tune the model.
`classifyEdits`, `classifierConfidence`, `classifierTimeoutMs` and
`preferenceModel` control bounded edit interpretation. A failed classifier
leaves the measured edit intact. Outbound review, reply drafting and Home
writing read learned preferences before generating text. The Outbound style
profile includes the learned writing preferences.

## An app with its own code

Use the plugin's `tedix-build-app` skill for an app rendered by the generic
runtime renderer. Start from your organization's own app guide and published
blueprints when it has them: language, wording, colours and review steps are
the organization's choice and live in its skills and app settings, not in
Tedix. Otherwise copy the generic sheet-backed review starter from
`plugins/tedix/skills/tedix-build-app/assets/sheet-review/` in the source
repository. It includes tabs, ratings, reload, reset and a README for the next
editor. It reads the source sheet and stores shared ratings in app-local KV;
it does not write verdicts back to the sheet or execute card instructions.

### Files and manifest

Set `entry: "tedix:runtime/v1"`. `revise_os_gadget` takes `files` separately
from `manifest`; `get_os_gadget_code` reads them back for the current or a named
revision. `server.js` and `client.js` are required. Up to 24 files may contain
512,000 UTF-16 code units in total. Other names are lowercase, single-segment
`.js`, `.json` or `.txt`, plus the exact optional `README.md`. The README travels
with the revision and is editable in Code view; it counts toward limits and
the code digest but is excluded from Worker Loader modules. Without an authored
README, Code view shows the existing manifest-generated guide.

Before saving, Tedix
parses every `.js` file and dry-loads the exported `App` class in an isolate
without app storage or network access. A syntax error refuses the write with
`file:line:column`; a missing import or invalid `App` export also refuses it.
The constructor and app methods are not run during this check.

For a reviewed edit over MCP, discover these tools in your organization's
namespace:

1. Read the current app and its files, then call `propose_os_app_edit` with
   `workspaceId`, `gadgetId`, `expectedRevisionId` and exact `edits`
   (`path`, `before`, `after`). Each replacement must match once. An agent
   needs an attested session or automation run and app write access; browser
   builders also supply their workspace Home `conversationId`.
2. Open the returned `previewUrl` to review the proposal in **Drafts**, or
   call `preview_os_app_draft` with its `proposalId` to get an isolated app
   session. The proposal's files stay separate from the published revision.
3. Call `accept_os_app_edit` with the app scope, `proposalId`, its reviewed
   `expectedSequence` and a `rationale`. This accepts and merges the draft;
   a changed sequence or app revision requires another review.
4. Use `list_os_app_revisions` to choose an earlier version, then
   `restore_os_app_revision` with its `revisionId` and the current
   `expectedRevisionId`. Restore validates the old files and appends a new
   revision, preserving history.

The manifest keeps what the app may touch, never the code:

```json
{
	"entry": "tedix:runtime/v1",
	"capabilities": [],
	"resourceGrants": [{ "slot": "cards", "operations": ["outputs.read"] }],
	"config": { "version": 1, "settings": { "slot": "cards" } }
}
```

Bind the slot to an active resource in the same workspace with `providerId`
`tedix`, `resourceType` `output` and the verified Output ID as
`providerResourceId`. Keep sheet selection, column names and other tenant
choices in resource bindings or `config.settings`, never in source code.

### Browser and server contract

`client.js` renders into `#app` in an isolated sandbox without network, host
DOM, credentials or inherited theme tokens. It is an inline browser module;
extra files do not become browser imports. Its bridge has three methods:

```js
const { workspaceId, gadget, role, settings, grants } =
	await tedix.call("context");
const content = await tedix.call("outputs.read", { slot: settings.slot });
const result = await tedix.call("app.call", {
	method: "rate",
	args: ["card-1", "useful"],
});
```

`gadget` contains `{id, name, revision}`. `outputs.read` returns the Output
content body directly. Calls resolve values and reject errors with `code` and
`detail`; there is no `{ok, value}` wrapper to unwrap in app code.

Export `class App` from `server.js`. An invocation creates a new instance with
`(ctx, env)` and calls an own public method on `App.prototype`. Use synchronous
`ctx.storage.kv.get/put/delete/list` for durable state, rather than instance
fields or module globals. Storage belongs to the app and is shared by callers;
preview storage is separate. `env.CONFIG` is the full manifest config.
`env.TEDIX` is a capability scoped to the caller, revision and current call:

```js
export class App {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
	async source() {
		const { revision } = await this.env.TEDIX.outputsRead(
			this.env.CONFIG.settings.slot,
			{},
		);
		return revision.content;
	}
	rate(id, verdict) {
		if (typeof id !== "string" || !["useful", "not_useful"].includes(verdict))
			throw new Error("Ungültige Bewertung.");
		this.ctx.storage.kv.put(`review:${id}`, verdict);
		return { id, verdict };
	}
}
```

Unlike the browser read, `env.TEDIX.outputsRead(slot, {})` returns
`{output, revision}` with content under `revision.content`. Build callers also
have `outputsPatch`, `outputsWrite(slot, {content, expectedRevision})`,
`connectionsCall` and `skillsRun` where authorized. Discover their current
argument schemas before adding effects.

To change part of an Output, grant `outputs.patch` rather than
`outputs.write`. A patch edits in place, so anything the app does not show
(other blocks, slides, rows or columns) stays as it was:

```js
await this.env.TEDIX.outputsPatch(slot, {
	kind: "sheet", // or "document" / "presentation" with `ops`
	startRow: 3,
	startColumn: 5,
	cells: [["yes"]],
	expectedRevision: revision.revision,
});
```

Document and presentation patches take the same `ops` as
`patch_os_document` and `patch_os_slides`; a sheet patch takes the same
rectangle as `set_os_sheet_range`. `expectedRevision` is required: an edit
based on an older read fails with `CONFLICT`, so read again and retry. Keep
`outputs.write`, which replaces the whole body, for apps that own all of the
Output's content. Connection calls support reviewed resource-bound reads;
provider permission and approval rules still apply. No network or ambient
Cloudflare bindings are inherited. Do not retain a capability after its call.

### Run app methods on a schedule, webhook or skill result

An app method can also run without anyone clicking. List the triggers in
the manifest's `config.triggers`; each one names an `id`, the `method` to
call and optional leading `args`:

```json
"triggers": [
	{ "id": "morning", "kind": "schedule", "cron": "0 7 * * 1-5", "method": "sweep" },
	{ "id": "inbound", "kind": "webhook", "method": "receive" },
	{ "id": "scouted", "kind": "skill", "slot": "scout", "method": "review" }
]
```

- `schedule` runs at each time of a five-field UTC cron. Times are checked
  every two minutes, so a cron that fires more often runs at most once per
  check.
- `webhook` runs when someone posts to the trigger's address. A builder gets
  the address and signing secret from `osAppRuntime.triggerWebhook` with the
  app scope and `triggerId`. The sender signs `<timestamp>.<raw JSON body>`
  with the secret (HMAC-SHA256, hex) and sends `X-Tedix-Timestamp` (Unix
  seconds) and `X-Tedix-Signature: sha256=<hex>`. Deliveries more than five
  minutes old, unsigned or wrongly signed get `401`. Renaming the trigger
  changes its secret.
- `skill` runs when the skill bound to the workspace slot finishes a run.
  It runs once for the newest finished run at each two-minute check.

The method receives the trigger's `args`, then one event object:
`{trigger, kind, firedAt}` plus `body` for a webhook and `run` (`id`,
`status`, `cards`, `summary`, `error`) for a skill. Each event runs once.
Every run appears in the app's Runs, as an app call made by
`app-trigger:<id>`.

A trigger acts for the person who saved the current app revision, with the
app's `resourceGrants` and no more than that person may do today. If they
leave the organization, the app's own code still runs but every resource
call is refused until someone saves the app again.

### Read workflow results

Bind a workspace slot to a Tedix `skill` resource and grant that slot
`skills.read`. Server code can then read that skill's saved runs and evidence:

```js
const run = await this.env.TEDIX.skillsRead("research", {
	view: "run",
	runId,
});
const output = await this.env.TEDIX.skillsRead("research", {
	view: "artifact",
	runId,
	path: "outputs/read.json",
});
```

The other views are `artifacts` (metadata, with `limit` up to 200 and
`offset`) and `timeline`. Artifact bodies must be under `outputs/` and no
larger than 256 KiB. Run reads return status, dates, execution epoch and
result, without workflow source or input parameters. Reads check the current
organization, skill, member permissions and recorded source access; retired
or revoked runs are unavailable. They never start or retry research.

An app can build a compact report from these records and cache it in app
storage. Recheck the run's access before serving cached evidence. A finished
skill trigger can pass a run ID to a refresh method; read the saved run
rather than trusting report content supplied by a caller.

### Roles, errors and limits

| Role             | Allowed runtime operations                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `owner`, `build` | `app.call`, `outputs.read`, `outputs.patch`, `outputs.write`, `connections.call`, `skills.read`, `skills.run` |
| `use`            | `app.call`, `outputs.read`, `skills.read`                                                                     |
| `viewer`         | None                                                                                                          |

`context` exposes presentation context. Every resource operation also requires
a matching slot and operation in `resourceGrants`, plus current source access.
A `use` reviewer may save app-local KV through `app.call`; this does not grant
Output writes. Validate method arguments on the server. All callers with app
interaction access can invoke public methods; hiding a button is not access
control. Do not put protected decisions behind an unrestricted app method.

A "Can use" link lets people without a Tedix account open the app. That
normally requires every slot in `resourceGrants` to be bound to an Output
with no data from connected accounts. Grants for `connections.call`,
`skills.read` and `skills.run` otherwise require sign-in.

An organization owner or admin can approve an app's existing `skills.read`
slot for one "Anyone with the link" use link by calling `osShares.shares.update`
with `guestSkillReadSlots: ["research"]`. This uses the approving person's
current access to read the bound skill's evidence. It grants no other slot,
operation, app or link. The approval is pinned to the app revision and resource
binding; changing either requires approval again. The approver must remain an
active owner or admin, and source access is checked on every read. An empty
`guestSkillReadSlots` list withdraws these approvals. App code stays unchanged.

Calls accept at most 50 JSON arguments and 65,536 encoded bytes. Method names
start with a letter, contain only letters and digits, and have at most 80
characters; constructor and lifecycle methods are private. Sessions pin access,
revision and code digest. Reopen after a revision or access change.

| Bridge error code  | What to check                                                  |
| ------------------ | -------------------------------------------------------------- |
| `not_permitted`    | Caller role and slot operation grant                           |
| `slot_unbound`     | Active workspace resource binding                              |
| `bad_arguments`    | Method name, slot and JSON argument limits                     |
| `unknown_method`   | Only `context`, `outputs.read`, `app.call` are browser methods |
| `host_unavailable` | Server call bridge is unavailable                              |
| `host_error`       | Server, capability or transport failure; inspect Runs          |

Direct API calls may return `BAD_REQUEST`, `FORBIDDEN`, `NOT_FOUND` or
`CONFLICT`. Re-read on conflict; never replay a stale write blindly. Show
failed loads and writes visibly, retain user input and offer a manual retry.
A failed load must not look like a successfully empty sheet.

### Draft and review flow

For a requested new installation, create the gadget record and its initial
runtime revision with `expectedRevision: 0`. For an existing app, read the
current revision and files first. Discover the equivalents of
`osAppRuntime.saveDraft` with `expectedRevisionId` and content `{manifest, files}`,
then `osAppRuntime.draft` with the returned `proposalId` to open an isolated
preview. Code edits save proposals, not committed revisions. `mergeDraft`
compares a proposal with its base and the latest app revision; resolve conflicts
against current files and preserve concurrent edits. Leave the draft for the
person to apply in the OS. Do not apply, publish or create share links in the
authoring steps. Preview capabilities allow resource reads only; preview
ratings are separate from the committed app's storage and are not migrated.

Before handing off, check:

- Own light-theme colour tokens on `:root`, including background, surface,
  foreground, muted, border, accent and on-accent, and `color-scheme: light`.
  The host frame supplies no app theme tokens.
- Write plain copy in the language your organization uses and keep every
  visible word in the app settings. Use visible keyboard focus, labelled
  controls and touch targets of at least 44 × 44 CSS pixels.
- Test at 375px phone width and desktop, with long text, loading, empty and
  error states. Exercise tabs, rating, reload and reset confirmation.
- Include the app's README with bindings, column mapping, shared or personal
  storage semantics and checks. Read back the draft and record its OS link
  and evidence on Work. Distinguish simulated checks from live runtime proof.
- Never publish while authoring.

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

## Work: Activity and Decisions

Work opens the installed Activity app unless a Work app declares
`navigation.workDefault: true`. **Decide** opens the installed Decisions and
shows its current personal inbox count, including Work and runtime approvals.
A `+` means another page may contain more choices. The phone bar has only
**Activity** and **Decisions**; there is no Work tab bar or More menu.

Set `navigation: {"work": "feed"}` or `{"work": "deck"}` on the corresponding
app manifest to choose its Work role. Existing Activity and Decisions apps opted into
`navigation.board` also work. Discovery uses the viewer's accessible workspaces;
installing an app never grants access. If several apps declare the same role,
explicit role links select the oldest active app, with its id breaking
creation-time ties.
Other apps opted into `navigation.board` appear under **Apps** in Activity.

To start in Decisions, set `navigation: {"work": "deck", "workDefault": true}` on its
installed manifest. An explicit `view` or `app` in the URL still wins. If several
accessible Work apps declare the default, the same oldest-app order breaks ties.
An app without a Work role cannot become the Work start app.

Activity header summarizes choices due today, sessions currently reporting
work in its projects, and the earliest known unresolved deadline. This is
reported activity, not human online presence. Counts and deadlines describe
loaded records; unread sources stay visibly unavailable.

| Old collection URL                                                     | Destination                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| `/work/attention`                                                      | `/work?view=feed&filter=attention` — Needs action |
| `/work/needs-you`                                                      | `/work?view=deck`                                 |
| `/work/queue`                                                          | `/work?view=feed&filter=queue` — In progress      |
| `/work/queue?disposition=completed`, `/work/attempts`, `/work/history` | `/work?view=feed&filter=history` — Done           |
| `/work/recovery`, `/work/stalled`                                      | `/work?view=feed&filter=stalled`                  |
| `/work/portfolio`                                                      | `/work?app=portfolio` — installed Portfolio app   |
| `/work/agents`, `/work/office`, `/work/outbound`                       | The matching installed app                        |

Work item, project, request, run and receipt links remain direct. Office keeps
the personal request ledger and Support section. The existing Attention app
can use `config: {"scope": "personal"}` to show personal session activity and
request filing controls; omission keeps it scoped to its containing workspace.
