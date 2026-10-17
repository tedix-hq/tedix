# Daily Work consolidation

Install `workflow.js` as `scripts/workflow.ts` on an existing scheduled Work
Factory skill. Keep the factory's owner, daily cron and Output binding. Declare
`tedi` tools `work_items_list`, `work_item_get`, `list_work_attempts`,
`cancel_work_item`, `work_item_comment`; `work.list_relations`; and OS tools
`get_os_output`, `patch_os_document` in its capability manifest.

Schedule parameters are `projectIds`, `staleDays`, `outputId` and
`healthWorkItemId`, with optional `similarityThreshold` (default 0.75).
`readOnlyProjectIds` keeps selected customer projects report-only.
`probe: true` reads without writing. The project list is an explicit boundary;
include only the projects the factory is authorized to maintain.

Portfolios above five projects share one paginated organization scan and filter
the results to the configured projects. Smaller factories query each project.
The scan stops before writes above 1,000 records; use factories scoped to at
most five projects when the organization exceeds that limit.

The workflow proposes consolidations in one paragraph, using title and
body similarity and shared links. It names the richer item and requires both
checklists and acceptance criteria to survive a merge. It creates no decision
cards. Only empty, unowned stubs older than `staleDays`, with no acceptance
criteria, Attempts, comments, evidence or dependency edges, are cancelled.
Unknown timestamps or incomplete dependency scans preserve the item. Work
cancellation preserves history and rejects a concurrently active Attempt.

Disposable agent cleanup approvals use action `work_item.cleanup` and payload
`{ operation: "cancel", workItemId }`. Automatic approval requires low-risk Work
marked `metadata.disposable: true`, a source agent session, ownership by the
requesting tedi and no live Attempt. The resolved approval and tedi audit are
written together, so the request never enters the human pending list.
