---
name: incident-hygiene
description: Close recovered engineering incidents and abandoned automatic stubs with evidence.
audience: [tedi]
capabilities:
  network: false
  mcp:
    tedi:
      [
        work_items_list,
        work_item_get,
        list_work_attempts,
        cancel_work_item,
        work_item_comment,
        list_skill_workflow_history,
      ]
    github: [list_actions_resources]
    home: [read_home_run]
  schedule:
    cron: "17 * * * *"
    enabled: false
    params:
      internalProjectIds: []
      includeUnprojected: false
      dryRun: true
      incidentHours: 24
      idleHours: 72
      humanHours: 48
      rules:
        - { kind: ship, pattern: "^Investigate ship deploy:.* failure" }
        - { kind: ship, pattern: "^Red Ship all" }
        - { kind: ship, pattern: "^Commit watch" }
        - { kind: skill, pattern: "^Factory incident" }
        - { kind: skill, pattern: "^Skill run failed" }
        - {
            kind: stub,
            pattern: "(?:^|\\n)(?:Filed automatically|Diagnose the run failure)",
          }
        - { kind: home, pattern: ".*" }
---

# Incident hygiene

Install `workflow.js` as `scripts/workflow.ts` under the existing engineering
lead. Configure `osOrigin`, an explicit `internalProjectIds` allowlist and,
optionally, `includeUnprojected` for organization incidents without a project.
All other projects, including customer projects, stay outside the write scope.
Never add customer projects to the allowlist. Schedule params are persisted in
D1 by the native skill scheduler; no installation coordinates belong in source.

Configure `ship` with `owner`, `repo`, `workflow`, `branch` and `successTitle`
(the exact title `Ship latest main`). Optional `healthWorkItemId` receives the
run receipt. The example schedule is disabled and defaults to `dryRun: true`.

Ask in workspace chat: “Run incident hygiene in dry-run mode and show which
Work would close and why.” Run this skill with the stored params and
`dryRun: true`; the result lists each candidate, rule, reason and evidence URL.
Set `dryRun: false` only within the authorized internal project boundary.

Incidents must be older than 24 hours, including their latest failure or
update, and cite a later successful Ship or run of the same skill and owner.
Auto-filed stubs and verified failed `answer_in_home` questions must be idle
for 72 hours with no Attempt history. A question mark alone never qualifies.
Live Attempts, human comments in the last 48 hours, unknown timestamps and
incomplete ledgers preserve the item. Threshold params can only increase these
minimums. Failed or malformed reads stop execution.

Closures use cancellation with a reason and evidence URL, preserving history;
they do not claim the original requested outcome was delivered. Each write is
preceded by fresh detail and Attempt reads and followed by disposition readback.
The cancellation endpoint's `hygiene` guard atomically fences the Work version,
recent human comments and, for idle cleanup, all Attempt history. Install only
after that contract is deployed and visible in the cancellation tool schema.
Dry runs make no Work writes or run-history reconciliation calls.
