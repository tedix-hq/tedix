---
name: today-digest
description: What's moving today? Read the saved Today post for purpose, goals, progress, running work and needs you; refresh it on request.
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
        list_projects,
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
`manifest.config.today.outputId` with `get_os_output`. This is the same source
shown at the top of Feed. Do not rebuild a summary from unrelated live reads.

Answer in plain English: purpose, each project's goal and progress, who's
working now and how many choices need the person. Include the edition time
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

Totals contain no private question text. Documents count only organization
workspaces linked to each project; the saved Today Output excludes itself.
Only active projects touched in the last seven days appear. Finished work,
recorded commits and live releases are distinct: a commit is never described
as shipped without a release receipt. Each source is paged; an unreadable or
truncated source preserves the previous edition. Writes use a revision fence.
