---
name: today-digest
description: What's moving today? Read saved project progress alongside the current purpose and Deck count; refresh the project post on request.
audience: [tedi, human]
capabilities:
  schedule:
    cron: "*/15 * * * *"
    enabled: false
    params: {}
  network: false
  mcp:
    tedix:
      [
        get_active_purpose_charter,
        list_work_apps,
        list_deck_cards,
        list_projects,
        list_tedis,
        list_activity,
        list_attempt_projection,
        get_today_project_totals,
        get_os_output,
        revise_os_output,
      ]
---

# Today

When asked "what's moving today", "what are we working towards", or "show
Today's progress", read the saved Today Output. Discover `list_work_apps`,
find the installed Feed (`tedix:app/activity-feed`), then read its
`manifest.config.today.outputId` with `get_os_output`. This supplies the saved
project progress shown at the top of Feed. Read `get_active_purpose_charter`
for current purpose and `list_deck_cards` for the caller's current Deck.
Omit the time-zone override to use the caller's saved OS preference; the
edition's time zone controls project receipts. Select the Deck app when
several are installed. Do not rebuild progress from unrelated live reads.

Answer in plain English: purpose, each project's goal and progress, who's
working now. Give a current needs-you count only when the caller's Deck
projection is complete; otherwise link Open Deck without a count. Never use
the saved table's attention column as current. Include the edition time
and quiet-project line. Keep identifiers out of the answer. Link project
names and receipts using the saved table links. If the edition is from an
earlier day, say so. If no Today configuration exists, say it is not set up.

A requested Refresh runs this workflow with `manual: true` and the configured
schedule parameters. Read the Output's new revision before saying it updated.
A queued run is only a request. Never revise the purpose charter.

Install under an existing project lead using the native scheduled-skill path,
as with night-shift-coordinator. Configure `outputId`, `personId`, `timeZone`
and optional local `times` and `executorNames`. The disabled example carries
no organization coordinates. Enable the schedule only in organization data.
The default edition times are 06:45, then every two hours through 20:45 in
the configured time zone. A 15-minute UTC tick checks the local slot, so
seasonal clock changes preserve the morning time.

The scheduled workflow requests `includeDeckCount: false` and leaves its
saved attention column blank. It does not read another person's Deck.
Totals contain no private question text. Documents count only organization
workspaces linked to each project; the saved Today Output excludes itself.
Only active projects touched in the last seven days appear. Finished work,
recorded commits and live releases are distinct: a commit is never described
as shipped without a release receipt. Each source is paged; an unreadable or
truncated source preserves the previous edition. Writes use a revision fence.
