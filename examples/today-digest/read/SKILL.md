---
name: whats-moving-today
description: What's moving today? Show today's purpose, project goals, progress, running work and choices that need you from the saved Feed post.
audience: [human, tedi]
capabilities:
  network: false
  mcp:
    tedix: [list_work_apps, get_os_output]
---

# What's moving today

Discover `list_work_apps` and read the installed Feed app, identified by
`tedix:app/activity-feed` or its Feed navigation role. Read
`currentRevision.manifest.config.today.outputId` using `get_os_output`.

Answer from that saved document: purpose, project goals and progress, who is
working now, the number of choices that need the person, and the quiet-project
line. Include its edition time and retain the saved project, receipts and Deck
links. Keep identifiers out of the answer. This is the same edition shown in
Feed; do not silently combine it with newer live reads or call a recorded
commit a live release. If the edition is from an earlier day, say so.

If Today is not configured or the document cannot be read, say that plainly.
A refresh requires an explicit request; it is not part of this read-only skill.
