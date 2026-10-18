# Put today's work in one place

Open Feed to read the saved Today post, or ask “what's moving today” from an
assistant. Both read the same document. Press `t` in Feed or Deck to open Today.

Install `SKILL.md` and `workflow.js` under an existing project lead, using the
same native schedule mechanism as `night-shift-coordinator`. Create one
organization document for the saved edition. Set `outputId`, `personId` and
`timeZone` in the skill's schedule parameters. Enable the schedule in your
organization, keeping the example disabled. The default editions are 06:45,
then every two hours through 20:45 in that time zone.

Add the document, skill and owning tedi to the installed Feed's `config.today`:

```json
{
	"outputId": "00000000-0000-4000-8000-000000000001",
	"skillId": "00000000-0000-4000-8000-000000000002",
	"tediId": "00000000-0000-4000-8000-000000000003",
	"personId": "example-person",
	"timeZone": "Europe/Berlin"
}
```

Install `read/SKILL.md` as an organization-readable skill with no tedi owner.
It finds the configured document through `list_work_apps`, then reads it with
`get_os_output`. The refresh skill is owned by its scheduled tedi; the reading
skill has no schedule and never writes. No live installation identifiers belong
in these files.

Refresh runs the configured skill with `manual: true` and the same document,
person and time zone. It requests a run; the post changes only after the saved
revision advances. Pages never assemble project summaries on load.

`get_today_project_totals` reads counts for the configured person and document
receipts from organization workspaces linked to the project. It returns no
private question text. Permission to read does not authorize answering any
Deck card or changing the purpose. The workflow preserves the previous edition
on unavailable or incomplete sources and uses the document's revision fence.

Run `bun test examples/today-digest/workflow.test.js` for edition and receipt
checks. These tests do not prove a live schedule fired or a release went live.
