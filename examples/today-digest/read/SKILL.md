---
name: whats-moving-today
description: What's moving today? Read saved project progress, the current purpose and your live Deck count.
audience: [human, tedi]
capabilities:
  network: false
  mcp:
    tedix:
      [
        list_work_apps,
        get_os_output,
        get_active_purpose_charter,
        list_deck_cards,
      ]
---

# What's moving today

Discover `list_work_apps` and read the installed Feed app, identified by
`tedix:app/activity-feed` or its Feed navigation role. Read
`currentRevision.manifest.config.today.outputId` using `get_os_output`.

Answer from that saved document: project goals and progress, who was working
at the edition time, and the quiet-project line. Read
`get_active_purpose_charter` for current purpose and `list_deck_cards` for the
caller's current Deck. Omit the time-zone override to use the caller's saved
OS preference, and select the Deck app when several are installed. Show a
needs-you count only when that projection is complete; otherwise link Open
Deck without a number. The saved attention column is not a current count.
If the charter cannot be read, omit purpose rather than repeat saved wording.

Include the edition time and distinguish saved project progress from current
purpose and attention. Retain the saved project, receipts and Deck links.
Keep project labels to three words and identifiers out of the answer; the
receipt table's IDs are machine references, not display text. Do not call a
recorded commit a live release. If the edition is from an earlier day, say so.

If Today is not configured or the document cannot be read, say that plainly.
A refresh requires an explicit request; it is not part of this read-only skill.
